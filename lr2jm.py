#!/usr/bin/env python3
"""
lr2jm.py — Convert LoadRunner scripts to JMeter .jmx test plans.

Ported from lr2jm.pl (Perl) to Python.

Usage:
    python lr2jm.py <LoadRunner Script Directory>

Changelog (Perl original):
    0.3.1 - Bug fixes, web_custom_request(), XML::Tidy formatting
    0.3.0 - Parameter data files, web_reg_save_param
    0.2.1 - web_submit_data(), script saved in LR folder
    0.1.2 - Fixed typos with spaces in XML attributes
    0.1.1 - Initial release
"""

import os
import re
import sys
import argparse
import xml.etree.ElementTree as ET
from pathlib import Path

from utils.display import print_message

# ---------------------------------------------------------------------------
# Global state (mirrors Perl globals)
# ---------------------------------------------------------------------------
webrequests = []        # list of request dicts
tables = {}             # table_name -> [csv_filename, col1, col2, ...]
paramsubs = {}          # param_name -> resolved column name
dynamic_params = {}     # param_name -> regex (consumed by next HTTP request)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def add_prop(parent, tag, name, text=None):
    """Create a property sub-element with a name attribute and optional text."""
    elem = ET.SubElement(parent, tag)
    elem.set('name', name)
    if text is not None:
        elem.text = str(text)
    return elem


def param_substitution(input_string):
    """Replace LoadRunner {param} references with JMeter ${column} syntax."""
    for param, sub in paramsubs.items():
        input_string = input_string.replace('{' + param + '}', '${' + sub + '}')
    return input_string


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def read_arguments():
    """Parse and validate command-line arguments. Returns the script directory path."""
    parser = argparse.ArgumentParser(
        description='Convert LoadRunner scripts to JMeter .jmx test plans'
    )
    parser.add_argument(
        'script_dir',
        help='Path to the LoadRunner script directory'
    )
    args = parser.parse_args()

    if not os.path.isdir(args.script_dir):
        print_message(f"{args.script_dir}: not a valid directory", message_color="red")
        sys.exit(1)

    return args.script_dir


# ---------------------------------------------------------------------------
# .prm parameter file parsing
# ---------------------------------------------------------------------------

def get_parameters_from_lr(script_dir):
    """
    Read the .prm file to extract parameter table definitions.
    Creates CSV copies of .dat files and populates tables/paramsubs.
    """
    global tables, paramsubs

    basename = Path(script_dir).name
    prm_path = os.path.join(script_dir, basename + ".prm")

    # If the default .prm file doesn't exist, find any .prm file in the directory
    if not os.path.isfile(prm_path):
        prm_files = list(Path(script_dir).glob("*.prm"))
        if not prm_files:
            return
        prm_path = str(prm_files[0])

    with open(prm_path, 'r') as f:
        content = f.read()

    # Perl uses local $/ = '[' to split on '[' as record separator
    records = content.split('[')
    # Skip the first element (content before the first '[')
    for record in records[1:]:
        type_match = re.search(r'Type="(.*?)"', record)
        paramname_match = re.search(r'ParamName="(.*?)"', record)
        columnname_match = re.search(r'ColumnName="(.*?)"', record)
        table_match = re.search(r'Table="(.*?)"', record)

        if not type_match or not paramname_match:
            continue

        param_type = type_match.group(1)
        param_name = paramname_match.group(1)
        column_name = columnname_match.group(1) if columnname_match else ""
        table_name = table_match.group(1) if table_match else ""

        if param_type != "Table":
            continue

        # Process each unique table file once
        if table_name not in tables:
            # CSV filename: replace dots with underscores, add .csv
            csv_filename = table_name.replace('.', '_') + ".csv"

            tabledata = [csv_filename]

            dat_path = os.path.join(script_dir, table_name)
            csv_path = os.path.join(script_dir, csv_filename)

            columns = []
            with open(dat_path, 'r') as src, open(csv_path, 'w') as dst:
                for i, line in enumerate(src):
                    if i == 0:
                        columns = [c.strip() for c in line.split(',')]
                    elif line.strip():
                        dst.write(line)

            tabledata.extend(columns)
            tables[table_name] = tabledata

        # Resolve column name
        col_match = re.match(r'^Col (\d+)', column_name)
        if col_match:
            col_idx = int(col_match.group(1))
            paramsubs[param_name] = tables[table_name][col_idx]
        else:
            paramsubs[param_name] = column_name


