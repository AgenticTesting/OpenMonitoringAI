#!/usr/bin/env python3
"""
jm2epa.py - Convert JMeter .jmx test plans to Eggplant Performance .epa archives.

The mirror of lr2jm.py: where lr2jm takes a LoadRunner script directory and
produces a JMeter .jmx, jm2epa takes a JMeter .jmx and produces a complete
Eggplant Performance (EPP) project archive - a zip containing the generated
C# Facilita.Web script plus the VU type, profile, and project metadata files
EPP expects.

Usage:
    python jm2epa.py <plan.jmx> [--name Name] [--namespace ns] [--out dist/]
                                [--seed N]

Stdlib only. No runtime dependencies.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import uuid
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


# ---------------------------------------------------------------------------
# Small colored-output helper (same style as lr2jm.py)
# ---------------------------------------------------------------------------

def print_message(msg: str, color: str = "") -> None:
    colors = {"red": "\x1b[31m", "green": "\x1b[32m", "yellow": "\x1b[33m"}
    reset = "\x1b[0m"
    sys.stdout.write(f"{colors.get(color, '')}{msg}{reset}\n")


# ---------------------------------------------------------------------------
# UUID source (can be seeded for deterministic tests via --seed)
# ---------------------------------------------------------------------------

class UuidSource:
    def __init__(self, seed: int | None = None):
        self._counter = 0
        self._seeded = seed is not None
        self._seed = seed or 0

    def new(self) -> str:
        if self._seeded:
            self._counter += 1
            # Deterministic fake UUID. Format it so it still looks like a GUID.
            n = (self._seed * 1000 + self._counter) & 0xFFFFFFFFFFFFFFFFFFFF
            hexn = f"{n:032x}"
            return f"{hexn[0:8]}-{hexn[8:12]}-{hexn[12:16]}-{hexn[16:20]}-{hexn[20:32]}"
        return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# JMX helpers
# ---------------------------------------------------------------------------

def iter_children(hashtree: ET.Element | None):
    """
    Iterate (element, its_hashTree_sibling) pairs inside a JMX <hashTree>.

    JMeter's JMX stores the children of element X in the <hashTree> element
    that immediately follows X as a sibling. So a <hashTree> body alternates
    element / hashTree / element / hashTree ..., and the last element may
    have no hashTree if it has no children.
    """
    if hashtree is None:
        return
    kids = list(hashtree)
    i = 0
    while i < len(kids):
        elem = kids[i]
        if elem.tag == 'hashTree':
            i += 1
            continue
        nxt = kids[i + 1] if i + 1 < len(kids) else None
        ht = nxt if (nxt is not None and nxt.tag == 'hashTree') else None
        yield elem, ht
        i += 2 if ht is not None else 1


def prop_text(elem: ET.Element, name: str, default: str = "") -> str:
    """Return the text of the first direct child whose @name=='name' (prop-style)."""
    for ch in elem:
        if ch.get('name') == name:
            return (ch.text or "") if ch.text is not None else default
    return default


def prop_bool(elem: ET.Element, name: str, default: bool = False) -> bool:
    for ch in elem:
        if ch.get('name') == name:
            return (ch.text or "").strip().lower() == 'true'
    return default


def find_direct_child(elem: ET.Element, tag: str, name: str | None = None) -> ET.Element | None:
    for ch in elem:
        if ch.tag == tag and (name is None or ch.get('name') == name):
            return ch
    return None


# ---------------------------------------------------------------------------
# Identifier sanitisation
# ---------------------------------------------------------------------------

def sanitise_identifier(s: str) -> str:
    """Make a string safe to use as a C# identifier."""
    s = re.sub(r'[^A-Za-z0-9_]', '_', s or "")
    if not s:
        s = "x"
    if s[0].isdigit():
        s = "_" + s
    return s


def host_var_name(host: str, used: dict) -> str:
    """Derive a C# variable name from a hostname, guaranteeing uniqueness."""
    base = sanitise_identifier(host.replace('.', '_').replace('-', '_'))
    name = base
    n = 1
    while name in used:
        n += 1
        name = f"{base}_{n}"
    used[name] = host
    return name


# ---------------------------------------------------------------------------
# JMX -> IR
# ---------------------------------------------------------------------------

def build_ir(jmx_path: str, script_name: str, namespace: str) -> dict:
    tree = ET.parse(jmx_path)
    root = tree.getroot()  # <jmeterTestPlan>

    ir: dict = {
        "script_name": script_name,
        "namespace": namespace,
        "vu_type": f"{script_name}VU",
        "pre": {
            "default_headers": [],      # list[(k,v)]
            "default_user_agent": None,
            "seed_cookies": [],         # list[(host,k,v)]
            "user_vars": [],            # list[(k,v_default)]
            "include_hosts": [],        # list[host_key]
        },
        "hosts": {},                    # host -> {var, port, protocol}
        "_host_vars": {},               # reverse map to guarantee unique var names
        "profile_csvs": [],             # list[{file,columns,values}]
        "actions": [],
        "_req_id": 0,
    }

    # Root body: <hashTree> with the TestPlan element inside it.
    root_ht = root.find('hashTree')
    if root_ht is None:
        raise ValueError("Malformed JMX: missing top-level <hashTree>")

    for elem, ht in iter_children(root_ht):
        if elem.tag == 'TestPlan':
            parse_testplan(elem, ht, ir)

    # Drop helper private keys before returning
    ir.pop('_host_vars', None)
    ir.pop('_req_id', None)
    return ir


