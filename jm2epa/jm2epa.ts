#!/usr/bin/env ts-node
/**
 * jm2epa.ts — Convert JMeter .jmx plans to Eggplant Performance .epa archives.
 *
 * TypeScript port of jm2epa.js (and jm2epa.py). Node.js stdlib only (`fs`,
 * `path`, `zlib`, `crypto`). Same IR shape and output as the Python/JS ports,
 * so running any converter on the same JMX with the same `--seed` produces
 * byte-identical archives.
 *
 * Usage:
 *     npx ts-node jm2epa.ts <plan.jmx> [--name Script] [--namespace com.testplant.testing]
 *                                      [--out dist/] [--seed N]
 *     # or compile first:
 *     tsc jm2epa.ts && node jm2epa.js <plan.jmx>
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HostEntry {
    key: string;
    port: string;
    protocol: string;
}

interface CsvSpec {
    file: string;
    delimiter: string;
    columns: string[];
}

interface Extractor {
    kind: 'boundary' | 'regex' | 'jsonpath';
    name: string;
    lb?: string;
    rb?: string;
    regex?: string;
    template?: string;
    path?: string;
    match?: number;
}

interface Assertion {
    kind: 'status' | 'text';
    expected?: number;
    substrings?: string[];
}

interface Body {
    kind: 'form' | 'raw';
    parts?: Array<[string, string]>;
    content?: string;
    content_type?: string;
}

interface Step {
    request_id: number;
    name: string;
    method: string;
    path: string;
    host_key: string | null;
    query: Array<[string, string]>;
    body: Body | null;
    headers: Array<[string, string]>;
    extractors: Extractor[];
    asserts: Assertion[];
    post_pause_ms: number | null;
}

interface Action {
    name: string;
    steps: Step[];
}

interface PreState {
    default_headers: Array<[string, string]>;
    default_user_agent: string | null;
    seed_cookies: Array<[string, string]>;
    user_vars: Record<string, string>;
    include_hosts: string[];
}

interface Ir {
    script_name: string;
    namespace: string;
    vu_type: string;
    pre: PreState;
    hosts: Record<string, HostEntry>;
    profile_csvs: CsvSpec[];
    actions: Action[];
}

interface CliArgs {
    jmx: string | null;
    name: string | null;
    namespace: string;
    outDir: string;
    seed: number | null;
}

interface ZipEntry { name: string; data: Buffer; }

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function printMessage(message: string, color?: 'red' | 'green' | 'yellow'): void {
    const colors: Record<string, string> = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m' };
    const reset = '\x1b[0m';
    console.log((color && colors[color] ? colors[color] : '') + message + reset);
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-UUID source
// ---------------------------------------------------------------------------
class UuidSource {
    private counter = 1000;
    constructor(private seed: number | null) {}
    next(): string {
        if (this.seed !== null) {
            this.counter += 1;
            const hex = this.counter.toString(16).padStart(12, '0');
            return `00000000-0000-0000-0000-${hex}`;
        }
        const bytes = crypto.randomBytes(16);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const h = bytes.toString('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    }
}

// ---------------------------------------------------------------------------
// Minimal XML parser
// ---------------------------------------------------------------------------
class XmlNode {
    tag: string;
    attrs: Record<string, string> = {};
    children: XmlNode[] = [];
    text = '';
    constructor(tag: string) { this.tag = tag; }
    get(attr: string): string | undefined { return this.attrs[attr]; }
    findAll(tag: string): XmlNode[] { return this.children.filter(c => c.tag === tag); }
    find(tag: string): XmlNode | undefined { return this.children.find(c => c.tag === tag); }
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_: string, n: string) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&amp;/g, '&');
}

function parseXml(src: string): XmlNode {
    src = src.replace(/<\?xml[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const stack: XmlNode[] = [];
    const root = new XmlNode('#root');
    stack.push(root);
    let i = 0;
    while (i < src.length) {
        const lt = src.indexOf('<', i);
        if (lt < 0) break;
        if (lt > i) {
            const txt = src.slice(i, lt);
            if (txt.trim()) stack[stack.length - 1].text += decodeEntities(txt);
        }
        const gt = src.indexOf('>', lt);
        if (gt < 0) throw new Error('Unterminated tag at ' + lt);
        let raw = src.slice(lt + 1, gt);
        const closing = raw.startsWith('/');
        const selfClosing = raw.endsWith('/');
        if (closing) { stack.pop(); i = gt + 1; continue; }
        if (selfClosing) raw = raw.slice(0, -1);
        const tagMatch = /^([A-Za-z_:][\w:.\-]*)/.exec(raw);
        if (!tagMatch) { i = gt + 1; continue; }
        const tag = tagMatch[1];
        const attrStr = raw.slice(tag.length);
        const node = new XmlNode(tag);
        const attrRe = /([A-Za-z_:][\w:.\-]*)\s*=\s*"([^"]*)"/g;
        let m: RegExpExecArray | null;
        while ((m = attrRe.exec(attrStr)) !== null) {
            node.attrs[m[1]] = decodeEntities(m[2]);
        }
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
        i = gt + 1;
    }
    return root;
}

function iterChildren(hashTree: XmlNode): Array<[XmlNode, XmlNode]> {
    const out: Array<[XmlNode, XmlNode]> = [];
    const cs = hashTree.children;
    let i = 0;
    while (i < cs.length) {
        const elem = cs[i];
        if (elem.tag === 'hashTree') { i += 1; continue; }
        let sibling: XmlNode;
        if (i + 1 < cs.length && cs[i + 1].tag === 'hashTree') {
            sibling = cs[i + 1]; i += 2;
        } else {
            sibling = new XmlNode('hashTree'); i += 1;
        }
        out.push([elem, sibling]);
    }
    return out;
}

function propText(elem: XmlNode, name: string, def = ''): string {
    for (const c of elem.children) {
        if (c.tag.endsWith('Prop') && c.get('name') === name) return (c.text || '').trim();
    }
    return def;
}

function propBool(elem: XmlNode, name: string, def: boolean): boolean {
    for (const c of elem.children) {
        if (c.tag === 'boolProp' && c.get('name') === name) {
            return (c.text || '').trim().toLowerCase() === 'true';
        }
    }
    return def;
}

// ---------------------------------------------------------------------------
// IR building
// ---------------------------------------------------------------------------
function registerHost(ir: Ir, domain: string, port: string, protocol: string): string | null {
    if (!domain) return null;
    const proto = (protocol || 'http').toLowerCase();
    const p = port || (proto === 'https' ? '443' : '80');
    const key = domain.replace(/[^A-Za-z0-9]/g, '_');
    if (!(domain in ir.hosts)) {
        ir.hosts[domain] = { key, port: p, protocol: proto };
        ir.pre.include_hosts.push(domain);
    }
    return key;
}

function parseHeaderManager(elem: XmlNode, headers: Array<[string, string]>): void {
    for (const coll of elem.findAll('collectionProp')) {
        if (coll.get('name') !== 'HeaderManager.headers') continue;
        for (const ep of coll.findAll('elementProp')) {
            const n = propText(ep, 'Header.name');
            const v = propText(ep, 'Header.value');
            if (n) headers.push([n, v]);
        }
    }
}

function parseRegexExtractor(elem: XmlNode): Extractor | null {
    const name = propText(elem, 'RegexExtractor.refname');
    const regex = propText(elem, 'RegexExtractor.regex');
    const template = propText(elem, 'RegexExtractor.template', '$1$');
    let match = parseInt(propText(elem, 'RegexExtractor.match_number', '1'), 10);
    if (isNaN(match)) match = 1;
    if (!name || !regex) return null;
    const m = /^(.+?)\(\.\*\??\)(.+?)$/.exec(regex);
    if (m && template === '$1$') {
        return { kind: 'boundary', name, lb: m[1], rb: m[2], match };
    }
    return { kind: 'regex', name, regex, template, match };
}

function parseBoundaryExtractor(elem: XmlNode): Extractor | null {
    const name = propText(elem, 'BoundaryExtractor.refname');
    const lb = propText(elem, 'BoundaryExtractor.lboundary');
    const rb = propText(elem, 'BoundaryExtractor.rboundary');
    if (!name || !lb || !rb) return null;
    let match = parseInt(propText(elem, 'BoundaryExtractor.match_number', '1'), 10);
    if (isNaN(match)) match = 1;
    return { kind: 'boundary', name, lb, rb, match };
}

function parseJsonPostProcessor(elem: XmlNode): Extractor | null {
    const name = propText(elem, 'JSONPostProcessor.referenceNames');
    const jp = propText(elem, 'JSONPostProcessor.jsonPathExprs');
    if (!name || !jp) return null;
    return { kind: 'jsonpath', name, path: jp };
}

function parseResponseAssertion(elem: XmlNode): Assertion | null {
    const field = propText(elem, 'Assertion.test_field');
    const strings: string[] = [];
    for (const coll of elem.findAll('collectionProp')) {
        if (coll.get('name') === 'Asserion.test_strings' || coll.get('name') === 'Assertion.test_strings') {
            for (const sp of coll.findAll('stringProp')) {
                if ((sp.text || '').trim()) strings.push(sp.text.trim());
            }
        }
    }
    if (field === 'Assertion.response_code' && strings.length) {
        const n = parseInt(strings[0], 10);
        if (!isNaN(n)) return { kind: 'status', expected: n };
    }
    if (strings.length) return { kind: 'text', substrings: strings };
    return null;
}

function parseTimer(elem: XmlNode): number | null {
    if (elem.tag === 'ConstantTimer') {
        const n = parseInt(propText(elem, 'ConstantTimer.delay', '0'), 10);
        return isNaN(n) ? null : n;
    }
    if (elem.tag === 'UniformRandomTimer') {
        const base = parseInt(propText(elem, 'ConstantTimer.delay', '0'), 10) || 0;
        const range = parseInt(propText(elem, 'RandomTimer.range', '0'), 10) || 0;
        return base + Math.floor(range / 2);
    }
    if (elem.tag === 'GaussianRandomTimer') {
        const n = parseInt(propText(elem, 'ConstantTimer.delay', '0'), 10);
        return isNaN(n) ? null : n;
    }
    return null;
}

function parseHttpSampler(ir: Ir, sElem: XmlNode, sHt: XmlNode, reqCounter: { n: number }): Step {
    const step: Step = {
        request_id: reqCounter.n++,
        name: sElem.get('testname') || `Request${reqCounter.n}`,
        method: (propText(sElem, 'HTTPSampler.method') || 'GET').toUpperCase(),
        path: propText(sElem, 'HTTPSampler.path') || '/',
        host_key: null,
        query: [],
        body: null,
        headers: [],
        extractors: [],
        asserts: [],
        post_pause_ms: null,
    };
    let domain = propText(sElem, 'HTTPSampler.domain');
    const port = propText(sElem, 'HTTPSampler.port');
    const protocol = propText(sElem, 'HTTPSampler.protocol');
    if (!domain && Object.keys(ir.hosts).length > 0) {
        domain = Object.keys(ir.hosts)[0];
    }
    step.host_key = registerHost(ir, domain, port, protocol);

    let postBodyRaw = propBool(sElem, 'HTTPSampler.postBodyRaw', false);
    const args: Array<[string, string]> = [];
    let argsEp: XmlNode | null = null;
    for (const ep of sElem.children) {
        if (ep.tag === 'elementProp' && ep.get('name') === 'HTTPsampler.Arguments') {
            argsEp = ep; break;
        }
    }
    if (argsEp) {
        if (!postBodyRaw) postBodyRaw = propBool(argsEp, 'HTTPSampler.postBodyRaw', false);
        for (const coll of argsEp.findAll('collectionProp')) {
            if (coll.get('name') !== 'Arguments.arguments') continue;
            for (const ep of coll.findAll('elementProp')) {
                const n = propText(ep, 'Argument.name', '');
                const v = propText(ep, 'Argument.value', '');
                args.push([n, v]);
            }
        }
    }

    if (step.path.includes('?')) {
        const idx = step.path.indexOf('?');
        const qs = step.path.slice(idx + 1);
        step.path = step.path.slice(0, idx);
        for (const pair of qs.split('&')) {
            const eq = pair.indexOf('=');
            if (eq >= 0) step.query.push([pair.slice(0, eq), pair.slice(eq + 1)]);
            else step.query.push([pair, '']);
        }
    }

    if (step.method === 'GET') {
        for (const a of args) step.query.push(a);
    } else if (postBodyRaw) {
        const raw = args.length ? args[0][1] : '';
        const ct = /^\s*[{[]/.test(raw) ? 'application/json' : 'text/plain';
        step.body = { kind: 'raw', content: raw, content_type: ct };
    } else if (args.length) {
        step.body = { kind: 'form', parts: args };
    }

    for (const [c, _cHt] of iterChildren(sHt)) {
        const t = c.tag;
        if (t === 'HeaderManager') parseHeaderManager(c, step.headers);
        else if (t === 'RegexExtractor') { const x = parseRegexExtractor(c); if (x) step.extractors.push(x); }
        else if (t === 'BoundaryExtractor') { const x = parseBoundaryExtractor(c); if (x) step.extractors.push(x); }
        else if (t === 'JSONPostProcessor') { const x = parseJsonPostProcessor(c); if (x) step.extractors.push(x); }
        else if (t === 'ResponseAssertion') { const a = parseResponseAssertion(c); if (a) step.asserts.push(a); }
        else if (t === 'ConstantTimer' || t === 'UniformRandomTimer' || t === 'GaussianRandomTimer') {
            step.post_pause_ms = parseTimer(c);
        }
    }
    if (!step.asserts.some(a => a.kind === 'status')) {
        step.asserts.push({ kind: 'status', expected: 200 });
    }
    return step;
}

function parseCsvDataSet(ir: Ir, elem: XmlNode): void {
    const filename = propText(elem, 'filename');
    const names = propText(elem, 'variableNames');
    const delim = propText(elem, 'delimiter', ',');
    if (!filename || !names) return;
    const cols = names.split(',').map(s => s.trim()).filter(Boolean);
    for (const c of cols) ir.pre.user_vars[c] = '';
    ir.profile_csvs.push({ file: path.basename(filename), delimiter: delim, columns: cols });
}

function parseCookieManager(ir: Ir, elem: XmlNode): void {
    for (const coll of elem.findAll('collectionProp')) {
        if (coll.get('name') !== 'CookieManager.cookies') continue;
        for (const ep of coll.findAll('elementProp')) {
            const n = propText(ep, 'Cookie.name') || ep.get('name') || '';
            const v = propText(ep, 'Cookie.value');
            if (n) ir.pre.seed_cookies.push([n, v]);
        }
    }
}

function parseHttpDefaults(ir: Ir, elem: XmlNode): void {
    const domain = propText(elem, 'HTTPSampler.domain');
    const port = propText(elem, 'HTTPSampler.port');
    const protocol = propText(elem, 'HTTPSampler.protocol');
    if (domain) registerHost(ir, domain, port, protocol);
}

function walkTgChildren(ir: Ir, tgHt: XmlNode, reqCounter: { n: number }, defaultAction: Action): void {
    for (const [c, cHt] of iterChildren(tgHt)) {
        const t = c.tag;
        if (t === 'ConfigTestElement') parseHttpDefaults(ir, c);
        else if (t === 'CookieManager') parseCookieManager(ir, c);
        else if (t === 'HeaderManager') parseHeaderManager(c, ir.pre.default_headers);
        else if (t === 'CSVDataSet') parseCsvDataSet(ir, c);
        else if (t === 'UserDefinedVariables' || t === 'Arguments') {
            for (const coll of c.findAll('collectionProp')) {
                if (coll.get('name') !== 'Arguments.arguments') continue;
                for (const ep of coll.findAll('elementProp')) {
                    const n = propText(ep, 'Argument.name');
                    const v = propText(ep, 'Argument.value');
                    if (n) ir.pre.user_vars[n] = v;
                }
            }
        } else if (t === 'HTTPSampler' || t === 'HTTPSamplerProxy') {
            const step = parseHttpSampler(ir, c, cHt, reqCounter);
            defaultAction.steps.push(step);
        } else if (t === 'TransactionController') {
            const action: Action = { name: c.get('testname') || `Tx${ir.actions.length + 1}`, steps: [] };
            ir.actions.push(action);
            walkTgChildren(ir, cHt, reqCounter, action);
        } else if (t === 'GenericController' || t === 'IfController' ||
                   t === 'LoopController' || t === 'WhileController' ||
                   t === 'OnceOnlyController' || t === 'ForeachController') {
            walkTgChildren(ir, cHt, reqCounter, defaultAction);
        }
    }
}

function buildIr(jmxPath: string, scriptName: string, namespace: string): Ir {
    const src = fs.readFileSync(jmxPath, 'utf8');
    const root = parseXml(src);
    const tp = root.find('jmeterTestPlan');
    if (!tp) throw new Error('Not a JMeter .jmx file');
    const tpHt = tp.find('hashTree');
    if (!tpHt) throw new Error('Malformed JMX: missing top-level <hashTree>');

    const ir: Ir = {
        script_name: scriptName,
        namespace,
        vu_type: scriptName + 'VU',
        pre: {
            default_headers: [],
            default_user_agent: null,
            seed_cookies: [],
            user_vars: {},
            include_hosts: [],
        },
        hosts: {},
        profile_csvs: [],
        actions: [],
    };

    const defaultAction: Action = { name: 'Main', steps: [] };
    ir.actions.push(defaultAction);
    const reqCounter = { n: 1 };

    for (const [elem, ht] of iterChildren(tpHt)) {
        if (elem.tag !== 'TestPlan') continue;

        for (const ep of elem.findAll('elementProp')) {
            const epName = (ep.get('name') || '').trim();
            if (epName === 'TestPlan.user_defined_variables') {
                for (const coll of ep.findAll('collectionProp')) {
                    if (coll.get('name') !== 'Arguments.arguments') continue;
                    for (const ap of coll.findAll('elementProp')) {
                        const n = propText(ap, 'Argument.name');
                        const v = propText(ap, 'Argument.value');
                        if (n) ir.pre.user_vars[n] = v;
                    }
                }
            }
        }

        for (const [child, childHt] of iterChildren(ht)) {
            const t = child.tag;
            if (t === 'ThreadGroup' || t === 'SetupThreadGroup' ||
                t === 'PostThreadGroup' || t.endsWith('ThreadGroup')) {
                walkTgChildren(ir, childHt, reqCounter, defaultAction);
            } else if (t === 'HeaderManager') {
                parseHeaderManager(child, ir.pre.default_headers);
            } else if (t === 'ConfigTestElement') {
                parseHttpDefaults(ir, child);
            } else if (t === 'CookieManager') {
                parseCookieManager(ir, child);
            } else if (t === 'CSVDataSet') {
                parseCsvDataSet(ir, child);
            } else if (t === 'Arguments') {
                for (const coll of child.findAll('collectionProp')) {
                    if (coll.get('name') !== 'Arguments.arguments') continue;
                    for (const ap of coll.findAll('elementProp')) {
                        const n = propText(ap, 'Argument.name');
                        const v = propText(ap, 'Argument.value');
                        if (n) ir.pre.user_vars[n] = v;
                    }
                }
            }
        }
    }

    if (ir.actions[0].steps.length === 0) ir.actions.shift();
    if (ir.actions.length === 0) ir.actions.push({ name: 'Main', steps: [] });

    return ir;
}

// ---------------------------------------------------------------------------
// C# emitter
// ---------------------------------------------------------------------------
function csEscape(s: string): string {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

function csStringLiteral(s: string | null | undefined): string {
    if (s === null || s === undefined) return '""';
    if (!s.includes('${')) return '"' + csEscape(s) + '"';
    const parts: string[] = [];
    const re = /\$\{([^}]+)\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
        if (m.index > last) parts.push('"' + csEscape(s.slice(last, m.index)) + '"');
        parts.push(`GetString("${csEscape(m[1])}")`);
        last = m.index + m[0].length;
    }
    if (last < s.length) parts.push('"' + csEscape(s.slice(last)) + '"');
    if (parts.length === 0) return '""';
    if (parts.length === 1) return parts[0];
    return parts.join(' + ');
}

function sanitizeIdent(name: string): string {
    let s = name.replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z_]/.test(s)) s = '_' + s;
    return s;
}

function emitScriptCs(ir: Ir): string {
    const lines: string[] = [];
    const w = (s: string) => lines.push(s);
    const ns = ir.namespace;
    const vu = ir.vu_type;
    const name = ir.script_name;

    w('// Script Created by jm2epa');
    w('// Generated from JMeter .jmx');
    w('');
    w('using System;');
    w('using System.Collections.Generic;');
    w('using System.Text;');
    w('');
    w('using Facilita.Native;');
    w('using Facilita.Web;');
    w('using Facilita.Fc.Runtime;');
    w('using Facilita.Fc.Runtime.BackgroundScripting;');
    w('');
    w('#region EPP_IMPORTS');
    w('');
    w('// Code added here will be preserved during script regeneration');
    w('');
    w('#endregion EPP_IMPORTS');
    w('');
    w(`using AVirtualUserScript = ${ns}.${vu}Script;`);
    w('');
    w(`namespace ${ns}`);
    w('{');
    w(`\tpublic class ${name} : AVirtualUserScript`);
    w('\t{');
    w('');
    w('\t\t// Generated variables');
    for (const host of Object.keys(ir.hosts)) {
        const h = ir.hosts[host];
        w(`\t\tIpEndPoint ${h.key} = null;  // parameterised web server address`);
    }
    w('\t\tProtocol protocol1 = null;  // parameterised protocol');
    w('\t\t// End of generated variables');
    w('');
    w('\t\t#region EPP_GLOBAL_VARIABLES');
    w('');
    w('\t\t// Code added here will be preserved during script regeneration');
    w('');
    w('\t\t#endregion EPP_GLOBAL_VARIABLES');
    w('');
    w('\t\tpublic override void Pre()');
    w('\t\t{');
    w('\t\t\tbase.Pre();');
    w('');
    w('\t\t\t// START INITIALISATION CODE');
    w('\t\t\tWebBrowser.DefaultFollowRedirects = true;');
    w('\t\t\tWebBrowser.HostFilteringMode = HostFilteringMode.ALLOWLIST;');
    for (const [k, v] of ir.pre.default_headers) {
        w(`\t\t\tWebBrowser.DefaultHeaders.Add(${csStringLiteral(k)}, ${csStringLiteral(v)});`);
    }
    w('\t\t\t// END INITIALISATION CODE');
    w('');
    w('\t\t\t#region EPP_PRE');
    w('');
    w('\t\t\t// Code added here will be preserved during script regeneration');
    w('');
    w('\t\t\t#endregion EPP_PRE');
    w('\t\t}');
    w('');
    w('\t\tpublic override void Script()');
    w('\t\t{');
    const firstProto = Object.values(ir.hosts)[0]?.protocol || 'http';
    for (const host of Object.keys(ir.hosts)) {
        const h = ir.hosts[host];
        w(`\t\t\t${h.key} = new IpEndPoint(GetString("${h.key}Host", "${host}"), GetInt("${h.key}Port", ${h.port}));`);
    }
    w(`\t\t\tprotocol1 = GetProtocol("protocol1", "${firstProto}");`);
    w('');
    for (const host of Object.keys(ir.hosts)) {
        const h = ir.hosts[host];
        w(`\t\t\tWebBrowser.IncludeHost(GetString("${h.key}Host", "${host}"));`);
    }
    w('');
    ir.actions.forEach((a, idx) => {
        w(`\t\t\tAction${idx + 1}_${sanitizeIdent(a.name)}();`);
    });
    w('');
    w('\t\t\t#region EPP_SCRIPT');
    w('');
    w('\t\t\t// Code added here will be preserved during script regeneration');
    w('');
    w('\t\t\t#endregion EPP_SCRIPT');
    w('\t\t}');
    w('');

    ir.actions.forEach((a, idx) => emitAction(w, a, idx + 1, ir));

    w('\t}');
    w('}');
    return lines.join('\n') + '\n';
}

function emitAction(w: (s: string) => void, action: Action, idx: number, ir: Ir): void {
    const mname = `Action${idx}_${sanitizeIdent(action.name)}`;
    const txName = action.name;
    w(`\t\tvoid ${mname}()`);
    w('\t\t{');
    w(`\t\t\t#region EPP_BEFORE_START_TRANSACTION for Transaction "${txName}"`);
    w('');
    w('\t\t\t// Code added here will be preserved during script regeneration');
    w('');
    w(`\t\t\t#endregion EPP_BEFORE_START_TRANSACTION for Transaction "${txName}"`);
    w('');
    w(`\t\t\tStartTransaction("${txName}");`);
    w('');
    for (const step of action.steps) emitStep(w, step, ir);
    w(`\t\t\t#region EPP_BEFORE_END_TRANSACTION for Transaction "${txName}"`);
    w('');
    w('\t\t\t// Code added here will be preserved during script regeneration');
    w('');
    w(`\t\t\t#endregion EPP_BEFORE_END_TRANSACTION for Transaction "${txName}"`);
    w('');
    w(`\t\t\tEndTransaction("${txName}");`);
    w('\t\t}');
    w('');
}

function emitStep(w: (s: string) => void, step: Step, ir: Ir): void {
    const rid = step.request_id;
    const method = step.method;
    const hostKey = step.host_key || '';
    const hostEntry = Object.entries(ir.hosts).find(([, h]) => h.key === hostKey);
    const host = hostEntry ? hostEntry[0] : '';
    const urlVar = `url${rid}`;
    const pathExpr = csStringLiteral(step.path);

    w(`\t\t\t// ====================================================================================================================================`);
    w(`\t\t\t// Request: ${rid}, ${method}, ${host}${step.path}, ${step.name}`);
    w(`\t\t\t// ====================================================================================================================================`);

    if (step.query.length > 0) {
        w(`\t\t\tUrl ${urlVar} = new Url(protocol1, ${hostKey}, ${pathExpr});`);
        const qd = `queryData${rid}`;
        w(`\t\t\tQueryData ${qd} = new QueryData();`);
        for (const [k, v] of step.query) {
            w(`\t\t\t${qd}.Add(${csStringLiteral(k)}, ${csStringLiteral(v)});`);
        }
        w(`\t\t\t${urlVar} = ${urlVar}.WithQuery(${qd});`);
    } else {
        w(`\t\t\tUrl ${urlVar} = new Url(protocol1, ${hostKey}, ${pathExpr});`);
    }

    const reqVar = `request${rid}`;
    const respVar = `response${rid}`;
    w(`\t\t\tusing (Request ${reqVar} = WebBrowser.CreateRequest(HttpMethod.${method}, ${urlVar}, ${rid}))`);
    w('\t\t\t{');

    for (const [k, v] of step.headers) {
        w(`\t\t\t\t${reqVar}.SetHeader(${csStringLiteral(k)}, ${csStringLiteral(v)});`);
    }

    if (step.body) {
        if (step.body.kind === 'form' && step.body.parts) {
            const pv = `postData${rid}`;
            w(`\t\t\t\tForm ${pv} = new Form();`);
            w(`\t\t\t\t${pv}.CharEncoding = Encoding.GetEncoding("utf-8");`);
            for (const [k, v] of step.body.parts) {
                w(`\t\t\t\t${pv}.AddElement(new InputElement(${csStringLiteral(k)}, ${csStringLiteral(v)}, Encoding.GetEncoding("utf-8")));`);
            }
            w(`\t\t\t\t${reqVar}.SetMessageBody(${pv});`);
        } else if (step.body.kind === 'raw') {
            const expr = csStringLiteral(step.body.content || '');
            w(`\t\t\t\tstring postDataString${rid} = ${expr};`);
            w(`\t\t\t\t${reqVar}.SetMessageBody(postDataString${rid});`);
        }
    }

    w('');
    w(`\t\t\t\t#region EPP_BEFORE_REQUEST_SENT for Request ${rid}`);
    w('');
    w('\t\t\t\t// Code added here will be preserved during script regeneration');
    w('');
    w(`\t\t\t\t#endregion EPP_BEFORE_REQUEST_SENT for Request ${rid}`);
    w('');
    w(`\t\t\t\tusing (Response ${respVar} = ${reqVar}.Send())`);
    w('\t\t\t\t{');
    w(`\t\t\t\t\t#region EPP_AFTER_RESPONSE_RECEIVED for Request ${rid}`);
    w('');
    w('\t\t\t\t\t// Code added here will be preserved during script regeneration');
    w('');
    w(`\t\t\t\t\t#endregion EPP_AFTER_RESPONSE_RECEIVED for Request ${rid}`);
    w('');
    let cursorEmitted = false;
    for (const ex of step.extractors) {
        if (ex.kind === 'boundary' && ex.lb && ex.rb) {
            if (!cursorEmitted) {
                w(`\t\t\t\t\tExtractionCursor extractionCursor${rid} = new ExtractionCursor();`);
                cursorEmitted = true;
            }
            w(`\t\t\t\t\tSet<string>("${csEscape(ex.name)}", ${respVar}.Extract(extractionCursor${rid}, ${csStringLiteral(ex.lb)}, ${csStringLiteral(ex.rb)}, ActionType.ACT_WARNING, true, SearchFlags.SEARCH_IN_BODY));`);
        } else if (ex.kind === 'regex') {
            w(`\t\t\t\t\t// TODO jm2epa: regex extractor for "${ex.name}" - JMeter regex: ${ex.regex}`);
            w(`\t\t\t\t\t// Consider refactoring to Response.Extract(cursor, LB, RB, ...) in Facilita.Web idiom.`);
            w(`\t\t\t\t\tSet<string>("${csEscape(ex.name)}", "");  // TODO: port regex manually`);
        } else if (ex.kind === 'jsonpath') {
            w(`\t\t\t\t\t// TODO jm2epa: JSONPath extractor for "${ex.name}" - path: ${ex.path}`);
            w(`\t\t\t\t\tSet<string>("${csEscape(ex.name)}", "");  // TODO: port JSONPath manually`);
        }
    }
    for (const a of step.asserts) {
        if (a.kind === 'status') {
            const status = a.expected === 200 ? 'HttpStatus.OK' : `(HttpStatus)${a.expected}`;
            w(`\t\t\t\t\t${respVar}.VerifyResult(${status}, ActionType.ACT_WARNING);`);
        } else if (a.kind === 'text' && a.substrings) {
            for (const sub of a.substrings) {
                w(`\t\t\t\t\t${respVar}.VerifyContains(${csStringLiteral(sub)}, ActionType.ACT_WARNING);`);
            }
        }
    }
    w('\t\t\t\t}');
    w('\t\t\t}');
    w('');
    if (step.post_pause_ms && step.post_pause_ms > 0) {
        w(`\t\t\tPause(${step.post_pause_ms});`);
        w('');
    }
}

// ---------------------------------------------------------------------------
// Stock VU / metadata emitters
// ---------------------------------------------------------------------------
function emitVuCs(ir: Ir): string {
    return `using System;
using System.Collections.Generic;
using System.Text;

using Facilita.Native;
using Facilita.Web;
using Facilita.Fc.Runtime;
using Facilita.Fc.Runtime.BackgroundScripting;

using AVirtualUser = Facilita.Web.WebBrowserVirtualUser;

namespace ${ir.namespace}
{
\tpublic class ${ir.vu_type} : AVirtualUser
\t{
\t\tpublic ${ir.vu_type}()
\t\t{
\t\t}

\t\tprotected override void Pre()
\t\t{
\t\t\tbase.Pre();
\t\t}

\t\tprotected override void Post()
\t\t{
\t\t\tbase.Post();
\t\t}

\t\tpublic override void PrepareRequest(Request request)
\t\t{
\t\t\tbase.PrepareRequest(request);
\t\t}

\t\tpublic override void ProcessResponse(Response response)
\t\t{
\t\t\tbase.ProcessResponse(response);
\t\t}

\t\tprotected override bool OnError(string id, string info)
\t\t{
\t\t\treturn base.OnError(id, info);
\t\t}

\t\tprotected override bool OnWarn(string id, string info)
\t\t{
\t\t\treturn base.OnWarn(id, info);
\t\t}

\t\tprotected override bool OnException(Exception e)
\t\t{
\t\t\treturn base.OnException(e);
\t\t}
\t}
}
`;
}

function emitVuScriptCs(ir: Ir): string {
    return `using System;
using System.Collections.Generic;
using System.Text;

using Facilita.Native;
using Facilita.Web;
using Facilita.Fc.Runtime;
using Facilita.Fc.Runtime.BackgroundScripting;

using AVirtualUserScript = Facilita.Web.WebBrowserScript;

namespace ${ir.namespace}
{
\tpublic abstract class ${ir.vu_type}Script : AVirtualUserScript
\t{
\t\tpublic new ${ir.vu_type} VU
\t\t{
\t\t\tget { return (${ir.vu_type})(((Facilita.Web.WebBrowserScript)this).VU); }
\t\t}

\t\tpublic override void Pre()
\t\t{
\t\t\tbase.Pre();
\t\t}
\t}
}
`;
}

function emitVuTypeIni(ir: Ir, vuId: string): string {
    return `[object]
maxVUPerEngine = 500
scriptExtension = '.cs'
description = '${ir.vu_type}'
templateName = 'WebBrowserScript.cs'
scriptPackageName = '${ir.namespace}'
monitorAssembly = 'Facilita.Fc.TestController.Controller'
abstractTemplateName = 'WebBrowserScript_S.cs'
vuTemplateName = 'webVU.cs'
folderName = 'Web'
className = '${ir.namespace}.${ir.vu_type}'
metaKey = 'WebCLRVUType'
extends = 'CSWebBrowserUser'
recommendedVusPerInjector = 500
_id_ = '${vuId}'
engineTypeName = 'clr'
scriptClassName = '${ir.namespace}.${ir.vu_type}Script'
name = '${ir.vu_type}'
`;
}

function emitProfileIni(ir: Ir, defaultId: string, altId: string): string {
    return `[item.default]
eventLogClass = 'Facilita.Fc.Runtime.FileEventLog'
engineProfileName = 'intel.win32.clr4_5'
builderName = ''
metaKey = 'CLRVUProfile'
environmentVariables = {}
name = 'default'
vuTypeName = '${ir.vu_type}'
nullEventLogClass = 'Facilita.Fc.Runtime.NullEventLog'
_id_ = '${defaultId}'
initialisers = ['Facilita.Web.WebBrowserUserInitialiser']
monitorClass = 'Facilita.Fc.Runtime.Monitor'
isDefault = True
description = ''
[item.intel.win32.cs4_7_1]
eventLogClass = 'Facilita.Fc.Runtime.FileEventLog'
engineProfileName = 'intel.win32.clr4_7_1'
builderName = 'intel.win32.cs4_7_1'
metaKey = 'CLRVUProfile'
environmentVariables = {}
name = 'intel.win32.cs4_7_1'
vuTypeName = '${ir.vu_type}'
nullEventLogClass = 'Facilita.Fc.Runtime.NullEventLog'
_id_ = '${altId}'
initialisers = ['Facilita.Web.WebBrowserUserInitialiser']
monitorClass = 'Facilita.Fc.Runtime.Monitor'
isDefault = False
description = ''
`;
}

function emitProfileCsv(): string {
    return 'linkWith,vuProfileName,name,controlFlags,transferToInjector,rank,loadAtRuntime,_id_,metaKey,debugPath\nB,S,S,I,B,I,B,S,S,S\n';
}

function emitScriptsCsv(ir: Ir, absId: string, vuId: string, mainId: string, name: string): string {
    const ns = ir.namespace;
    const vu = ir.vu_type;
    const rows: string[] = [];
    rows.push("methods,endTransactionOccurrence,startTransaction,metaKey,generationRulesUsageReportFilePath,isExecutable,startTransactionOccurrence,namespace,_id_,build,targetUrl,traceName,description,vuTypeName,generationReportFilePath,pathName,soapVersion,isMainScript,name,package,endTransaction,serviceID,_parentId_");
    rows.push("LS,I,S,S,S,B,I,S,S,B,S,S,S,S,S,S,I,B,S,S,S,S,S");
    rows.push(`[],-1,'','CSWebScript','',True,-1,'${ns}','${absId}',True,'','','','${vu}','','${vu}Script.cs',0,True,'${vu}Script',,'','',''`);
    rows.push(`,,,'CSCLRScript','',True,,'${ns}','${vuId}',True,,'','','${vu}','','${vu}.cs',,True,'${vu}',,,'',''`);
    rows.push("methods,endTransactionOccurrence,startTransaction,metaKey,generationRulesUsageReportFilePath,isExecutable,startTransactionOccurrence,namespace,_id_,build,targetUrl,traceName,description,vuTypeName,generationReportFilePath,pathName,soapVersion,isMainScript,name,package,endTransaction,serviceID,_parentId_");
    rows.push("LS,I,S,S,S,B,I,S,S,B,S,S,S,S,S,S,I,B,S,S,S,S,S");
    rows.push(`[],-2,'','CSWebScript','',True,-2,'${ns}','${mainId}',True,'','${name}','','${vu}','','${name}.cs',0,True,'${name}',,'','',''`);
    return rows.join('\n') + '\n';
}

function emitTracesCsv(ir: Ir, traceId: string): string {
    const rows: string[] = [];
    rows.push("isCitrixStoreFront,description,_id_,excludedGenerationRules,metaKey,pathName,_parentId_,transactionNames,serviceName,completedInputDataScan,name");
    rows.push("B,S,S,LS,S,S,S,LS,S,B,S");
    rows.push(`False,'','${traceId}',[],'WebTrace','${ir.script_name}\\${ir.script_name}.hlog','',,,True,'${ir.script_name}'`);
    return rows.join('\n') + '\n';
}

function emitSourceCsv(): string {
    return 'linkWith,vuProfileName,name,controlFlags,transferToInjector,rank,loadAtRuntime,_id_,metaKey,debugPath\nB,S,S,I,B,I,B,S,S,S\n';
}

function emitGenOptionsIni(ir: Ir): string {
    const hostsCsv = ir.pre.include_hosts.join(',');
    const nsWin = ir.namespace.replace(/\./g, '\\');
    const scriptPath = 'clr\\' + nsWin + '\\' + ir.script_name + '.cs';
    return `[options]
language = CS
baseName = ${ir.namespace}.${ir.vu_type}Script
namespace = ${ir.namespace}
excludedRules =
traceName = ${ir.script_name}.filtered
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
hostFilterSet = ${hostsCsv}
hostsRegExpsFilterSet =
outputScripts = ${ir.script_name}

[options.script.${ir.script_name}]
path = ${scriptPath}
startAt =
startOccurrence = -2
endAt =
endOccurrence = -2
`;
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer
// ---------------------------------------------------------------------------
function crc32Table(): Uint32Array {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
}

const CRC_TABLE = crc32Table();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function writeZip(outPath: string, entries: ZipEntry[]): void {
    const localHeaders: Buffer[] = [];
    const centralHeaders: Buffer[] = [];
    let offset = 0;
    const dosTime = 0;
    const dosDate = ((1980 - 1980) << 9) | (1 << 5) | 1;

    for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const deflated = zlib.deflateRawSync(entry.data);
        const useDeflate = deflated.length < entry.data.length;
        const storedData: Buffer = useDeflate ? deflated : entry.data;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(entry.data);

        const lh = Buffer.alloc(30 + nameBuf.length);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0, 6);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(dosTime, 10);
        lh.writeUInt16LE(dosDate, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(storedData.length, 18);
        lh.writeUInt32LE(entry.data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        nameBuf.copy(lh, 30);

        const localHeader = Buffer.concat([lh, storedData]);
        localHeaders.push(localHeader);

        const ch = Buffer.alloc(46 + nameBuf.length);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0, 8);
        ch.writeUInt16LE(method, 10);
        ch.writeUInt16LE(dosTime, 12);
        ch.writeUInt16LE(dosDate, 14);
        ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(storedData.length, 20);
        ch.writeUInt32LE(entry.data.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28);
        ch.writeUInt16LE(0, 30);
        ch.writeUInt16LE(0, 32);
        ch.writeUInt16LE(0, 34);
        ch.writeUInt16LE(0, 36);
        ch.writeUInt32LE(0, 38);
        ch.writeUInt32LE(offset, 42);
        nameBuf.copy(ch, 46);
        centralHeaders.push(ch);
        offset += localHeader.length;
    }

    const centralDir = Buffer.concat(centralHeaders);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    const all = Buffer.concat([...localHeaders, centralDir, eocd]);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, all);
}

// ---------------------------------------------------------------------------
// Package into .epa
// ---------------------------------------------------------------------------
function packageEpa(ir: Ir, outPath: string, uuids: UuidSource): void {
    const ns = ir.namespace;
    const nsPath = ns.replace(/\./g, '/');
    const vu = ir.vu_type;
    const name = ir.script_name;

    const vuId = uuids.next();
    const absId = uuids.next();
    const mainId = uuids.next();
    const traceId = uuids.next();
    const defaultId = uuids.next();
    const altId = uuids.next();

    const files: ZipEntry[] = [];
    const add = (arc: string, content: string) => files.push({ name: arc, data: Buffer.from(content, 'utf8') });

    add(`vuTypes/${vu}.ini`, emitVuTypeIni(ir, vuId));
    add(`vuTypes/${vu}/generationRules.json`, '[]');
    add(`profiles/${vu}.ini`, emitProfileIni(ir, defaultId, altId));
    add(`profiles/${vu}.csv`, emitProfileCsv());
    add(`scripts/clr/${nsPath}/${vu}.cs`, emitVuCs(ir));
    add(`scripts/clr/${nsPath}/${vu}Script.cs`, emitVuScriptCs(ir));
    add(`project/scripts.csv`, emitScriptsCsv(ir, absId, vuId, mainId, name));
    add(`project/traces.csv`, emitTracesCsv(ir, traceId));
    add(`project/scripts/clr/${nsPath}/${name}.cs`, emitScriptCs(ir));
    add(`project/traces/${name}/${name}_genOptions.ini`, emitGenOptionsIni(ir));
    add('source.csv', emitSourceCsv());

    for (const csv of ir.profile_csvs) {
        add(`data/${csv.file}`, csv.columns.join(',') + '\n');
    }

    writeZip(outPath, files);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): CliArgs {
    const out: CliArgs = { jmx: null, name: null, namespace: 'com.testplant.testing', outDir: 'dist', seed: null };
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--name') { out.name = argv[++i]; }
        else if (a === '--namespace') { out.namespace = argv[++i]; }
        else if (a === '--out') { out.outDir = argv[++i]; }
        else if (a === '--seed') { out.seed = parseInt(argv[++i], 10); }
        else if (!out.jmx) { out.jmx = a; }
        i++;
    }
    return out;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    if (!args.jmx) {
        printMessage('Usage: npx ts-node jm2epa.ts <plan.jmx> [--name Script] [--namespace ns] [--out dir/] [--seed N]', 'red');
        process.exit(1);
    }
    const scriptName = args.name || path.basename(args.jmx).replace(/\.jmx$/i, '').replace(/[^A-Za-z0-9_]/g, '_');
    const ir = buildIr(args.jmx, scriptName, args.namespace);
    const uuids = new UuidSource(args.seed);
    const outPath = path.join(args.outDir, scriptName + '.epa');
    packageEpa(ir, outPath, uuids);
    printMessage(`Wrote ${outPath}`, 'green');
}

if (require.main === module) main();

export { buildIr, packageEpa, parseXml, Ir, Step, Action };
