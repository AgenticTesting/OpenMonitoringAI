# `jm2epa` — JMeter → Eggplant Performance Converter

**Companion to `lr2jm`.** Where `lr2jm` takes a LoadRunner script directory and emits a JMeter `.jmx`, `jm2epa` takes a JMeter `.jmx` (plus any CSV data files) and emits a complete Eggplant Performance `.epa` project archive containing a generated C# Facilita.Web script, VU type, profile, and project metadata.

This document describes the target format, the mapping from JMX to EPP, the converter architecture, edge cases, and the delivery roadmap. It was written after dissecting two real `.epa` archives (`Script_Geolocation.epa`, `Script_FuelTransaction.epa`) and the existing `lr2jm.py` converter in this repo.

---

## 1. Understanding the `.epa` Format

An `.epa` is a standard ZIP archive. A minimal, runnable project has this layout:

```
<ScriptName>.epa
├── source.csv                                   Manifest of exported scripts
├── vuTypes/
│   ├── <VuType>.ini                             VU type definition (Web, TCP, etc.)
│   └── <VuType>/generationRules.json            Custom codegen rules (can be [])
├── profiles/
│   ├── <VuType>.ini                             Profile (engine, initialisers, eventLog)
│   └── <VuType>.csv                             Per-VU data columns (parameters)
├── scripts/clr/<namespace>/
│   ├── <VuType>.cs                              Base VU class (extends WebBrowserVirtualUser)
│   └── <VuType>Script.cs                        Abstract script class
└── project/
    ├── scripts.csv                              Script index
    ├── traces.csv                               Trace index
    ├── scripts/clr/<namespace>/<ScriptName>.cs  THE GENERATED SCRIPT
    └── traces/<ScriptName>/
        ├── <ScriptName>.hlog                    Recorded HTTP trace (XML-ish)
        ├── <ScriptName>_genOptions.ini          Generation options used
        ├── Responses/*dataFile*                 Recorded response / post bodies
        └── WebSockets/*webSocketFrames.json     Recorded WebSocket frames (if any)
```

For conversion, only a subset of these files must be generated — the `.hlog` / `Responses/` tree is the recording artefact and is **not required** for a script to run. We emit a synthesized `.hlog`-less project where the script is the source of truth.

### The script itself

Generated scripts are C# classes under `Facilita.Web`:

```csharp
using Facilita.Native;
using Facilita.Web;
using Facilita.Fc.Runtime;

namespace com.testplant.testing {
  public class FuelTransaction_3 : EgAmerica_VUScript {
    // Parameterised endpoints — one per unique host
    IpEndPoint host1 = null;
    Protocol   protocol1 = null;

    public override void Pre() {
      base.Pre();
      WebBrowser.DefaultUserAgent = GetString("User-Agent","…");
      WebBrowser.SetDefaultHeader("Accept", "*/*");
      WebBrowser.HostFilteringMode = HostFilteringMode.ALLOWLIST;
    }

    public override void Script() {
      host1 = new IpEndPoint(GetString("host1Host", "api.example.com"), GetInt("host1Port", 443));
      protocol1 = GetProtocol("protocol1", "https");
      WebBrowser.IncludeHost(GetString("host1Host","api.example.com"));

      Action1_Login();
      Action2_Order();
      Action3_Logout();
    }

    void Action1_Login() {
      StartTransaction("Login");

      Url url24 = new Url(protocol1, host1, "/oauth/token");
      using (Request req = WebBrowser.CreateRequest(HttpMethod.POST, url24, 24)) {
        req.SetHeader("Content-Type","application/x-www-form-urlencoded");
        Form post = new Form();
        post.AddElement(new InputElement("username", GetString("Username"), Encoding.GetEncoding("utf-8")));
        post.AddElement(new InputElement("password", GetString("password"), Encoding.GetEncoding("utf-8")));
        req.SetMessageBody(post);

        using (Response resp = req.Send()) {
          ExtractionCursor ec = new ExtractionCursor();
          Set<string>("access_token",
            resp.Extract(ec, ",\"access_token\":\"", "\"",
                         ActionType.ACT_WARNING, true, SearchFlags.SEARCH_IN_BODY));
          resp.VerifyResult(HttpStatus.OK, ActionType.ACT_WARNING);
        }
      }

      EndTransaction("Login");
      Pause(10000);
    }
  }
}
```