# ---------------------------------------------------------------------------
# .usr file parsing
# ---------------------------------------------------------------------------

def get_action_files_from_lr(script_dir):
    """Read the .usr file to extract the list of action .c filenames."""
    basename = Path(script_dir).name
    usr_path = os.path.join(script_dir, basename + ".usr")

    # If the default .usr file doesn't exist, find any .usr file in the directory
    if not os.path.exists(usr_path):
        usr_files = list(Path(script_dir).glob("*.usr"))
        if not usr_files:
            raise FileNotFoundError(f"No .usr file found in {script_dir}")
        usr_path = str(usr_files[0])

    actions = []
    with open(usr_path, 'r') as f:
        for line in f:
            line = line.rstrip()
            if line.endswith('.c'):
                # Extract everything after the first '='
                actions.append(line.split('=', 1)[1])

    return actions


# ---------------------------------------------------------------------------
# LoadRunner function handlers
# ---------------------------------------------------------------------------

def handle_web_url(arguments):
    """Handle web_url() — GET requests."""
    global dynamic_params

    args = arguments.split(',')
    stepname = args[0].strip('"')

    request_data = {
        'stepname': stepname,
        'method': 'GET',
    }

    for arg in args:
        arg = arg.strip('"')
        url_match = re.match(r'^URL=https?://(.*?)(/.*)$', arg)
        if url_match:
            request_data['domain'] = url_match.group(1)
            request_data['path'] = url_match.group(2)

        mode_match = re.match(r'^Mode=(.*)', arg)
        if mode_match:
            request_data['image_parser'] = 'true' if 'HTML' in mode_match.group(1) else 'false'

    # Consume dynamic params
    request_data['params'] = dict(dynamic_params)
    dynamic_params.clear()

    webrequests.append(request_data)


def handle_web_submit_data(arguments):
    """Handle web_submit_data() — POST/form submissions."""
    global dynamic_params

    args = arguments.split(',')
    stepname = args.pop(0).strip('"')

    request_data = {'stepname': stepname}
    itemdata = []

    for arg in args:
        arg = arg.strip().strip('"')

        action_match = re.match(r'^Action=https?://(.*?)(/.*)$', arg)
        if action_match:
            request_data['domain'] = action_match.group(1)
            request_data['path'] = action_match.group(2)

        mode_match = re.match(r'^Mode=(.*)', arg)
        if mode_match:
            request_data['image_parser'] = 'true' if 'HTML' in mode_match.group(1) else 'false'

        method_match = re.match(r'^Method=(.*)', arg)
        if method_match:
            request_data['method'] = method_match.group(1)

        name_match = re.match(r'^Name=(.*)', arg)
        if name_match:
            itemdata.append(name_match.group(1))

        value_match = re.match(r'^Value=(.*)', arg)
        if value_match:
            itemdata.append(value_match.group(1))

        if 'LAST' in arg and len(itemdata) > 1:
            request_data['itemdata'] = itemdata

    # Consume dynamic params
    request_data['params'] = dict(dynamic_params)
    dynamic_params.clear()

    webrequests.append(request_data)


def handle_web_custom_request(arguments):
    """Handle web_custom_request() — custom HTTP method with body."""
    global dynamic_params

    args = arguments.split(',')
    stepname = args.pop(0).strip('"')

    request_data = {'stepname': stepname}
    itemdata = []

    for arg in args:
        arg = arg.strip().strip('"')

        url_match = re.match(r'^URL=https?://(.*?)(/.*)$', arg)
        if url_match:
            request_data['domain'] = url_match.group(1)
            request_data['path'] = url_match.group(2)

        mode_match = re.match(r'^Mode=(.*)', arg)
        if mode_match:
            request_data['image_parser'] = 'true' if 'HTML' in mode_match.group(1) else 'false'

        method_match = re.match(r'^Method=(.*)', arg)
        if method_match:
            request_data['method'] = method_match.group(1)

        body_match = re.match(r'^Body=(.*)', arg)
        if body_match:
            body = body_match.group(1)
            for nvpair in body.split('&'):
                itemdata.extend(nvpair.split('=', 1))

        if 'LAST' in arg and len(itemdata) > 1:
            request_data['itemdata'] = itemdata

    # Consume dynamic params
    request_data['params'] = dict(dynamic_params)
    dynamic_params.clear()

    webrequests.append(request_data)