def parse_testplan(tp_elem: ET.Element, tp_ht: ET.Element | None, ir: dict) -> None:
    # TestPlan-level user-defined variables
    for ep in tp_elem.iter('elementProp'):
        if ep.get('name') == 'TestPlan.user_defined_variables' \
           and ep.get('elementType') == 'Arguments':
            parse_arguments_collection(ep, ir['pre']['user_vars'])

    for elem, ht in iter_children(tp_ht):
        tag = elem.tag
        if tag.endswith('ThreadGroup') or tag == 'ThreadGroup':
            parse_threadgroup(elem, ht, ir)
        elif tag == 'HeaderManager':
            parse_header_manager(elem, ir['pre']['default_headers'])
        elif tag == 'Arguments':
            parse_arguments_collection(elem, ir['pre']['user_vars'])
        elif tag == 'CookieManager':
            pass  # cookies are automatic in Facilita.Web
        elif tag == 'ConfigTestElement' and elem.get('guiclass') == 'HttpDefaultsGui':
            parse_http_defaults(elem, ir)
        elif tag == 'CSVDataSet':
            parse_csv_dataset(elem, ir, jmx_dir=None)


def parse_threadgroup(tg_elem: ET.Element, tg_ht: ET.Element | None, ir: dict) -> None:
    # Carry a "current action" that holds samplers not inside a TransactionController.
    # We create the default action lazily so we only emit it if it's used.
    state = {"default_action": None}

    def get_default():
        if state["default_action"] is None:
            act = {
                "name": "Main",
                "transaction": "Main",
                "steps": [],
                "post_pause_ms": None,
            }
            ir['actions'].append(act)
            state["default_action"] = act
        return state["default_action"]

    for elem, ht in iter_children(tg_ht):
        tag = elem.tag
        if tag == 'TransactionController':
            tc_name = elem.get('testname') or 'Transaction'
            tc_action = {
                "name": tc_name,
                "transaction": tc_name,
                "steps": [],
                "post_pause_ms": None,
            }
            ir['actions'].append(tc_action)
            walk_container(elem, ht, tc_action, ir)
        elif tag in ('HTTPSamplerProxy', 'HTTPSampler'):
            step = parse_http_sampler(elem, ht, ir)
            get_default()['steps'].append(step)
        elif tag in ('ConstantTimer', 'UniformRandomTimer', 'GaussianRandomTimer'):
            attach_timer(elem, get_default())
        elif tag == 'CSVDataSet':
            parse_csv_dataset(elem, ir, jmx_dir=None)
        elif tag == 'HeaderManager':
            parse_header_manager(elem, ir['pre']['default_headers'])
        elif tag == 'ConfigTestElement' and elem.get('guiclass') == 'HttpDefaultsGui':
            parse_http_defaults(elem, ir)
        elif tag == 'CookieManager':
            pass


def walk_container(ctrl_elem: ET.Element, ctrl_ht: ET.Element | None,
                   action: dict, ir: dict) -> None:
    """Walk a TransactionController / LoopController body, appending samplers."""
    for elem, ht in iter_children(ctrl_ht):
        tag = elem.tag
        if tag in ('HTTPSamplerProxy', 'HTTPSampler'):
            action['steps'].append(parse_http_sampler(elem, ht, ir))
        elif tag in ('ConstantTimer', 'UniformRandomTimer', 'GaussianRandomTimer'):
            attach_timer(elem, action)
        elif tag == 'HeaderManager':
            # A HeaderManager inside a TC applies to all its samplers. We fold it
            # into each sampler as we encounter it (simple approach - each future
            # sampler gets a copy). For the current cut, we append to default so
            # it at least isn't dropped.
            parse_header_manager(elem, ir['pre']['default_headers'])


def parse_http_defaults(elem: ET.Element, ir: dict) -> None:
    dom = prop_text(elem, 'HTTPSampler.domain')
    port = prop_text(elem, 'HTTPSampler.port')
    proto = prop_text(elem, 'HTTPSampler.protocol')
    if dom:
        register_host(ir, dom, port, proto)


def parse_header_manager(hm_elem: ET.Element, out_list: list) -> None:
    for coll in hm_elem.iter('collectionProp'):
        if coll.get('name') == 'HeaderManager.headers':
            for ep in coll:
                if ep.tag == 'elementProp':
                    n = prop_text(ep, 'Header.name')
                    v = prop_text(ep, 'Header.value')
                    if n:
                        out_list.append((n, v))


def parse_arguments_collection(args_elem: ET.Element, out_list: list) -> None:
    for coll in args_elem.iter('collectionProp'):
        if coll.get('name') == 'Arguments.arguments':
            for ep in coll:
                if ep.tag == 'elementProp':
                    n = prop_text(ep, 'Argument.name')
                    v = prop_text(ep, 'Argument.value')
                    if n:
                        out_list.append((n, v))


def parse_csv_dataset(elem: ET.Element, ir: dict, jmx_dir: str | None) -> None:
    filename = prop_text(elem, 'filename') or ""
    var_names = prop_text(elem, 'variableNames') or ""
    if not var_names:
        return
    cols = [c.strip() for c in var_names.split(',') if c.strip()]
    base = os.path.basename(filename) if filename else "data.csv"
    ir['profile_csvs'].append({"file": base, "columns": cols, "source": filename})


def attach_timer(elem: ET.Element, action: dict) -> None:
    ms = parse_timer(elem)
    if action['steps']:
        action['steps'][-1]['post_pause_ms'] = ms
    else:
        # Pause before first sampler: attach to action.post_pause_ms lazily.
        action['post_pause_ms'] = ms