Key primitives observed in both sample scripts:

| Primitive | Purpose |
|---|---|
| `GetString(name, default)` / `GetInt(...)` / `GetProtocol(...)` | Read a parameter (from profile CSV or user-defined var) |
| `Set<string>(name, value)` | Persist an extracted/correlated value for later requests |
| `IpEndPoint(host, port)` | Parameterised server address |
| `Url(protocol, endpoint, path)` + `WithQuery(QueryData)` | Build the request URL |
| `WebBrowser.CreateRequest(HttpMethod.X, url, id)` | Construct a request; `id` preserves recording correlation |
| `Request.SetHeader(k, v)` | Per-request header |
| `Request.SetMessageBody(Form)` / `Request.SetMessageBody(string)` | Form or raw body (JSON/XML) |
| `Response.Send()` | Fire the request (returned inside `using`) |
| `Response.Extract(cursor, LB, RB, …, SearchFlags.SEARCH_IN_BODY)` | LB/RB correlation |
| `Response.VerifyResult(HttpStatus.OK, ActionType.ACT_WARNING)` | Assertion on status |
| `StartTransaction("n")` / `EndTransaction("n")` | Timed transactions (logical business step) |
| `Pause(ms)` | Think time |
| `WebBrowser.SaveCookie(host, "k=v")` | Seed a cookie |
| `WebBrowser.IncludeHost(host)` | Allow-list host for the engine |

Extension points are `#region EPP_*` blocks — e.g. `EPP_BEFORE_REQUEST_SENT`, `EPP_AFTER_RESPONSE_RECEIVED` — which are preserved across regenerations. The converter should emit these as empty regions so user customisation survives later re-conversion.

---

## 2. JMeter → Eggplant Performance Element Mapping