def handle_web_reg_save_param(arguments):
    """Handle web_reg_save_param() — register correlation for next request."""
    args = arguments.split(',')
    paramname = args.pop(0).strip('"')

    lb = ""
    rb = ""

    for arg in args:
        arg = arg.strip().strip('"')

        lb_match = re.match(r'^LB=(.*)', arg)
        if lb_match:
            lb = lb_match.group(1)

        rb_match = re.match(r'^RB=(.*)', arg)
        if rb_match:
            rb = rb_match.group(1)

    dynamic_params[paramname] = lb + "(.*)" + rb
    paramsubs[paramname] = paramname


# ---------------------------------------------------------------------------
# Action file parsing and dispatch
# ---------------------------------------------------------------------------

def parse_action_files(script_dir, actions):
    """Parse each action .c file and dispatch recognized LR functions."""
    for action in actions:
        action_path = os.path.join(script_dir, action)
        with open(action_path, 'r') as f:
            lines = f.readlines()

        # Strip whitespace and quotes from each line (mirrors Perl lines 157-163)
        for i in range(len(lines)):
            lines[i] = lines[i].strip().strip('"')

        # Join all lines and split on semicolons to get function calls
        joined = ''.join(lines)
        functions = joined.split(';')

        for func_str in functions:
            match = re.match(r'(.*)\((.*)\)', func_str, re.DOTALL)
            if not match:
                continue

            func_name = match.group(1)
            func_args = match.group(2)

            if 'web_url' in func_name:
                handle_web_url(func_args)
            elif 'web_submit_data' in func_name:
                handle_web_submit_data(func_args)
            elif 'web_custom_request' in func_name:
                handle_web_custom_request(func_args)
            elif 'web_reg_save_param' in func_name:
                handle_web_reg_save_param(func_args)


# ---------------------------------------------------------------------------
# JMX XML generation
# ---------------------------------------------------------------------------