def parse_timer(elem: ET.Element) -> int:
    """Return a pause duration in milliseconds for any timer element we recognise."""
    tag = elem.tag
    if tag == 'ConstantTimer':
        try:
            return int(prop_text(elem, 'ConstantTimer.delay', '0'))
        except ValueError:
            return 0
    if tag == 'UniformRandomTimer':
        try:
            fixed = int(prop_text(elem, 'ConstantTimer.delay', '0'))
        except ValueError:
            fixed = 0
        try:
            rng = int(float(prop_text(elem, 'RandomTimer.range', '0')))
        except ValueError:
            rng = 0
        return fixed + rng // 2  # midpoint approximation
    if tag == 'GaussianRandomTimer':
        try:
            fixed = int(prop_text(elem, 'ConstantTimer.delay', '0'))
        except ValueError:
            fixed = 0
        return fixed
    return 0


def register_host(ir: dict, host: str, port: str, protocol: str) -> str:
    if not host:
        host = "localhost"
    port_int = 0
    try:
        port_int = int(port) if port else 0
    except ValueError:
        port_int = 0
    if not protocol:
        protocol = "https" if port_int == 443 else ("http" if port_int in (0, 80) else "https")
    if port_int == 0:
        port_int = 443 if protocol == "https" else 80

    if host not in ir['hosts']:
        var = host_var_name(host, ir['_host_vars'])
        ir['hosts'][host] = {"var": var, "port": port_int, "protocol": protocol}
        if host not in ir['pre']['include_hosts']:
            ir['pre']['include_hosts'].append(host)
    return host


def parse_http_sampler(s_elem: ET.Element, s_ht: ET.Element | None, ir: dict) -> dict:
    ir['_req_id'] += 1
    step = {
        "kind": "request",
        "id": ir['_req_id'],
        "name": s_elem.get('testname') or f"Request {ir['_req_id']}",
        "method": (prop_text(s_elem, 'HTTPSampler.method', 'GET') or 'GET').upper(),
        "path": prop_text(s_elem, 'HTTPSampler.path', '/'),
        "query": [],
        "headers": [],
        "body": None,
        "extractors": [],
        "asserts": [],
        "post_pause_ms": None,
    }
    domain = prop_text(s_elem, 'HTTPSampler.domain')
    port = prop_text(s_elem, 'HTTPSampler.port')
    protocol = prop_text(s_elem, 'HTTPSampler.protocol')

    # If the sampler doesn't specify a domain, fall back to the first registered host
    # (which came from ConfigTestElement HttpDefaultsGui). This mirrors JMeter behaviour.
    if not domain and ir['hosts']:
        domain = next(iter(ir['hosts'].keys()))

    host_key = register_host(ir, domain, port, protocol)
    step['host_key'] = host_key

    # The postBodyRaw flag may be a direct child of the sampler OR nested inside
    # the Arguments elementProp, depending on the JMeter version / GUI.
    post_body_raw = prop_bool(s_elem, 'HTTPSampler.postBodyRaw', False)

    # Collect HTTP arguments (the query string or the form body)
    args: list[tuple[str, str]] = []
    args_ep = None
    for ep in s_elem:
        if ep.tag == 'elementProp' and ep.get('name') == 'HTTPsampler.Arguments':
            args_ep = ep
            break
    if args_ep is not None:
        if not post_body_raw:
            post_body_raw = prop_bool(args_ep, 'HTTPSampler.postBodyRaw', False)
        for coll in args_ep.iter('collectionProp'):
            if coll.get('name') != 'Arguments.arguments':
                continue
            for arg_ep in coll:
                if arg_ep.tag != 'elementProp':
                    continue
                n = prop_text(arg_ep, 'Argument.name', '')
                v = prop_text(arg_ep, 'Argument.value', '')
                args.append((n, v))

    # Split path from inline query string if present
    if '?' in step['path']:
        step['path'], qs = step['path'].split('?', 1)
        for pair in qs.split('&'):
            if '=' in pair:
                k, v = pair.split('=', 1)
            else:
                k, v = pair, ''
            step['query'].append((k, v))

    # Classify args
    if step['method'] == 'GET':
        step['query'].extend(args)
    elif post_body_raw:
        raw = args[0][1] if args else ''
        ct = 'application/json' if raw.lstrip().startswith(('{', '[')) else 'text/plain'
        step['body'] = {"kind": "raw", "content": raw, "content_type": ct}
    elif args:
        # Form body
        step['body'] = {"kind": "form", "parts": args}

    # Children: headers / extractors / assertions / inline timers
    for c_elem, c_ht in iter_children(s_ht):
        t = c_elem.tag
        if t == 'HeaderManager':
            parse_header_manager(c_elem, step['headers'])
        elif t == 'RegexExtractor':
            ex = parse_regex_extractor(c_elem)
            if ex:
                step['extractors'].append(ex)
        elif t == 'BoundaryExtractor':
            ex = parse_boundary_extractor(c_elem)
            if ex:
                step['extractors'].append(ex)
        elif t == 'JSONPostProcessor':
            ex = parse_json_postprocessor(c_elem)
            if ex:
                step['extractors'].append(ex)
        elif t == 'ResponseAssertion':
            a = parse_response_assertion(c_elem)
            if a:
                step['asserts'].append(a)
        elif t in ('ConstantTimer', 'UniformRandomTimer', 'GaussianRandomTimer'):
            step['post_pause_ms'] = parse_timer(c_elem)

    # If caller didn't include a status assertion, implicitly verify 2xx
    if not any(a['kind'] == 'status' for a in step['asserts']):
        step['asserts'].append({"kind": "status", "expected": 200})

    return step


