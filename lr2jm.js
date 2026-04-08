#!/usr/bin/env node
/**
 * lr2jm.js — Convert LoadRunner scripts to JMeter .jmx test plans.
 *
 * Ported from lr2jm.pl (Perl) to JavaScript (Node.js, no dependencies).
 *
 * Usage:
 *     node lr2jm.js <LoadRunner Script Directory>
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Global state (mirrors Perl globals)
// ---------------------------------------------------------------------------
const webrequests = [];       // array of request objects
const tables = {};            // tableName -> [csvFilename, col1, col2, ...]
const paramsubs = {};         // paramName -> resolved column name
let dynamicParams = {};       // paramName -> regex (consumed by next HTTP request)

// ---------------------------------------------------------------------------
// Minimal XML builder (no dependencies)
// ---------------------------------------------------------------------------

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

class XmlElement {
    constructor(tag) {
        this.tag = tag;
        this.attrs = {};
        this.children = [];
        this.text = null;
    }

    set(name, value) {
        this.attrs[name] = value;
        return this;
    }

    addChild(tag) {
        const child = new XmlElement(tag);
        this.children.push(child);
        return child;
    }

    toString(indent = 0) {
        const pad = '  '.repeat(indent);
        const attrStr = Object.entries(this.attrs)
            .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
            .join('');

        if (this.children.length === 0 && this.text == null) {
            return `${pad}<${this.tag}${attrStr} />`;
        }

        let result = `${pad}<${this.tag}${attrStr}>`;

        if (this.text != null && this.children.length === 0) {
            result += escapeXml(this.text) + `</${this.tag}>`;
            return result;
        }

        result += '\n';
        if (this.text != null) {
            result += `${pad}  ${escapeXml(this.text)}\n`;
        }
        for (const child of this.children) {
            result += child.toString(indent + 1) + '\n';
        }
        result += `${pad}</${this.tag}>`;
        return result;
    }
}

/**
 * Add a property sub-element with a name attribute and optional text.
 */
function addProp(parent, tag, name, text) {
    const elem = parent.addChild(tag);
    elem.set('name', name);
    if (text !== undefined && text !== null) {
        elem.text = String(text);
    }
    return elem;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paramSubstitution(inputString) {
    let result = inputString || '';
    for (const [param, sub] of Object.entries(paramsubs)) {
        result = result.split('{' + param + '}').join('${' + sub + '}');
    }
    return result;
}

function printMessage(message, color) {
    const colors = { red: '\x1b[31m', green: '\x1b[32m' };
    const reset = '\x1b[0m';
    console.log((colors[color] || '') + message + reset);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readArguments() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node lr2jm.js <LoadRunner Script Directory>');
        process.exit(1);
    }
    const scriptDir = args[0];
    if (!fs.existsSync(scriptDir) || !fs.statSync(scriptDir).isDirectory()) {
        printMessage(`${scriptDir}: not a valid directory`, 'red');
        process.exit(1);
    }
    return scriptDir;
}

// ---------------------------------------------------------------------------
// .prm parameter file parsing
// ---------------------------------------------------------------------------

function getParametersFromLR(scriptDir) {
    const basename = path.basename(scriptDir);
    const prmPath = path.join(scriptDir, basename + '.prm');

    if (!fs.existsSync(prmPath)) return;

    const content = fs.readFileSync(prmPath, 'utf-8');

    // Perl uses local $/ = '[' to split on '[' as record separator
    const records = content.split('[');
    // Skip the first element (content before the first '[')
    for (let i = 1; i < records.length; i++) {
        const record = records[i];

        const typeMatch = record.match(/Type="(.*?)"/);
        const paramNameMatch = record.match(/ParamName="(.*?)"/);
        const columnNameMatch = record.match(/ColumnName="(.*?)"/);
        const tableMatch = record.match(/Table="(.*?)"/);

        if (!typeMatch || !paramNameMatch) continue;

        const paramType = typeMatch[1];
        const paramName = paramNameMatch[1];
        const columnName = columnNameMatch ? columnNameMatch[1] : '';
        const tableName = tableMatch ? tableMatch[1] : '';

        if (paramType !== 'Table') continue;

        // Process each unique table file once
        if (!(tableName in tables)) {
            const csvFilename = tableName.replace(/\./g, '_') + '.csv';
            const tabledata = [csvFilename];

            const datPath = path.join(scriptDir, tableName);
            const csvPath = path.join(scriptDir, csvFilename);

            const datContent = fs.readFileSync(datPath, 'utf-8');
            const datLines = datContent.split('\n');

            let columns = [];
            const csvLines = [];

            for (let j = 0; j < datLines.length; j++) {
                if (j === 0) {
                    columns = datLines[j].split(',').map(c => c.trim());
                } else if (datLines[j].trim()) {
                    csvLines.push(datLines[j]);
                }
            }

            fs.writeFileSync(csvPath, csvLines.join('\n') + (csvLines.length ? '\n' : ''));
            tabledata.push(...columns);
            tables[tableName] = tabledata;
        }

        // Resolve column name
        const colMatch = columnName.match(/^Col (\d+)/);
        if (colMatch) {
            const colIdx = parseInt(colMatch[1], 10);
            paramsubs[paramName] = tables[tableName][colIdx];
        } else {
            paramsubs[paramName] = columnName;
        }
    }
}