def write_jmx(script_dir):
    """Build the complete JMeter .jmx XML tree and write to file."""
    basename = Path(script_dir).name
    jmx_path = os.path.join(script_dir, basename + ".jmx")

    # Root structure
    root = ET.Element('jmeterTestPlan')
    root.set('version', '1.2')
    root.set('properties', ' 1.8')

    root_hashtree = ET.SubElement(root, 'hashTree')

    # --- TestPlan ---
    testplan = ET.SubElement(root_hashtree, 'TestPlan')
    testplan.set('guiclass', 'TestPlanGui')
    testplan.set('testclass', 'TestPlan')
    testplan.set('testname', 'LR2JM Test Plan: ' + script_dir)
    testplan.set('enabled', 'true')

    add_prop(testplan, 'boolProp', 'TestPlan.functional_mode', 'false')
    add_prop(testplan, 'stringProp', 'TestPlan.comments')
    add_prop(testplan, 'stringProp', ' TestPlan.user_define_classpath')
    add_prop(testplan, 'boolProp', 'TestPlan.serialize_threadgroups', 'false')

    elem_prop = ET.SubElement(testplan, 'elementProp')
    elem_prop.set('name', ' TestPlan.user_defined_variables')
    elem_prop.set('elementType', 'Arguments')
    elem_prop.set('guiclass', 'ArgumentsPanel')
    elem_prop.set('testclass', 'Arguments')
    elem_prop.set('testname', 'User Defined Variables')
    elem_prop.set('enabled', 'true')
    add_prop(elem_prop, 'collectionProp', 'Arguments.arguments')

    testplan_hashtree = ET.SubElement(root_hashtree, 'hashTree')

    # --- ThreadGroup ---
    threadgroup = ET.SubElement(testplan_hashtree, 'ThreadGroup')
    threadgroup.set('guiclass', 'ThreadGroupGui')
    threadgroup.set('testclass', 'ThreadGroup')
    threadgroup.set('testname', 'LR2JM Thread Group')
    threadgroup.set('enabled', 'true')

    add_prop(threadgroup, 'boolProp', 'ThreadGroup.scheduler', 'false')
    add_prop(threadgroup, 'stringProp', 'ThreadGroup.num_threads', '1')
    add_prop(threadgroup, 'stringProp', 'ThreadGroup.duration')
    add_prop(threadgroup, 'stringProp', 'ThreadGroup.delay')
    add_prop(threadgroup, 'longProp', 'ThreadGroup.start_time', '1187292555000')
    add_prop(threadgroup, 'stringProp', 'ThreadGroup.on_sample_error', 'continue')
    add_prop(threadgroup, 'stringProp', 'ThreadGroup.ramp_time', '1')

    loop_prop = ET.SubElement(threadgroup, 'elementProp')
    loop_prop.set('name', 'ThreadGroup.main_controller')
    loop_prop.set('elementType', 'LoopController')
    loop_prop.set('guiclass', 'LoopControlPanel')
    loop_prop.set('testclass', 'LoopController')
    loop_prop.set('testname', 'Loop Controller')
    loop_prop.set('enabled', 'true')
    add_prop(loop_prop, 'stringProp', 'LoopController.loops', '1')
    add_prop(loop_prop, 'boolProp', 'LoopController.continue_forever', 'false')

    add_prop(threadgroup, 'longProp', 'ThreadGroup.end_time', '1187292555000')

    tg_hashtree = ET.SubElement(testplan_hashtree, 'hashTree')

    # --- ConfigTestElement (HTTP Request Defaults) ---
    config = ET.SubElement(tg_hashtree, 'ConfigTestElement')
    config.set('guiclass', 'HttpDefaultsGui')
    config.set('testclass', 'ConfigTestElement')
    config.set('testname', 'HTTP Request Defaults')
    config.set('enabled', 'true')

    add_prop(config, 'stringProp', 'HTTPSampler.domain', '')
    add_prop(config, 'stringProp', 'HTTPSampler.path')
    add_prop(config, 'stringProp', 'HTTPSampler.port', '80')

    config_args = ET.SubElement(config, 'elementProp')
    config_args.set('name', 'HTTPsampler.Arguments')
    config_args.set('elementType', 'Arguments')
    config_args.set('guiclass', 'HTTPArgumentsPanel')
    config_args.set('testclass', 'Arguments')
    config_args.set('testname', 'User Defined Variables')
    config_args.set('enabled', 'true')
    add_prop(config_args, 'collectionProp', 'Arguments.arguments')

    add_prop(config, 'stringProp', 'HTTPSampler.protocol')

    ET.SubElement(tg_hashtree, 'hashTree')

    # --- CookieManager ---
    cookie_mgr = ET.SubElement(tg_hashtree, 'CookieManager')
    cookie_mgr.set('guiclass', 'CookiePanel')
    cookie_mgr.set('testclass', 'CookieManager')
    cookie_mgr.set('testname', 'HTTP Cookie Manager')
    cookie_mgr.set('enabled', 'true')

    add_prop(cookie_mgr, 'boolProp', 'CookieManager.clearEachIteration', 'false')
    add_prop(cookie_mgr, 'collectionProp', 'CookieManager.cookies')

    ET.SubElement(tg_hashtree, 'hashTree')

    # --- CSVDataSet for each parameter table ---
    for table_name, tabledata in tables.items():
        csv_filename = tabledata[0]
        columns = tabledata[1:]

        csv_ds = ET.SubElement(tg_hashtree, 'CSVDataSet')
        csv_ds.set('guiclass', 'TestBeanGUI')
        csv_ds.set('testclass', 'CSVDataSet')
        csv_ds.set('testname', 'LR2JM Data Set')
        csv_ds.set('enabled', 'true')

        add_prop(csv_ds, 'stringProp', 'delimiter', ',')
        add_prop(csv_ds, 'stringProp', 'fileEncoding')
        add_prop(csv_ds, 'stringProp', 'filename', csv_filename)
        add_prop(csv_ds, 'boolProp', 'recycle', 'true')
        add_prop(csv_ds, 'stringProp', 'variableNames', ','.join(columns))

        ET.SubElement(tg_hashtree, 'hashTree')

    # --- HTTPSampler for each web request ---
    for request_data in webrequests:
        httpsampler = ET.SubElement(tg_hashtree, 'HTTPSampler')
        sampler_hashtree = ET.SubElement(tg_hashtree, 'hashTree')

        # RegexExtractor for each dynamic param
        params = request_data.get('params', {})
        for param_name, regex in params.items():
            extractor = ET.SubElement(sampler_hashtree, 'RegexExtractor')
            extractor.set('guiclass', 'RegexExtractorGui')
            extractor.set('testclass', 'RegexExtractor')
            extractor.set('testname', 'LR2JM Regex Extractor')
            extractor.set('enabled', 'true')

            add_prop(extractor, 'stringProp', 'RegexExtractor.useHeaders', 'false')
            add_prop(extractor, 'stringProp', 'RegexExtractor.refname', param_name)
            add_prop(extractor, 'stringProp', 'RegexExtractor.regex', regex)
            add_prop(extractor, 'stringProp', 'RegexExtractor.template', '$1$')
            add_prop(extractor, 'stringProp', 'RegexExtractor.default')
            add_prop(extractor, 'stringProp', 'RegexExtractor.match_number', '1')

            ET.SubElement(sampler_hashtree, 'hashTree')

        # HTTPSampler attributes
        httpsampler.set('guiclass', 'HttpTestSampleGui')
        httpsampler.set('testclass', 'HTTPSampler')
        httpsampler.set('testname', request_data.get('stepname', ''))
        httpsampler.set('enabled', 'true')

        # Arguments elementProp
        args_prop = ET.SubElement(httpsampler, 'elementProp')
        args_prop.set('name', 'HTTPsampler.Arguments')
        args_prop.set('elementType', 'Arguments')
        args_prop.set('guiclass', 'HTTPArgumentsPanel')
        args_prop.set('testclass', 'Arguments')
        args_prop.set('enabled', 'true')

        collection = add_prop(args_prop, 'collectionProp', 'Arguments.arguments')

        # Form data / item data
        itemdata = request_data.get('itemdata', [])
        for i in range(0, len(itemdata) - 1, 2):
            name = param_substitution(itemdata[i])
            value = param_substitution(itemdata[i + 1])

            http_arg = ET.SubElement(collection, 'elementProp')
            http_arg.set('name', '')
            http_arg.set('elementType', 'HTTPArgument')

            add_prop(http_arg, 'boolProp', 'HTTPArgument.always_encode', 'false')
            add_prop(http_arg, 'stringProp', 'Argument.value', value)
            add_prop(http_arg, 'stringProp', 'Argument.metadata', '=')
            add_prop(http_arg, 'boolProp', 'HTTPArgument.use_equals', 'true')
            add_prop(http_arg, 'stringProp', 'Argument.name', name)

        # Standard sampler properties
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.domain',
                 request_data.get('domain', ''))
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.port')
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.protocol')
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.method',
                 request_data.get('method', ''))
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.contentEncoding')
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.path',
                 param_substitution(request_data.get('path', '')))
        add_prop(httpsampler, 'boolProp', 'HTTPSampler.follow_redirects', 'true')
        add_prop(httpsampler, 'boolProp', 'HTTPSampler.auto_redirects', 'true')
        add_prop(httpsampler, 'boolProp', 'HTTPSampler.use_keepalive', 'true')
        add_prop(httpsampler, 'boolProp', 'HTTPSampler.DO_MULTIPART_POST', 'false')
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.mimetype')
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.FILE_NAME')
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.FILE_FIELD')
        add_prop(httpsampler, 'boolProp', 'HTTPSampler.image_parser',
                 request_data.get('image_parser', 'false'))
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.monitor', 'true')
        add_prop(httpsampler, 'stringProp', 'HTTPSampler.embedded_url_re')

    # Pretty-print and write
    ET.indent(root, space='  ')
    tree = ET.ElementTree(root)
    tree.write(jmx_path, xml_declaration=True, encoding='unicode')

    print_message(f"JMeter test plan created: {jmx_path}", message_color="green")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    try:
        script_dir = read_arguments()

        get_parameters_from_lr(script_dir)

        actions = get_action_files_from_lr(script_dir)
        parse_action_files(script_dir, actions)
        write_jmx(script_dir)

    except FileNotFoundError as e:
        print_message(str(e), message_color="red")
    except Exception as e:
        print_message(f"Error: {e}", message_color="red")
        raise


if __name__ == '__main__':
    main()