def parse_regex_extractor(elem: ET.Element) -> dict | None:
    name = prop_text(elem, 'RegexExtractor.refname')
    regex = prop_text(elem, 'RegexExtractor.regex')
    template = prop_text(elem, 'RegexExtractor.template', '$1$')
    match_str = prop_text(elem, 'RegexExtractor.match_number', '1')
    try:
        match_n = int(match_str)
    except ValueError:
        match_n = 1
    if not name or not regex:
        return None

    # Try to reduce a simple LB(.*?)RB or LB(.*)RB into a boundary extractor
    # because Response.Extract(cursor, LB, RB, ...) is the idiomatic EPP form.
    m = re.match(r'^(.+?)\(\.\*\??\)(.+?)$', regex)
    if m and template == '$1$':
        return {
            "kind": "boundary",
            "name": name,
            "lb": m.group(1),
            "rb": m.group(2),
            "match": match_n,
        }
    return {
        "kind": "regex",
        "name": name,
        "regex": regex,
        "template": template,
        "match": match_n,
    }


def parse_boundary_extractor(elem: ET.Element) -> dict | None:
    name = prop_text(elem, 'BoundaryExtractor.refname')
    lb = prop_text(elem, 'BoundaryExtractor.lboundary')
    rb = prop_text(elem, 'BoundaryExtractor.rboundary')
    match_str = prop_text(elem, 'BoundaryExtractor.match_number', '1')
    try:
        match_n = int(match_str)
    except ValueError:
        match_n = 1
    if not name or (not lb and not rb):
        return None
    return {"kind": "boundary", "name": name, "lb": lb, "rb": rb, "match": match_n}


def parse_json_postprocessor(elem: ET.Element) -> dict | None:
    name = prop_text(elem, 'JSONPostProcessor.referenceNames')
    path = prop_text(elem, 'JSONPostProcessor.jsonPathExprs')
    if not name:
        return None
    return {"kind": "json", "name": name, "path": path}


def parse_response_assertion(elem: ET.Element) -> dict | None:
    for coll in elem.iter('collectionProp'):
        if coll.get('name') != 'Asserion.test_strings':
            # NB: JMeter uses this misspelled tag name historically
            if coll.get('name') != 'Asserion.test_strings':
                if coll.get('name') != 'Assertion.test_strings':
                    continue
        for sp in coll:
            if sp.tag == 'stringProp' and sp.text:
                txt = sp.text.strip()
                if txt.isdigit():
                    return {"kind": "status", "expected": int(txt)}
    return None


# ---------------------------------------------------------------------------
# C# emitter
# ---------------------------------------------------------------------------

HTTP_STATUS_NAMES = {
    200: "OK", 201: "CREATED", 202: "ACCEPTED", 204: "NO_CONTENT",
    301: "MOVED_PERMANENTLY", 302: "FOUND", 303: "SEE_OTHER", 304: "NOT_MODIFIED",
    307: "TEMPORARY_REDIRECT", 308: "PERMANENT_REDIRECT",
    400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED", 409: "CONFLICT", 410: "GONE", 422: "UNPROCESSABLE_ENTITY",
    500: "INTERNAL_SERVER_ERROR", 502: "BAD_GATEWAY", 503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
}