// ---------------------------------------------------------------------------
// .usr file parsing
// ---------------------------------------------------------------------------

function getActionFilesFromLR(scriptDir) {
    const basename = path.basename(scriptDir);
    const usrPath = path.join(scriptDir, basename + '.usr');

    const content = fs.readFileSync(usrPath, 'utf-8');
    const actions = [];

    for (let line of content.split('\n')) {
        line = line.replace(/\s+$/, '');
        if (line.endsWith('.c')) {
            actions.push(line.split('=').slice(1).join('='));
        }
    }

    return actions;
}

// ---------------------------------------------------------------------------
// LoadRunner function handlers
// ---------------------------------------------------------------------------

function handleWebUrl(arguments_) {
    const args = arguments_.split(',');
    const stepname = args[0].replace(/"/g, '');

    const requestData = {
        stepname,
        method: 'GET',
    };

    for (const arg of args) {
        const cleaned = arg.replace(/"/g, '');

        const urlMatch = cleaned.match(/^URL=https?:\/\/(.*?)(\/.*)/);
        if (urlMatch) {
            requestData.domain = urlMatch[1];
            requestData.path = urlMatch[2];
        }

        const modeMatch = cleaned.match(/^Mode=(.*)/);
        if (modeMatch) {
            requestData.image_parser = modeMatch[1].includes('HTML') ? 'true' : 'false';
        }
    }

    // Consume dynamic params
    requestData.params = Object.assign({}, dynamicParams);
    dynamicParams = {};

    webrequests.push(requestData);
}

function handleWebSubmitData(arguments_) {
    const args = arguments_.split(',');
    const stepname = args.shift().replace(/"/g, '');

    const requestData = { stepname };
    const itemdata = [];

    for (let arg of args) {
        arg = arg.trim().replace(/^"*/, '').replace(/"*$/, '');

        const actionMatch = arg.match(/^Action=https?:\/\/(.*?)(\/.*)/);
        if (actionMatch) {
            requestData.domain = actionMatch[1];
            requestData.path = actionMatch[2];
        }

        const modeMatch = arg.match(/^Mode=(.*)/);
        if (modeMatch) {
            requestData.image_parser = modeMatch[1].includes('HTML') ? 'true' : 'false';
        }

        const methodMatch = arg.match(/^Method=(.*)/);
        if (methodMatch) {
            requestData.method = methodMatch[1];
        }

        const nameMatch = arg.match(/^Name=(.*)/);
        if (nameMatch) {
            itemdata.push(nameMatch[1]);
        }

        const valueMatch = arg.match(/^Value=(.*)/);
        if (valueMatch) {
            itemdata.push(valueMatch[1]);
        }

        if (arg.includes('LAST') && itemdata.length > 1) {
            requestData.itemdata = itemdata.slice();
        }
    }

    // Consume dynamic params
    requestData.params = Object.assign({}, dynamicParams);
    dynamicParams = {};

    webrequests.push(requestData);
}

function handleWebCustomRequest(arguments_) {
    const args = arguments_.split(',');
    const stepname = args.shift().replace(/"/g, '');

    const requestData = { stepname };
    const itemdata = [];

    for (let arg of args) {
        arg = arg.trim().replace(/^"*/, '').replace(/"*$/, '');

        const urlMatch = arg.match(/^URL=https?:\/\/(.*?)(\/.*)/);
        if (urlMatch) {
            requestData.domain = urlMatch[1];
            requestData.path = urlMatch[2];
        }

        const modeMatch = arg.match(/^Mode=(.*)/);
        if (modeMatch) {
            requestData.image_parser = modeMatch[1].includes('HTML') ? 'true' : 'false';
        }

        const methodMatch = arg.match(/^Method=(.*)/);
        if (methodMatch) {
            requestData.method = methodMatch[1];
        }

        const bodyMatch = arg.match(/^Body=(.*)/);
        if (bodyMatch) {
            const body = bodyMatch[1];
            for (const nvpair of body.split('&')) {
                const parts = nvpair.split('=');
                itemdata.push(parts[0], parts.slice(1).join('='));
            }
        }

        if (arg.includes('LAST') && itemdata.length > 1) {
            requestData.itemdata = itemdata.slice();
        }
    }

    // Consume dynamic params
    requestData.params = Object.assign({}, dynamicParams);
    dynamicParams = {};

    webrequests.push(requestData);
}

function handleWebRegSaveParam(arguments_) {
    const args = arguments_.split(',');
    const paramname = args.shift().replace(/"/g, '');

    let lb = '';
    let rb = '';

    for (let arg of args) {
        arg = arg.trim().replace(/^"*/, '').replace(/"*$/, '');

        const lbMatch = arg.match(/^LB=(.*)/);
        if (lbMatch) lb = lbMatch[1];

        const rbMatch = arg.match(/^RB=(.*)/);
        if (rbMatch) rb = rbMatch[1];
    }

    dynamicParams[paramname] = lb + '(.*)' + rb;
    paramsubs[paramname] = paramname;
}

// ---------------------------------------------------------------------------
// Action file parsing and dispatch
// ---------------------------------------------------------------------------

function parseActionFiles(scriptDir, actions) {
    for (const action of actions) {
        const actionPath = path.join(scriptDir, action);
        let lines = fs.readFileSync(actionPath, 'utf-8').split('\n');

        // Strip whitespace and quotes from each line (mirrors Perl lines 157-163)
        lines = lines.map(line => line.trim().replace(/^"/, '').replace(/"$/, ''));

        // Join all lines and split on semicolons to get function calls
        const joined = lines.join('');
        const functions = joined.split(';');

        for (const funcStr of functions) {
            const match = funcStr.match(/(.*)\((.*)\)/s);
            if (!match) continue;

            const funcName = match[1];
            const funcArgs = match[2];

            if (funcName.includes('web_url')) {
                handleWebUrl(funcArgs);
            } else if (funcName.includes('web_submit_data')) {
                handleWebSubmitData(funcArgs);
            } else if (funcName.includes('web_custom_request')) {
                handleWebCustomRequest(funcArgs);
            } else if (funcName.includes('web_reg_save_param')) {
                handleWebRegSaveParam(funcArgs);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// JMX XML generation
// ---------------------------------------------------------------------------

function writeJmx(scriptDir) {
    const basename = path.basename(scriptDir);
    const jmxPath = path.join(scriptDir, basename + '.jmx');

    // Root structure
    const root = new XmlElement('jmeterTestPlan');
    root.set('version', '1.2');
    root.set('properties', ' 1.8');

    const rootHashtree = root.addChild('hashTree');

    // --- TestPlan ---
    const testplan = rootHashtree.addChild('TestPlan');
    testplan.set('guiclass', 'TestPlanGui');
    testplan.set('testclass', 'TestPlan');
    testplan.set('testname', 'LR2JM Test Plan: ' + scriptDir);
    testplan.set('enabled', 'true');

    addProp(testplan, 'boolProp', 'TestPlan.functional_mode', 'false');
    addProp(testplan, 'stringProp', 'TestPlan.comments');
    addProp(testplan, 'stringProp', ' TestPlan.user_define_classpath');
    addProp(testplan, 'boolProp', 'TestPlan.serialize_threadgroups', 'false');

    const elemProp = testplan.addChild('elementProp');
    elemProp.set('name', ' TestPlan.user_defined_variables');
    elemProp.set('elementType', 'Arguments');
    elemProp.set('guiclass', 'ArgumentsPanel');
    elemProp.set('testclass', 'Arguments');
    elemProp.set('testname', 'User Defined Variables');
    elemProp.set('enabled', 'true');
    addProp(elemProp, 'collectionProp', 'Arguments.arguments');

    const testplanHashtree = rootHashtree.addChild('hashTree');

    // --- ThreadGroup ---
    const threadgroup = testplanHashtree.addChild('ThreadGroup');
    threadgroup.set('guiclass', 'ThreadGroupGui');
    threadgroup.set('testclass', 'ThreadGroup');
    threadgroup.set('testname', 'LR2JM Thread Group');
    threadgroup.set('enabled', 'true');

    addProp(threadgroup, 'boolProp', 'ThreadGroup.scheduler', 'false');
    addProp(threadgroup, 'stringProp', 'ThreadGroup.num_threads', '1');
    addProp(threadgroup, 'stringProp', 'ThreadGroup.duration');
    addProp(threadgroup, 'stringProp', 'ThreadGroup.delay');
    addProp(threadgroup, 'longProp', 'ThreadGroup.start_time', '1187292555000');
    addProp(threadgroup, 'stringProp', 'ThreadGroup.on_sample_error', 'continue');
    addProp(threadgroup, 'stringProp', 'ThreadGroup.ramp_time', '1');

    const loopProp = threadgroup.addChild('elementProp');
    loopProp.set('name', 'ThreadGroup.main_controller');
    loopProp.set('elementType', 'LoopController');
    loopProp.set('guiclass', 'LoopControlPanel');
    loopProp.set('testclass', 'LoopController');
    loopProp.set('testname', 'Loop Controller');
    loopProp.set('enabled', 'true');
    addProp(loopProp, 'stringProp', 'LoopController.loops', '1');
    addProp(loopProp, 'boolProp', 'LoopController.continue_forever', 'false');

    addProp(threadgroup, 'longProp', 'ThreadGroup.end_time', '1187292555000');

    const tgHashtree = testplanHashtree.addChild('hashTree');

    // --- ConfigTestElement (HTTP Request Defaults) ---
    const config = tgHashtree.addChild('ConfigTestElement');
    config.set('guiclass', 'HttpDefaultsGui');
    config.set('testclass', 'ConfigTestElement');
    config.set('testname', 'HTTP Request Defaults');
    config.set('enabled', 'true');

    addProp(config, 'stringProp', 'HTTPSampler.domain', '');
    addProp(config, 'stringProp', 'HTTPSampler.path');
    addProp(config, 'stringProp', 'HTTPSampler.port', '80');

    const configArgs = config.addChild('elementProp');
    configArgs.set('name', 'HTTPsampler.Arguments');
    configArgs.set('elementType', 'Arguments');
    configArgs.set('guiclass', 'HTTPArgumentsPanel');
    configArgs.set('testclass', 'Arguments');
    configArgs.set('testname', 'User Defined Variables');
    configArgs.set('enabled', 'true');
    addProp(configArgs, 'collectionProp', 'Arguments.arguments');

    addProp(config, 'stringProp', 'HTTPSampler.protocol');

    tgHashtree.addChild('hashTree');

    // --- CookieManager ---
    const cookieMgr = tgHashtree.addChild('CookieManager');
    cookieMgr.set('guiclass', 'CookiePanel');
    cookieMgr.set('testclass', 'CookieManager');
    cookieMgr.set('testname', 'HTTP Cookie Manager');
    cookieMgr.set('enabled', 'true');

    addProp(cookieMgr, 'boolProp', 'CookieManager.clearEachIteration', 'false');
    addProp(cookieMgr, 'collectionProp', 'CookieManager.cookies');

    tgHashtree.addChild('hashTree');

    // --- CSVDataSet for each parameter table ---
    for (const [tableName, tabledata] of Object.entries(tables)) {
        const csvFilename = tabledata[0];
        const columns = tabledata.slice(1);

        const csvDs = tgHashtree.addChild('CSVDataSet');
        csvDs.set('guiclass', 'TestBeanGUI');
        csvDs.set('testclass', 'CSVDataSet');
        csvDs.set('testname', 'LR2JM Data Set');
        csvDs.set('enabled', 'true');

        addProp(csvDs, 'stringProp', 'delimiter', ',');
        addProp(csvDs, 'stringProp', 'fileEncoding');
        addProp(csvDs, 'stringProp', 'filename', csvFilename);
        addProp(csvDs, 'boolProp', 'recycle', 'true');
        addProp(csvDs, 'stringProp', 'variableNames', columns.join(','));

        tgHashtree.addChild('hashTree');
    }

    // --- HTTPSampler for each web request ---
    for (const requestData of webrequests) {
        const httpsampler = tgHashtree.addChild('HTTPSampler');
        const samplerHashtree = tgHashtree.addChild('hashTree');

        // RegexExtractor for each dynamic param
        const params = requestData.params || {};
        for (const [paramName, regex] of Object.entries(params)) {
            const extractor = samplerHashtree.addChild('RegexExtractor');
            extractor.set('guiclass', 'RegexExtractorGui');
            extractor.set('testclass', 'RegexExtractor');
            extractor.set('testname', 'LR2JM Regex Extractor');
            extractor.set('enabled', 'true');

            addProp(extractor, 'stringProp', 'RegexExtractor.useHeaders', 'false');
            addProp(extractor, 'stringProp', 'RegexExtractor.refname', paramName);
            addProp(extractor, 'stringProp', 'RegexExtractor.regex', regex);
            addProp(extractor, 'stringProp', 'RegexExtractor.template', '$1$');
            addProp(extractor, 'stringProp', 'RegexExtractor.default');
            addProp(extractor, 'stringProp', 'RegexExtractor.match_number', '1');

            samplerHashtree.addChild('hashTree');
        }

        // HTTPSampler attributes
        httpsampler.set('guiclass', 'HttpTestSampleGui');
        httpsampler.set('testclass', 'HTTPSampler');
        httpsampler.set('testname', requestData.stepname || '');
        httpsampler.set('enabled', 'true');

        // Arguments elementProp
        const argsProp = httpsampler.addChild('elementProp');
        argsProp.set('name', 'HTTPsampler.Arguments');
        argsProp.set('elementType', 'Arguments');
        argsProp.set('guiclass', 'HTTPArgumentsPanel');
        argsProp.set('testclass', 'Arguments');
        argsProp.set('enabled', 'true');

        const collection = addProp(argsProp, 'collectionProp', 'Arguments.arguments');

        // Form data / item data
        const itemdata = requestData.itemdata || [];
        for (let i = 0; i < itemdata.length - 1; i += 2) {
            const name = paramSubstitution(itemdata[i]);
            const value = paramSubstitution(itemdata[i + 1]);

            const httpArg = collection.addChild('elementProp');
            httpArg.set('name', '');
            httpArg.set('elementType', 'HTTPArgument');

            addProp(httpArg, 'boolProp', 'HTTPArgument.always_encode', 'false');
            addProp(httpArg, 'stringProp', 'Argument.value', value);
            addProp(httpArg, 'stringProp', 'Argument.metadata', '=');
            addProp(httpArg, 'boolProp', 'HTTPArgument.use_equals', 'true');
            addProp(httpArg, 'stringProp', 'Argument.name', name);
        }

        // Standard sampler properties
        addProp(httpsampler, 'stringProp', 'HTTPSampler.domain', requestData.domain || '');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.port');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.protocol');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.method', requestData.method || '');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.contentEncoding');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.path',
            paramSubstitution(requestData.path || ''));
        addProp(httpsampler, 'boolProp', 'HTTPSampler.follow_redirects', 'true');
        addProp(httpsampler, 'boolProp', 'HTTPSampler.auto_redirects', 'true');
        addProp(httpsampler, 'boolProp', 'HTTPSampler.use_keepalive', 'true');
        addProp(httpsampler, 'boolProp', 'HTTPSampler.DO_MULTIPART_POST', 'false');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.mimetype');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.FILE_NAME');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.FILE_FIELD');
        addProp(httpsampler, 'boolProp', 'HTTPSampler.image_parser',
            requestData.image_parser || 'false');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.monitor', 'true');
        addProp(httpsampler, 'stringProp', 'HTTPSampler.embedded_url_re');
    }

    // Write XML
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + root.toString(0) + '\n';
    fs.writeFileSync(jmxPath, xml);

    printMessage('JMeter test plan created: ' + jmxPath, 'green');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    try {
        const scriptDir = readArguments();

        getParametersFromLR(scriptDir);

        const actions = getActionFilesFromLR(scriptDir);
        parseActionFiles(scriptDir, actions);
        writeJmx(scriptDir);

    } catch (err) {
        if (err.code === 'ENOENT') {
            printMessage(err.message, 'red');
        } else {
            printMessage('Error: ' + err.message, 'red');
            throw err;
        }
    }
}

main();