| JMeter (JMX) | Eggplant Performance (C# / Facilita.Web) | Notes |
|---|---|---|
| `TestPlan` | `.epa` archive root + `source.csv`, `project/scripts.csv` | One script per TestPlan |
| `ThreadGroup` | `profiles/<VuType>.ini` (threads/ramp go in EPP workload, not script) | Thread count/ramp are runtime, not script-side; emit a default profile |
| `HTTPSamplerProxy` / `HTTPSampler` | `Url` + `WebBrowser.CreateRequest(HttpMethod.X, url, id)` block | One block per sampler |
| `HTTPSampler.method` (GET/POST/PUT/DELETE/PATCH) | `HttpMethod.GET` / `POST` / `PUT` / `DELETE` / `PATCH` | Direct enum map |
| `HTTPSampler.domain` + `.port` | `new IpEndPoint(GetString("hostHost","…"), GetInt("hostPort", 443))` | De-duplicate per host |
| `HTTPSampler.protocol` (http/https) | `GetProtocol("protocolN","https")` | Inferred from port if blank |
| `HTTPSampler.path` | 3rd arg to `new Url(protocol, endpoint, "/path")` | Parameter substitution on path |
| Query params (`HTTPArgument` with `use_equals`=true on GET) | `QueryData qd = new QueryData(); qd.Add(k,v); url = url.WithQuery(qd);` | |
| Form params (HTTPArgument collection on POST, `ContentType: x-www-form-urlencoded`) | `Form f = new Form(); f.AddElement(new InputElement(k,v,enc)); req.SetMessageBody(f);` | |
| Raw body (`HTTPSampler.postBodyRaw=true` or JSON Content-Type) | `string body = "…"; req.SetMessageBody(body);` | Use verbatim C# string literal, escape quotes |
| Multipart upload (`DO_MULTIPART_POST=true`, FILE_NAME/FILE_FIELD) | `Form` with file part / `MultiPartForm` | Preserve filename, MIME |
| `HeaderManager` (scoped sibling of sampler) | `req.SetHeader(k,v)` before `Send()` | Global `HeaderManager` on TestPlan → `WebBrowser.SetDefaultHeader(k,v)` in `Pre()` |
| `CookieManager` | Implicit in `Facilita.Web` (cookies are automatic). Seeded cookies → `WebBrowser.SaveCookie(host, "k=v")` in `Pre()` | |
| `AuthManager` (Basic) | `req.SetHeader("Authorization","Basic " + base64(user+":"+pass))` | Or custom code in `EPP_PRE` |
| `CSVDataSet` | `profiles/<VuType>.csv` — columns = `variableNames` | Every CSVDataSet column becomes accessible via `GetString(col)`; merge into single profile CSV when possible |
| `${variable}` in any field | `" + GetString("variable") + "` inside emitted C# string, or `GetString("variable")` when the value is the whole field | Detect and rewrite during body/url emission |
| `RegexExtractor` with LB-ish regex (`LB(.*?)RB`) | `Response.Extract(cursor, "LB", "RB", ACT_WARNING, true, SearchFlags.SEARCH_IN_BODY)` | Prefer boundary form — EPP idiom |
| `RegexExtractor` arbitrary regex | Emit `Response.ExtractWithRegex(cursor, @"…", matchNum)` **or** fall back to raw regex with a TODO comment | |
| `BoundaryExtractor` | `Response.Extract(cursor, LB, RB, …)` | Direct map |
| `JSONPostProcessor` | `JsonParser` + path evaluation in `EPP_AFTER_RESPONSE_RECEIVED` | Emit idiomatic Facilita JSON helper or custom code |
| `ResponseAssertion` (status) | `response.VerifyResult(HttpStatus.X, ActionType.ACT_WARNING)` | Map status ints to `HttpStatus` enum |
| `ResponseAssertion` (body contains) | `if (!response.GetBody().Contains("X")) OnError(...)` in `EPP_AFTER_RESPONSE_RECEIVED` | |
| `ConstantTimer` | `Pause(ms)` | |
| `GaussianRandomTimer` / `UniformRandomTimer` | `Pause(Random.NextInt(min,max))` via `Facilita.Native.Random` | |
| `TransactionController` | `StartTransaction("name")` … `EndTransaction("name")` inside an `Action<N>_<Name>()` method | Each TC → one Action method |
| `LoopController` | `for (int i = 0; i < n; i++) { … }` | |
| `WhileController` | `while (GetString("cond") == "true") { … }` | |
| `IfController` | `if (<condition>) { … }` | Condition rewritten from Groovy/JS to C# |
| `ThroughputController` / `RandomController` | C# `if/switch` using `Random` | |
| `JSR223Sampler` / `JSR223PreProcessor` / `JSR223PostProcessor` | Emit corresponding `#region EPP_*` block with the script commented out + a TODO | Cannot auto-translate Groovy/JS reliably |
| `UserDefinedVariables` (TestPlan-level) | `GetString("name","default")` calls, seeded via profile CSV | |
| `BeanShell*` | Same as JSR223 — emit as TODO block | |
| `HTTPCacheManager` | No direct equivalent — comment | |
| WebSocket samplers (`JMeter-WebSocketSamplers`) | `WebSocket.CreateConnection(...)` + `SendMessage` / `OnMessage` | Matches the `useWebSocketReceivedMessageCallbackRegion` hooks in EPP |

### Grouping strategy

- **With Transaction Controllers:** Each TC becomes `Action<N>_<TCName>()`. Requests inside are emitted in order; post-processors attached to samplers become code inside the `using (Response …) { … }` block of the preceding sampler.
- **Without Transaction Controllers:** Emit one synthetic `Action1_Main()` wrapping all samplers in a single `StartTransaction("Main")` / `EndTransaction("Main")`.

---

## 3. Converter Architecture

Mirror the `lr2jm` design: a small Python module with stdlib + `xml.etree.ElementTree`, portable to Perl / JS / TS later. The entry point is `jm2epa.py` and the flow is five deterministic stages.

```
┌───────────┐   ┌─────────┐   ┌──────────┐   ┌─────────┐   ┌──────────┐
│  parse    │ → │   IR    │ → │  plan    │ → │  emit   │ → │ package  │
│  (JMX+CSV)│   │ (dict)  │   │(actions, │   │ (.cs)   │   │  (.epa)  │
│           │   │         │   │ hosts,   │   │         │   │          │
│           │   │         │   │ params)  │   │         │   │          │
└───────────┘   └─────────┘   └──────────┘   └─────────┘   └──────────┘
```

### Stage 1 — Parse JMX

Use `ElementTree.parse(jmx_path)`. JMX is a tree of `<X>…</X><hashTree>…</hashTree>` pairs where the `hashTree` *sibling* holds the children of `X`. Walk with a helper `iter_children(elem, tree_sibling)` that pairs each element with its `hashTree` follower.

Extract from each node:
- **TestPlan:** name, user-defined variables, global header manager (if any), global cookie manager, global assertions.
- **ThreadGroup:** threads / ramp / loops (retained for profile metadata only; not for the script).
- **CSVDataSet:** `filename`, `variableNames`, `delimiter`, `recycle`. Resolve filename to disk and load column data.
- **HTTPSampler(Proxy):** method, domain, port, protocol, path, args collection (with `use_equals`, `always_encode`), `postBodyRaw` flag, `DO_MULTIPART_POST`, `FILE_NAME`/`FILE_FIELD`, `image_parser`, `follow_redirects`.
- **HeaderManager (child of sampler):** local headers attached to the preceding sampler. Global ones go to `Pre()`.
- **RegexExtractor / BoundaryExtractor / JSONPostProcessor (child of sampler):** refname, regex / LB+RB, default, match_number → extractor records.
- **Timer elements (child of sampler or controller):** convert to `Pause` (emitted after the sampler or before `EndTransaction`).
- **TransactionController:** wraps its child samplers → IR `Action` node.
- **LoopController / WhileController / IfController / ForEachController:** control-flow IR nodes.

### Stage 2 — IR (single-file, stdlib-only)

```python
IR = {
  "script_name": "LoginFlow",
  "namespace": "com.testplant.testing",
  "vu_type": "LoginFlowVU",
  "pre": {
    "default_headers": {"Accept":"*/*", ...},
    "default_user_agent": "Mozilla/5.0 ...",
    "seed_cookies": [("host", "k=v")],
    "user_vars": {"Username":"alice", "password":"…"},
    "include_hosts": ["api.example.com", "auth.example.com"],
  },
  "hosts": {                       # unique hosts → variable names
    "api.example.com": {"var":"api_example_com", "port":443, "protocol":"https"},
    "auth.example.com": {"var":"auth_example_com", "port":443, "protocol":"https"},
  },
  "profile_csvs": [                # consolidated from CSVDataSets
    {"file":"users.csv", "columns":["username","password"]},
  ],
  "actions": [
    {
      "name": "Login",
      "steps": [
        {"kind":"request", "id":24, "method":"POST", "host":"api.example.com",
         "path":"/oauth/token",
         "query":[],
         "headers":[("Content-Type","application/x-www-form-urlencoded"), ...],
         "body":{"kind":"form", "parts":[("username","${username}"), ("password","${password}")]},
         "extractors":[
            {"kind":"boundary","name":"access_token","lb":",\"access_token\":\"","rb":"\"","match":1},
         ],
         "asserts":[{"kind":"status","expected":200}],
         "post_pause_ms": None,
        },
        ...
      ],
      "transaction":"Login",
      "post_pause_ms": 10000
    }
  ]
}
```

### Stage 3 — Plan

- De-duplicate hosts → `IpEndPoint` variable names (sanitise to identifiers).
- Gather all `${var}` references across paths / headers / body / query to determine what goes in the profile CSV vs `GetString` defaults.
- Partition regex extractors into `boundary`-friendly (pattern `LB(.*?)RB`) and fallback (arbitrary regex).
- Assign `Action<N>_<TCName>()` names; disambiguate duplicates.
- Build the `source.csv` / `project/scripts.csv` / `project/traces.csv` row data.

### Stage 4 — Emit (C#)

Use string-builder functions (no Jinja — follow the stdlib-only style of `lr2jm.py`). Three files per script:

- `scripts/clr/<ns>/<VuType>.cs` — stock VU class (templated on `ABSA.cs`).
- `scripts/clr/<ns>/<VuType>Script.cs` — stock abstract script (templated on `ABSAScript.cs`).
- `project/scripts/clr/<ns>/<ScriptName>.cs` — the generated script body.

Emit empty `#region EPP_*` blocks in each of the documented locations so user edits survive regeneration.

### Stage 5 — Package

1. Write all files into a staging directory.
2. Emit `.ini` and `.csv` metadata files (templated on the two sample archives).
3. Compute deterministic `_id_` GUIDs (use `uuid.uuid4()` once per entity) and cross-reference between `vuTypes`, `profiles`, `scripts.csv`, `traces.csv`.
4. `zipfile.ZipFile(out_path, 'w', ZIP_DEFLATED)` with forward-slash paths inside the archive.

### CLI

```
python jm2epa.py <path/to/plan.jmx> [--name FuelFlow] [--namespace com.testplant.testing] [--out dist/]
```

Output: `dist/FuelFlow.epa`.

---

## 4. Edge Cases & Open Decisions

| Issue | Plan |
|---|---|
| `${__P(prop,default)}`, `${__time(…)}`, `${__Random(…)}` | Detect common functions; map to `GetString("prop","default")`, `DateTime.UtcNow.Ticks`, `Random.NextInt(...)`. Unknown functions → emit verbatim with a `// TODO jm2epa:` comment. |
| Groovy/JS in JSR223 | Preserve source inside `#region EPP_AFTER_RESPONSE_RECEIVED` (commented) + TODO. Do not attempt auto-translation. |
| Arbitrary regex extractors | If pattern matches `^(.+?)\((.*?)\)(.+?)$` with a single capture group, emit `Response.Extract(cursor, prefix, suffix, …)`. Otherwise emit `Response.ExtractWithRegex(...)` or a manual extraction block. |
| Streaming response assertions | Map Response Assertions (status / body contains / header equals) one-by-one; unsupported modes → TODO. |
| HTTPS vs HTTP inference | If protocol is blank and port is 443 → https; port 80 → http; else default to https and warn. |
| Multiple ThreadGroups | Emit one script per ThreadGroup (append `_TG<N>` to name). |
| Recorded responses / `.hlog` | **Do not synthesize.** EPP runs happily without them — the script is self-sufficient. |
| `.jmx` with BlazeMeter-specific elements | Known BZM plugins (Correlation Recorder, Weighted Switch Controller, etc.) → best-effort mapping, otherwise TODO. |
| Binary request bodies | If `HTTPSampler.FILE_NAME` is set without multipart → `req.SetMessageBodyFromFile(...)`. |
| Variable re-use across actions | `Set<string>("x", …)` in one action + `GetString("x")` in a later action works across transactions because EPP stores them on the VU. Confirm with docs; mirror observed usage. |

---

## 5. Validation Strategy

**Unit tests** (`tests/unit/`), one per JMX feature: GET sampler, POST form, POST raw JSON, RegexExtractor LB/RB, CSVDataSet, TransactionController, ConstantTimer, nested controllers, HeaderManager global vs local, multipart.

**Golden-file tests** (`tests/golden/`): small curated `.jmx` → expected `.cs`. Diff ignores whitespace / GUIDs.

**Round-trip validation:**
1. Take the provided `Script_FuelTransaction.epa` → extract the C# script → derive a hand-written equivalent `.jmx` (reference input).
2. Run `jm2epa` on that `.jmx` → compare structure of emitted `.cs` against the reference `FuelTransaction_3.cs`: same Action method names, same transaction boundaries, same Request IDs, same extractor names, same pause durations.
3. Not byte-exact; structural similarity plus compilability check via `csc` or `mcs` if available in CI.

**Smoke package test:** `unzip -t output.epa` passes; `source.csv` + `project/scripts.csv` reference the emitted script; opening the archive in EPP 9.5+ loads without errors.

---

## 6. Roadmap

| Milestone | Deliverable | Acceptance |
|---|---|---|
| **M0** | Parser + IR for TestPlan / ThreadGroup / HTTPSampler (GET) | IR dump matches hand-annotated fixture |
| **M1** | Emitter: `Script()` with GET requests + `IpEndPoint` de-dup + `IncludeHost` | Sample JMX produces compilable `.cs` |
| **M2** | POST form + POST raw body + HeaderManager | Login-style fixture round-trips |
| **M3** | RegexExtractor + BoundaryExtractor → `Response.Extract` | Correlation fixture matches reference structure |
| **M4** | CSVDataSet → profile CSV + `GetString` substitution | Parameterised fixture runs with CSV |
| **M5** | Transaction Controller → `Action<N>_<Name>()` | Multi-action fixture (mirrors `FuelTransaction_3.cs`) |
| **M6** | Timers → `Pause(ms)` | Pause fixture matches |
| **M7** | `.epa` packager (zip + `source.csv`, `scripts.csv`, `traces.csv`, `vuTypes/`, `profiles/`) | `unzip -t` passes; EPP loads archive |
| **M8** | CLI polish (`jm2epa.py`), docs, examples, update README with table | `python jm2epa.py sample.jmx` produces `sample.epa` |
| **M9** | Language ports — Perl (`jm2epa.pl`), JS (`jm2epa.js`), TS (`jm2epa.ts`) | All four produce identical output |
| **M10** | JSR223 TODO preservation + idiomatic ExtractWithRegex fallback | Complex real-world JMX from BlazeMeter demos round-trips |

---

## 7. Repository Layout After Landing

```
open-performance/
├── app.py                       # (existing) LR .cor → JMeter JSON
├── lr2jm.py / .pl / .js / .ts   # (existing) LR script → .jmx
├── jm2epa.py                    # NEW — JMeter .jmx → .epa
├── jm2epa.pl / .js / .ts        # NEW — language ports (M9)
├── templates/                   # NEW — static .ini / .cs skeletons
│   ├── VuType.ini
│   ├── VuType.cs
│   ├── VuTypeScript.cs
│   ├── Profile.ini
│   └── genOptions.ini
├── test_lr_script/              # (existing) LR fixture
├── test_jmx/                    # NEW — JMX fixtures for jm2epa tests
│   ├── minimal_get.jmx
│   ├── login_form.jmx
│   ├── correlation.jmx
│   ├── transactions.jmx
│   └── full_fueltransaction.jmx  # hand-derived from Script_FuelTransaction.epa
├── tests/
│   ├── unit/
│   └── golden/
└── README.md                     # Updated: add jm2epa table row + section
```

---

## 8. Why This Design

- **Mirrors `lr2jm`'s style** — single-file Python converter, stdlib-only, then ported to Perl/JS/TS. Easy to maintain alongside the existing tools.
- **Stays in the EPP idiom** — emits code that looks hand-written in Facilita.Web, uses `#region EPP_*` regeneration-safe regions, and produces a fully-loadable `.epa` archive. A tester can open it in Eggplant Performance Studio and run it without hand-fixing paths.
- **Keeps recordings out of scope** — we do not try to synthesize `.hlog` or response data files. The script is authoritative; the archive is runnable without them.
- **Degrades gracefully** — anything the converter can't translate (JSR223 Groovy, exotic post-processors, BZM custom elements) is preserved as a commented `#region EPP_*` TODO, so nothing is silently dropped.

---

## 9. Next Actions

1. Confirm scope: JMeter 5.x input as the baseline; EPP 9.5+ (C#, CLR engine) as the target. (Both match the provided `.epa` samples.)
2. Decide on default namespace / VU type naming (`com.testplant.testing.<Name>VU`) — configurable via CLI.
3. Build M0–M2 (parser → emitter with GET/POST/headers) as a runnable thin slice against `test_jmx/minimal_get.jmx` and `login_form.jmx`.
4. Add `jm2epa` row to `README.md` "Converters at a Glance" table once M8 lands.

---

## 10. JavaScript & TypeScript Port Steps (mirrors `lr2jm.js` / `lr2jm.ts`)

Once the Python reference implementation is stable through **M8**, port it to Node.js in exactly the pattern the `lr2jm` family already uses: `.js` first as a straight JavaScript port with zero runtime dependencies, then `.ts` as a typed superset that compiles down to the same `.js`. The existing `lr2jm.js` (ESM-free CommonJS, hand-rolled XML builder, stdlib-only) and `lr2jm.ts` (same logic + `interface` declarations + strict typing) are the style guide.

The two moving parts that don't exist in `lr2jm` are **XML parsing** (JMX is the *input*, not the output) and **ZIP writing** (the `.epa` container). Both can stay stdlib-only with small hand-rolled helpers, preserving the "just `node lr2jm.js …`" ergonomics.

### 10.1 `jm2epa.js` — JavaScript port

**Scope:** byte-for-byte-equivalent output with `jm2epa.py` on every fixture in `test_jmx/`.

**Runtime:** Node.js 18+, CommonJS, `"use strict"`, no `package.json` deps beyond what's already present for `lr2jm.js` (`zlib` is built-in; no `archiver`, no `xml2js`, no `fast-xml-parser`).

Steps, in order:

1. **Scaffold the file.** Copy the top-of-file header/shebang/doc comment style from `lr2jm.js` (lines 1–14). Require only built-ins:
   ```js
   'use strict';
   const fs = require('fs');
   const path = require('path');
   const zlib = require('zlib');
   const crypto = require('crypto');   // for uuid.v4 via randomUUID
   ```
2. **Port the IR shape verbatim.** The Python IR in §3 maps 1:1 to plain JS objects — no classes needed. Keep the same keys (`script_name`, `namespace`, `vu_type`, `pre`, `hosts`, `profile_csvs`, `actions`) so diffing the Python and JS implementations stays trivial.
3. **Hand-roll a minimal JMX parser** (`parseJmx(xmlText) → domTree`). JMX uses a tiny subset of XML (elements, attributes, text, no namespaces, no processing instructions past the XML decl, no mixed-content weirdness). A ~120-line regex-driven tokenizer is enough:
   - `<\?xml …\?>` — skip
   - `<!--.*?-->` — skip (multiline)
   - `<tag attr="…" … />` — self-closing element
   - `<tag attr="…" …>` … `</tag>` — open/close pair, recurse
   - text nodes — read, `&amp;`/`&lt;`/`&gt;`/`&quot;`/`&apos;` decode
   Return a node tree `{ tag, attrs, children, text }` symmetric to the `XmlElement` class already in `lr2jm.js` (just inverted — parsing instead of building). Reuse the existing class for `addChild`/`toString` semantics if helpful for round-trip debugging.
4. **Walk the tree with a `hashTree`-pairing helper.** In JMX every element is followed by a sibling `<hashTree>` containing its children. Write `iterChildren(parent) → [[elem, hashTree], …]`, then write `visit(node, hashTreeSibling)` to populate the IR — identical control flow to the Python version.
5. **Emit C# with string builders**, not templates. Mirror the Python `emit_script`, `emit_vu_type`, `emit_vu_script`, `emit_profile_ini`, `emit_genoptions_ini`, `emit_source_csv`, `emit_scripts_csv`, `emit_traces_csv` functions — one per file in the `.epa`. Use template literals; no Jinja, no Mustache.
6. **Hand-roll the ZIP writer** (`zipWrite(entries, outPath)`). A valid deflate-compressed ZIP with no encryption / no ZIP64 / no data-descriptors is ~100 lines of buffer manipulation:
   - For each entry, `zlib.deflateRawSync(content)` to get the compressed body, then compute CRC32 (`crypto` doesn't have it — add a 20-line table-based `crc32(buf)` helper, or use `zlib.crc32` on Node 22+).
   - Emit a Local File Header (`PK\x03\x04`) + filename + compressed body.
   - Track offsets; emit Central Directory Headers (`PK\x01\x02`) at the end; close with End-Of-Central-Directory (`PK\x05\x06`).
   - All paths use forward slashes; use UTF-8; set the "general purpose bit flag" byte for UTF-8 filenames.
   This adds zero deps and keeps the tool runnable from a bare `node jm2epa.js …` invocation.
7. **UUID generation for `_id_` fields.** Use `crypto.randomUUID()` (Node 14.17+). For deterministic fixtures in tests, expose `--seed` that swaps in a counter-backed fake UUID — the Python port should have the same flag.
8. **CLI.** Argv parsing by hand (mirror `readArguments()` in `lr2jm.js`). Support `--name`, `--namespace`, `--out`. Use the colored `printMessage` helper from `lr2jm.js` for identical UX.
9. **Smoke parity harness.** Add `tests/parity.sh` that runs both converters over every fixture and diffs the emitted files inside the `.epa`:
   ```
   python jm2epa.py  fixtures/login_form.jmx --out py/
   node   jm2epa.js  fixtures/login_form.jmx --out js/
   diff -r <(unzip -p py/login_form.epa \*.cs \*.ini \*.csv) \
           <(unzip -p js/login_form.epa \*.cs \*.ini \*.csv)
   ```
   Zero diff on all fixtures before shipping the port.

### 10.2 `jm2epa.ts` — TypeScript port

**Scope:** identical semantics to `jm2epa.js`; adds compile-time types. Same output on every fixture.

**Runtime:** TypeScript 4.8+, `@types/node` as the only dev dep. Ships as a `.ts` file compiled to CommonJS — same way `lr2jm.ts` is used today (`npx tsc lr2jm.ts --strict --target ES2020 --module commonjs --types node`).

Steps, in order:

1. **Start from `jm2epa.js`.** Rename to `.ts`, add `import * as fs from 'fs'` / `import * as path from 'path'` / `import * as zlib from 'zlib'` / `import * as crypto from 'crypto'` at the top. Exactly the pattern used in `lr2jm.ts` lines 13–14.
2. **Add IR interfaces** — the analogue of `RequestData` in `lr2jm.ts`. Sketch:
   ```ts
   interface Host { var: string; host: string; port: number; protocol: string; }
   interface Extractor {
     kind: 'boundary' | 'regex' | 'json';
     name: string;
     lb?: string; rb?: string;
     regex?: string; match?: number;
     jsonPath?: string;
   }
   interface RequestStep {
     kind: 'request';
     id: number;
     method: 'GET'|'POST'|'PUT'|'DELETE'|'PATCH';
     host: string;
     path: string;
     query: Array<[string,string]>;
     headers: Array<[string,string]>;
     body?: { kind: 'form'; parts: Array<[string,string]> }
           | { kind: 'raw';  content: string; contentType: string }
           | { kind: 'multipart'; parts: MultipartPart[] };
     extractors: Extractor[];
     asserts: Assertion[];
     postPauseMs?: number;
   }
   interface Action { name: string; transaction?: string; steps: RequestStep[]; postPauseMs?: number; }
   interface IR {
     scriptName: string;
     namespace: string;
     vuType: string;
     pre: PreConfig;
     hosts: Record<string, Host>;
     profileCsvs: Array<{file: string; columns: string[]}>;
     actions: Action[];
   }
   ```
   These interfaces are documentation-grade, not just type hints — they double as the spec for anyone writing a future converter in a different language.
3. **Type the XML parser and ZIP writer.** `XmlNode = { tag: string; attrs: Record<string,string>; children: XmlNode[]; text: string | null }`. `ZipEntry = { path: string; body: Buffer }`. Return `Buffer` from the zip writer, not `void`, so tests can assert against in-memory archives without touching disk.
4. **Strict mode.** Use `--strict`. Narrow union types (`extractor.kind === 'boundary'`) drive the emitter branches — the compiler catches missing cases when new extractor kinds are added.
5. **Preserve the compile-to-`.js` workflow.** Document the exact same build line as `lr2jm.ts`: `npx tsc jm2epa.ts --strict --target ES2020 --module commonjs --types node && node jm2epa.js …`. This keeps the four-language table in the README uniform.
6. **Parity check.** Extend `tests/parity.sh` to also run the compiled TypeScript output and diff against the Python and JS archives. All three must produce identical file trees inside the `.epa`.

### 10.3 Deps policy (same as `lr2jm`)

| Runtime | Dependencies | Invocation |
|---|---|---|
| Python 3.9+ | stdlib only | `python jm2epa.py sample.jmx` |
| Node.js 18+ | stdlib only | `node jm2epa.js sample.jmx` |
| TypeScript 4.8+ | `@types/node` (dev only) | `tsc jm2epa.ts && node jm2epa.js sample.jmx` |
| Perl 5+ (future) | `XML::DOM`, `Archive::Zip` | `perl jm2epa.pl sample.jmx` |

Keeping the Node ports dependency-free is worth the ~200 lines of hand-rolled XML+ZIP code because it preserves the "git clone and run" experience `lr2jm` has today — no `npm install`, no Python venv, no missing-module errors on first use.

### 10.4 README update (after M9 lands)

Extend the "Converters at a Glance" table:

| Script | Language | What It Converts | Output |
|--------|----------|-----------------|--------|
| `jm2epa.py` | Python | JMeter `.jmx` test plan | Eggplant Performance `.epa` archive |
| `jm2epa.js` | JavaScript | JMeter `.jmx` test plan | Eggplant Performance `.epa` archive |
| `jm2epa.ts` | TypeScript | JMeter `.jmx` test plan | Eggplant Performance `.epa` archive |

Add a "Chained conversion" example showing `LR → JMeter → EPP` in one pipeline:
```bash
python lr2jm.py MyLRScript/              # emits MyLRScript/MyLRScript.jmx
python jm2epa.py MyLRScript/MyLRScript.jmx --out dist/
# → dist/MyLRScript.epa, loadable in Eggplant Performance Studio
```