def cs_string_literal(s: str) -> str:
    """
    Emit a C# string literal, rewriting ${var} to GetString("var") concatenation.

    The output is an *expression* - either a plain literal or a concatenation
    of literals and GetString() calls. Example:
        "/transactions/${id}/receipt" -> "/transactions/" + GetString("id") + "/receipt"
    """
    if s is None:
        s = ""
    parts = []
    i = 0
    while i < len(s):
        m = re.search(r'\$\{([A-Za-z0-9_]+)\}', s[i:])
        if not m:
            parts.append(("lit", s[i:]))
            break
        if m.start() > 0:
            parts.append(("lit", s[i:i + m.start()]))
        parts.append(("var", m.group(1)))
        i += m.end()
    if not parts:
        return '""'
    out = []
    for kind, val in parts:
        if kind == "lit":
            out.append('"' + val.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r') + '"')
        else:
            out.append(f'GetString("{val}")')
    # Collapse adjacent literals
    return " + ".join(out)


def cs_verbatim_string(s: str) -> str:
    """Emit a C# verbatim string literal @"..." (useful for long JSON bodies)."""
    # In verbatim strings, " is escaped as ""
    return '@"' + s.replace('"', '""') + '"'


def status_enum(code: int) -> str:
    name = HTTP_STATUS_NAMES.get(code)
    if name:
        return f"HttpStatus.{name}"
    # Fall back to numeric if we don't know a symbolic name
    return f"(HttpStatus){code}"


def emit_script_cs(ir: dict) -> str:
    """Emit project/scripts/clr/<ns>/<ScriptName>.cs - the generated script."""
    ns = ir['namespace']
    name = ir['script_name']
    vu_script = f"{ir['vu_type']}Script"

    lines: list[str] = []
    w = lines.append

    w(f"// Script Created by jm2epa")
    w(f"// Generated from JMeter .jmx")
    w("")
    w("using System;")
    w("using System.Collections.Generic;")
    w("using System.Text;")
    w("")
    w("using Facilita.Native;")
    w("using Facilita.Web;")
    w("using Facilita.Fc.Runtime;")
    w("using Facilita.Fc.Runtime.BackgroundScripting;")
    w("")
    w("#region EPP_IMPORTS")
    w("")
    w("// Code added here will be preserved during script regeneration")
    w("")
    w("#endregion EPP_IMPORTS")
    w("")
    w(f"using AVirtualUserScript = {ns}.{vu_script};")
    w("")
    w(f"namespace {ns}")
    w("{")
    w(f"\tpublic class {name} : AVirtualUserScript")
    w("\t{")
    w("")

    # Generated host / protocol variables
    w("\t\t// Generated variables")
    for host, info in ir['hosts'].items():
        w(f"\t\tIpEndPoint {info['var']} = null;  // parameterised web server address")
    # One protocol per unique scheme (just emit one - protocol1 - if there's only one)
    protocols = []
    for host, info in ir['hosts'].items():
        if info['protocol'] not in protocols:
            protocols.append(info['protocol'])
    if protocols:
        w("\t\tProtocol protocol1 = null;  // parameterised protocol")
    w("\t\t// End of generated variables")
    w("")
    w("\t\t#region EPP_GLOBAL_VARIABLES")
    w("")
    w("\t\t// Code added here will be preserved during script regeneration")
    w("")
    w("\t\t#endregion EPP_GLOBAL_VARIABLES")
    w("")

    # Pre()
    w("\t\tpublic override void Pre()")
    w("\t\t{")
    w("\t\t\tbase.Pre();")
    w("")
    w("\t\t\t// START INITIALISATION CODE")
    if ir['pre']['default_user_agent']:
        w(f'\t\t\tWebBrowser.DefaultUserAgent = GetString("User-Agent", "{ir["pre"]["default_user_agent"]}");')
    for k, v in ir['pre']['default_headers']:
        w(f'\t\t\tWebBrowser.SetDefaultHeader("{escape_cs(k)}", "{escape_cs(v)}");')
    w("\t\t\tWebBrowser.DefaultFollowRedirects = true;")
    w("\t\t\tWebBrowser.HostFilteringMode = HostFilteringMode.ALLOWLIST;")
    w("\t\t\t// END INITIALISATION CODE")
    w("")
    w("\t\t\t#region EPP_PRE")
    w("")
    w("\t\t\t// Code added here will be preserved during script regeneration")
    w("")
    w("\t\t\t#endregion EPP_PRE")
    w("\t\t}")
    w("")

    # Script()
    w("\t\tpublic override void Script()")
    w("\t\t{")
    for host, info in ir['hosts'].items():
        var = info['var']
        port = info['port']
        w(f'\t\t\t{var} = new IpEndPoint(GetString("{var}Host", "{escape_cs(host)}"), GetInt("{var}Port", {port}));')
    if protocols:
        w(f'\t\t\tprotocol1 = GetProtocol("protocol1", "{protocols[0]}");')
    w("")
    for host in ir['pre']['include_hosts']:
        var = ir['hosts'][host]['var']
        w(f'\t\t\tWebBrowser.IncludeHost(GetString("{var}Host", "{escape_cs(host)}"));')
    w("")
    for i, action in enumerate(ir['actions'], start=1):
        mname = action_method_name(action, i)
        w(f"\t\t\t{mname}();")
    w("")
    w("\t\t\t#region EPP_SCRIPT")
    w("")
    w("\t\t\t// Code added here will be preserved during script regeneration")
    w("")
    w("\t\t\t#endregion EPP_SCRIPT")
    w("\t\t}")
    w("")

    # Per-action methods
    for i, action in enumerate(ir['actions'], start=1):
        emit_action(w, action, i, ir)

    w("\t}")
    w("}")
    return "\n".join(lines) + "\n"


def action_method_name(action: dict, index: int) -> str:
    return f"Action{index}_{sanitise_identifier(action['name'])}"


def emit_action(w, action: dict, index: int, ir: dict) -> None:
    mname = action_method_name(action, index)
    tname = action.get('transaction') or action['name']

    w(f"\t\tvoid {mname}()")
    w("\t\t{")
    w(f'\t\t\t#region EPP_BEFORE_START_TRANSACTION for Transaction "{tname}"')
    w("")
    w("\t\t\t// Code added here will be preserved during script regeneration")
    w("")
    w(f'\t\t\t#endregion EPP_BEFORE_START_TRANSACTION for Transaction "{tname}"')
    w("")
    w(f'\t\t\tStartTransaction("{escape_cs(tname)}");')
    w("")

    for step in action['steps']:
        emit_step(w, step, ir)

    w(f'\t\t\t#region EPP_BEFORE_END_TRANSACTION for Transaction "{tname}"')
    w("")
    w("\t\t\t// Code added here will be preserved during script regeneration")
    w("")
    w(f'\t\t\t#endregion EPP_BEFORE_END_TRANSACTION for Transaction "{tname}"')
    w("")
    w(f'\t\t\tEndTransaction("{escape_cs(tname)}");')

    if action.get('post_pause_ms'):
        w("")
        w(f"\t\t\tPause({action['post_pause_ms']});")

    w("\t\t}")
    w("")


def emit_step(w, step: dict, ir: dict) -> None:
    rid = step['id']
    method = step['method']
    host_info = ir['hosts'][step['host_key']]
    host_var = host_info['var']
    path_expr = cs_string_literal(step['path'])

    w(f"\t\t\t// ====================================================================================================================================")
    w(f"\t\t\t// Request: {rid}, {method}, {step['host_key']}{step['path']}, {step['name']}")
    w(f"\t\t\t// ====================================================================================================================================")

    url_var = f"url{rid}"
    if step['query']:
        w(f"\t\t\tUrl {url_var} = new Url(protocol1, {host_var}, {path_expr});")
        qd_var = f"queryData{rid}"
        w(f"\t\t\tQueryData {qd_var} = new QueryData();")
        for k, v in step['query']:
            w(f"\t\t\t{qd_var}.Add({cs_string_literal(k)}, {cs_string_literal(v)});")
        w(f"\t\t\t{url_var} = {url_var}.WithQuery({qd_var});")
    else:
        w(f"\t\t\tUrl {url_var} = new Url(protocol1, {host_var}, {path_expr});")

    req_var = f"request{rid}"
    resp_var = f"response{rid}"
    w(f"\t\t\tusing (Request {req_var} = WebBrowser.CreateRequest(HttpMethod.{method}, {url_var}, {rid}))")
    w("\t\t\t{")

    for k, v in step['headers']:
        w(f"\t\t\t\t{req_var}.SetHeader({cs_string_literal(k)}, {cs_string_literal(v)});")

    body = step['body']
    if body:
        if body['kind'] == 'form':
            form_var = f"postData{rid}"
            w(f"\t\t\t\tForm {form_var} = new Form();")
            w(f'\t\t\t\t{form_var}.CharEncoding = Encoding.GetEncoding("utf-8");')
            for k, v in body['parts']:
                w(f'\t\t\t\t{form_var}.AddElement(new InputElement({cs_string_literal(k)}, {cs_string_literal(v)}, Encoding.GetEncoding("utf-8")));')
            w(f"\t\t\t\t{req_var}.SetMessageBody({form_var});")
        elif body['kind'] == 'raw':
            body_expr = cs_string_literal(body['content'])
            w(f"\t\t\t\tstring postDataString{rid} = {body_expr};")
            w(f"\t\t\t\t{req_var}.SetMessageBody(postDataString{rid});")

    w("")
    w(f"\t\t\t\t#region EPP_BEFORE_REQUEST_SENT for Request {rid}")
    w("")
    w("\t\t\t\t// Code added here will be preserved during script regeneration")
    w("")
    w(f"\t\t\t\t#endregion EPP_BEFORE_REQUEST_SENT for Request {rid}")
    w("")
    w(f"\t\t\t\tusing (Response {resp_var} = {req_var}.Send())")
    w("\t\t\t\t{")
    w(f"\t\t\t\t\t#region EPP_AFTER_RESPONSE_RECEIVED for Request {rid}")
    w("")
    w("\t\t\t\t\t// Code added here will be preserved during script regeneration")
    w("")
    w(f"\t\t\t\t\t#endregion EPP_AFTER_RESPONSE_RECEIVED for Request {rid}")
    w("")

    # Extractors
    for j, ex in enumerate(step['extractors']):
        if ex['kind'] == 'boundary':
            cur = f"extractionCursor{rid}" + (f"_{j}" if j > 0 else "")
            w(f"\t\t\t\t\tExtractionCursor {cur} = new ExtractionCursor();")
            w(f'\t\t\t\t\tSet<string>("{escape_cs(ex["name"])}", {resp_var}.Extract({cur}, "{escape_cs(ex["lb"])}", "{escape_cs(ex["rb"])}", ActionType.ACT_WARNING, true, SearchFlags.SEARCH_IN_BODY));')
        elif ex['kind'] == 'regex':
            w(f'\t\t\t\t\t// TODO jm2epa: regex extractor for "{ex["name"]}" - JMeter regex: {ex["regex"]}')
            w(f'\t\t\t\t\t// Consider refactoring to Response.Extract(cursor, LB, RB, ...) in Facilita.Web idiom.')
            w(f'\t\t\t\t\tSet<string>("{escape_cs(ex["name"])}", "");  // TODO: port regex manually')
        elif ex['kind'] == 'json':
            w(f'\t\t\t\t\t// TODO jm2epa: JSONPath "{ex["path"]}" -> "{ex["name"]}" - no direct EPP primitive; add manually.')
            w(f'\t\t\t\t\tSet<string>("{escape_cs(ex["name"])}", "");  // TODO')

    # Assertions
    for a in step['asserts']:
        if a['kind'] == 'status':
            w(f"\t\t\t\t\t{resp_var}.VerifyResult({status_enum(a['expected'])}, ActionType.ACT_WARNING);")

    w("\t\t\t\t}")
    w("\t\t\t}")

    if step.get('post_pause_ms'):
        w("")
        w(f"\t\t\tPause({step['post_pause_ms']});")
    w("")


def escape_cs(s: str) -> str:
    if s is None:
        return ""
    return s.replace('\\', '\\\\').replace('"', '\\"')


# ---------------------------------------------------------------------------
# Stock template files (VU class, abstract script, profile, etc.)
# ---------------------------------------------------------------------------

def emit_vu_cs(ir: dict) -> str:
    ns = ir['namespace']
    vu = ir['vu_type']
    return f"""using System;
using System.Collections.Generic;
using System.Text;

using Facilita.Native;
using Facilita.Web;
using Facilita.Fc.Runtime;
using Facilita.Fc.Runtime.BackgroundScripting;

using AVirtualUser = Facilita.Web.WebBrowserVirtualUser;

namespace {ns}
{{
\tpublic class {vu} : AVirtualUser
\t{{
\t\tpublic {vu}()
\t\t{{
\t\t}}

\t\tprotected override void Pre()
\t\t{{
\t\t\tbase.Pre();
\t\t}}

\t\tprotected override void Post()
\t\t{{
\t\t\tbase.Post();
\t\t}}

\t\tpublic override void PrepareRequest(Request request)
\t\t{{
\t\t\tbase.PrepareRequest(request);
\t\t}}

\t\tpublic override void ProcessResponse(Response response)
\t\t{{
\t\t\tbase.ProcessResponse(response);
\t\t}}

\t\tprotected override bool OnError(string id, string info)
\t\t{{
\t\t\treturn base.OnError(id, info);
\t\t}}

\t\tprotected override bool OnWarn(string id, string info)
\t\t{{
\t\t\treturn base.OnWarn(id, info);
\t\t}}

\t\tprotected override bool OnException(Exception e)
\t\t{{
\t\t\treturn base.OnException(e);
\t\t}}
\t}}
}}
"""


def emit_vu_script_cs(ir: dict) -> str:
    ns = ir['namespace']
    vu = ir['vu_type']
    return f"""using System;
using System.Collections.Generic;
using System.Text;

using Facilita.Native;
using Facilita.Web;
using Facilita.Fc.Runtime;
using Facilita.Fc.Runtime.BackgroundScripting;

using AVirtualUserScript = Facilita.Web.WebBrowserScript;

namespace {ns}
{{
\tpublic abstract class {vu}Script : AVirtualUserScript
\t{{
\t\tpublic new {vu} VU
\t\t{{
\t\t\tget {{ return ({vu})(((Facilita.Web.WebBrowserScript)this).VU); }}
\t\t}}

\t\tpublic override void Pre()
\t\t{{
\t\t\tbase.Pre();
\t\t}}
\t}}
}}
"""


def emit_vu_type_ini(ir: dict, vu_id: str) -> str:
    vu = ir['vu_type']
    ns = ir['namespace']
    return f"""[object]
maxVUPerEngine = 500
scriptExtension = '.cs'
description = '{vu}'
templateName = 'WebBrowserScript.cs'
scriptPackageName = '{ns}'
monitorAssembly = 'Facilita.Fc.TestController.Controller'
abstractTemplateName = 'WebBrowserScript_S.cs'
vuTemplateName = 'webVU.cs'
folderName = 'Web'
className = '{ns}.{vu}'
metaKey = 'WebCLRVUType'
extends = 'CSWebBrowserUser'
recommendedVusPerInjector = 500
_id_ = '{vu_id}'
engineTypeName = 'clr'
scriptClassName = '{ns}.{vu}Script'
name = '{vu}'
"""


def emit_profile_ini(ir: dict, default_id: str, alt_id: str) -> str:
    vu = ir['vu_type']
    return f"""[item.default]
eventLogClass = 'Facilita.Fc.Runtime.FileEventLog'
engineProfileName = 'intel.win32.clr4_5'
builderName = ''
metaKey = 'CLRVUProfile'
environmentVariables = {{}}
name = 'default'
vuTypeName = '{vu}'
nullEventLogClass = 'Facilita.Fc.Runtime.NullEventLog'
_id_ = '{default_id}'
initialisers = ['Facilita.Web.WebBrowserUserInitialiser']
monitorClass = 'Facilita.Fc.Runtime.Monitor'
isDefault = True
description = ''
[item.intel.win32.cs4_7_1]
eventLogClass = 'Facilita.Fc.Runtime.FileEventLog'
engineProfileName = 'intel.win32.clr4_7_1'
builderName = 'intel.win32.cs4_7_1'
metaKey = 'CLRVUProfile'
environmentVariables = {{}}
name = 'intel.win32.cs4_7_1'
vuTypeName = '{vu}'
nullEventLogClass = 'Facilita.Fc.Runtime.NullEventLog'
_id_ = '{alt_id}'
initialisers = ['Facilita.Web.WebBrowserUserInitialiser']
monitorClass = 'Facilita.Fc.Runtime.Monitor'
isDefault = False
description = ''
"""


def emit_profile_csv() -> str:
    # Headers only - matches the sample archives.
    return "linkWith,vuProfileName,name,controlFlags,transferToInjector,rank,loadAtRuntime,_id_,metaKey,debugPath\nB,S,S,I,B,I,B,S,S,S\n"


def emit_scripts_csv(ir: dict, abs_id: str, vu_id: str, main_id: str, trace_name: str) -> str:
    ns = ir['namespace']
    vu = ir['vu_type']
    name = ir['script_name']
    # Matches the layout observed in sample archives (three rows).
    header1 = "methods,endTransactionOccurrence,startTransaction,metaKey,generationRulesUsageReportFilePath,isExecutable,startTransactionOccurrence,namespace,_id_,build,targetUrl,traceName,description,vuTypeName,generationReportFilePath,pathName,soapVersion,isMainScript,name,package,endTransaction,serviceID,_parentId_"
    types1 = "LS,I,S,S,S,B,I,S,S,B,S,S,S,S,S,S,I,B,S,S,S,S,S"
    abstract_row = f"[],-1,'','CSWebScript','',True,-1,'{ns}','{abs_id}',True,'','','','{vu}','','{vu}Script.cs',0,True,'{vu}Script',,'','',''"
    base_row = f",,,'CSCLRScript','',True,,'{ns}','{vu_id}',True,,'','','{vu}','','{vu}.cs',,True,'{vu}',,,'',''"
    header2 = header1
    types2 = types1
    main_row = (
        f"[],-2,'','CSWebScript','',True,-2,'{ns}','{main_id}',True,"
        f"'','{trace_name}','','{vu}','','{name}.cs',0,True,'{name}',,'','',''"
    )
    return "\n".join([header1, types1, abstract_row, base_row, header2, types2, main_row, ""])


def emit_traces_csv(ir: dict, trace_id: str) -> str:
    name = ir['script_name']
    header = "isCitrixStoreFront,description,_id_,excludedGenerationRules,metaKey,pathName,_parentId_,transactionNames,serviceName,completedInputDataScan,name"
    types = "B,S,S,LS,S,S,S,LS,S,B,S"
    row = f"False,'','{trace_id}',[],'WebTrace','{name}\\{name}.hlog','',,,True,'{name}'"
    return "\n".join([header, types, row, ""])


def emit_source_csv(ir: dict) -> str:
    return "linkWith,vuProfileName,name,controlFlags,transferToInjector,rank,loadAtRuntime,_id_,metaKey,debugPath\nB,S,S,I,B,I,B,S,S,S\n"


def emit_gen_options_ini(ir: dict) -> str:
    ns = ir['namespace']
    vu = ir['vu_type']
    name = ir['script_name']
    hosts_csv = ",".join(ir['pre']['include_hosts']) if ir['pre']['include_hosts'] else ""
    ns_win = ns.replace('.', '\\')
    script_path = "clr\\" + ns_win + "\\" + name + ".cs"
    return f"""[options]
language = CS
baseName = {ns}.{vu}Script
namespace = {ns}
excludedRules =
traceName = {name}.filtered
version = jm2epa-1.0
extractMode = 1
genPersistentCookies = True
autoCorrelateCookies = True
minimumCookieReplacementLength = 6
generateAllNonResponses = False
generateHTTP404Responses = False
groupTime = 500
includeCookies = False
maxPostDataLength = 65534
maxStringLength = 100
parameterizeForms = True
parameterizePostData = True
parameterizeQueryData = True
pauseThreshold = 2000
runtimeFollowRedirects = True
runtimeGetEmbeddedUrls = True
hostFilteringMode = 1
hostFilterSet = {hosts_csv}
hostsRegExpsFilterSet =
outputScripts = {name}

[options.script.{name}]
path = {script_path}
startAt =
startOccurrence = -2
endAt =
endOccurrence = -2
"""


def emit_generation_rules_json() -> str:
    return "[]"


# ---------------------------------------------------------------------------
# Package into .epa (zip)
# ---------------------------------------------------------------------------

def package_epa(ir: dict, out_path: str, uuids: UuidSource) -> None:
    ns = ir['namespace']
    ns_path = ns.replace('.', '/')
    vu = ir['vu_type']
    name = ir['script_name']

    vu_id = uuids.new()
    abs_id = uuids.new()
    main_id = uuids.new()
    trace_id = uuids.new()
    profile_default_id = uuids.new()
    profile_alt_id = uuids.new()

    # Collect files
    files: list[tuple[str, str]] = []
    files.append((f"vuTypes/{vu}.ini", emit_vu_type_ini(ir, vu_id)))
    files.append((f"vuTypes/{vu}/generationRules.json", emit_generation_rules_json()))
    files.append((f"profiles/{vu}.ini", emit_profile_ini(ir, profile_default_id, profile_alt_id)))
    files.append((f"profiles/{vu}.csv", emit_profile_csv()))
    files.append((f"scripts/clr/{ns_path}/{vu}.cs", emit_vu_cs(ir)))
    files.append((f"scripts/clr/{ns_path}/{vu}Script.cs", emit_vu_script_cs(ir)))
    files.append((f"project/scripts.csv", emit_scripts_csv(ir, abs_id, vu_id, main_id, name)))
    files.append((f"project/traces.csv", emit_traces_csv(ir, trace_id)))
    files.append((f"project/scripts/clr/{ns_path}/{name}.cs", emit_script_cs(ir)))
    files.append((f"project/traces/{name}/{name}_genOptions.ini", emit_gen_options_ini(ir)))
    files.append(("source.csv", emit_source_csv(ir)))

    # Optional profile data CSVs from CSVDataSet
    for csv_spec in ir['profile_csvs']:
        header = ",".join(csv_spec['columns'])
        files.append((f"data/{csv_spec['file']}", header + "\n"))

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for arc, content in files:
            zi = zipfile.ZipInfo(arc)
            zi.compress_type = zipfile.ZIP_DEFLATED
            # Fixed timestamp for deterministic archives
            zi.date_time = (1980, 1, 1, 0, 0, 0)
            zf.writestr(zi, content.encode('utf-8'))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def read_arguments() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Convert JMeter .jmx to Eggplant Performance .epa")
    p.add_argument('jmx_path', help='Input JMX file')
    p.add_argument('--name', default=None, help='Script name (default: basename of JMX)')
    p.add_argument('--namespace', default='com.testplant.testing', help='C# namespace')
    p.add_argument('--out', default='.', help='Output directory')
    p.add_argument('--seed', type=int, default=None, help='Deterministic UUID seed (for tests)')
    return p.parse_args()


def main() -> None:
    args = read_arguments()
    if not os.path.isfile(args.jmx_path):
        print_message(f"{args.jmx_path}: not a file", "red")
        sys.exit(1)

    name = args.name or sanitise_identifier(Path(args.jmx_path).stem)
    ir = build_ir(args.jmx_path, name, args.namespace)

    if not ir['actions']:
        print_message("No samplers found in JMX - nothing to emit.", "yellow")
        sys.exit(1)

    uuids = UuidSource(args.seed)
    out_path = os.path.join(args.out, name + ".epa")
    package_epa(ir, out_path, uuids)
    print_message(f"Wrote {out_path}", "green")


if __name__ == '__main__':
    main()
