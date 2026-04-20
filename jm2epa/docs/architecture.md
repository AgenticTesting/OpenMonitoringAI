# jm2epa Architecture

`jm2epa` converts an Apache JMeter `.jmx` test plan into an Eggplant Performance `.epa` project archive. It runs as a single-file CLI (available in Python, JavaScript, and TypeScript) with no runtime dependencies beyond each language's standard library.

This document explains the **pipeline**, the **intermediate representation (IR)**, and the **parity contract** that keeps the three ports in lock-step.

## Pipeline

All three ports implement the same five-stage pipeline:

```
 .jmx  ──┐
         ▼
    ┌─────────┐   ┌─────┐   ┌──────┐   ┌─────┐   ┌────────┐
    │  parse  │──▶│ IR  │──▶│ plan │──▶│ emit│──▶│ package│──▶ .epa
    └─────────┘   └─────┘   └──────┘   └─────┘   └────────┘
```

1. **parse** — read the `.jmx` XML into an in-memory node tree. Each port ships a hand-rolled XML parser so there is no third-party dependency; they all produce the same `XmlNode` shape with alternating element / `<hashTree>` sibling pairs.
2. **IR** — walk the node tree and build a language-agnostic `Ir` object: thread groups, transactions, steps, extractors, assertions, timers, headers, cookie config, CSV data sources, UDVs. This is the only stage where JMeter-specific naming shows up.
3. **plan** — analyse the IR to decide what `.epa` output files are needed and what deterministic UUIDs to generate. Controlled by a seedable CSPRNG (`UuidSource`) so `--seed N` always produces the same archive.
4. **emit** — render the IR into the individual Eggplant artifacts: a C# virtual-user script under `scripts/clr/<Namespace>/<Name>.cs`, plus XML for `project/`, `vuTypes/`, `profiles/`, a `source.csv`, and a `gen-options.ini`.
5. **package** — write a ZIP archive using a hand-rolled writer. Every entry uses a fixed 1980-01-01 DOS timestamp; the central directory is written in insertion order. Two runs with the same seed produce byte-identical ZIPs.

## Intermediate representation

The IR is the contract that all three ports share. It looks the same in every port (Python dict, JS object, TS interface). The top-level shape is:

```
Ir
├── name:              str   (TestPlan name)
├── namespace:         str   (C# namespace derived from name)
├── default_host:      str   (first HTTPSampler domain seen, used for IpEndPoint)
├── default_protocol:  "http" | "https"
├── default_port:      int
├── hosts:             [{ name, host, port, protocol }]
├── udvs:              { key: value }         (TestPlan user-defined variables)
├── csv_sources:       [{ id, filename, columns, delimiter }]
├── cookies_enabled:   bool
├── default_headers:   { name: value }        (thread-group-scoped HeaderManager)
└── actions:           [Action]
```

Each `Action` is either the synthesized `Action0_Run` (default) or a `TransactionController`-derived `Action<N>_<Name>`:

```
Action
├── index:       int
├── name:        str
├── transaction: str | null   (transaction label, null for default Action0)
└── steps:       [Step]
```

And each `Step` is the atomic unit that maps to one HTTP call plus its post-processors:

```
Step
├── kind:        "http" | "pause"
├── name:        str           (HTTPSampler testname, used for the C# local var)
├── method:      "GET" | "POST" | ...
├── url:         { host, port, protocol, path }
├── query:       [{ name, value }]
├── body:        Body | null
├── headers:     { name: value }
├── extractors:  [Extractor]
├── assertions: [Assertion]
└── delay_ms:    int | null     (for kind="pause")
```

An `Extractor` captures whether a `RegexExtractor` could be reduced to a boundary match (`Response.Extract(lb, rb)`) or must remain a TODO stub preserving the original regex:

```
Extractor
├── kind:       "boundary" | "regex_todo"
├── refname:    str         (C# variable name)
├── lb:         str | null  (boundary kind only)
├── rb:         str | null  (boundary kind only)
└── regex:      str | null  (regex_todo kind only)
```

Adding a new JMeter element generally means adding one or two new IR fields plus a matching case in each port's parser and emitter — no changes to the pipeline.

## Emitted artifacts

The `.epa` ZIP always contains these 11 entries, in this insertion order:

| Path | Purpose |
|---|---|
| `project/project.xml` | project-level metadata (name, created-by, version) |
| `project/gen-options.ini` | code-gen options pointing at the generated C# file |
| `vuTypes/<Name>VU.xml` | virtual-user type definition |
| `scripts/clr/<Namespace>/<Name>.cs` | the generated C# script |
| `profiles/<Name>.profile.xml` | workload profile referencing the VU type |
| `source.csv` | profile-level data source (schema: `linkWith,vuProfileName,name,controlFlags,transferToInjector,rank,loadAtRuntime,_id_,metaKey,debugPath`) |
| `data/.keep` | placeholder so `data/` survives the ZIP |
| `data/readme.txt` | instructions for populating CSVDataSet rows |
| `.epaproject` | Eggplant Performance project marker |
| `MANIFEST.MF` | manifest with tool version and seed |
| `README.txt` | end-user instructions embedded in the archive |

The emitter order is defined centrally (one constant list per port) so that changing it requires updating all three places. `tests/parity.sh` will catch any drift immediately.

## Parity contract

The three ports MUST produce byte-identical `.epa` archives for every fixture in `test_jmx/`. This is not a nice-to-have — it's the invariant the parity test script (`tests/parity.sh`) enforces, and it's what makes the converter safe to use: whichever port you run, you get the same artefact.

Consequences for contributors:

- A change to one port that affects emitted bytes requires the same change in the other two.
- Any non-determinism (wall-clock timestamps, unseeded `Guid.NewGuid()`, hash-map iteration) breaks parity and must be refactored to use the seeded `UuidSource` or an ordered data structure.
- CI runs `tests/parity.sh` on every push (see `.github/workflows/parity.yml`).

## Why three ports?

Different teams have different constraints. A DevOps engineer running `jm2epa.py` in a pipeline doesn't want to install Node; a Node-based migration tool doesn't want to shell out to Python; a TypeScript project wants type-checked source it can embed. Keeping three ports in parity costs a small amount of duplicated work but avoids forcing a runtime choice on users.

The Perl-to-Python-to-JS-to-TS pattern is borrowed from the sibling `lr2jm` converter, which pioneered the approach in this repo.
