# jm2epa

[![parity](https://img.shields.io/badge/parity-py%20%7C%20js%20%7C%20ts-brightgreen)](./tests/parity.sh)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Convert an Apache JMeter `.jmx` test plan into an Eggplant Performance `.epa` project archive. Three ports in the box — **Python**, **JavaScript**, **TypeScript** — all producing **byte-identical** output under a fixed `--seed`.

```bash
# Python
python jm2epa.py plan.jmx --name MyScript --seed 1 --out build/

# JavaScript
node jm2epa.js plan.jmx --name MyScript --seed 1 --out build/

# TypeScript
npx ts-node --transpile-only jm2epa.ts plan.jmx --name MyScript --seed 1 --out build/
```

All three commands emit `build/MyScript.epa`. Identical bytes. Pick whichever runtime fits your pipeline.

---

## Why three ports?

Because different teams have different constraints. DevOps pipelines running `jm2epa.py` shouldn't need Node installed. Migration tools written in Node shouldn't shell out to Python. TypeScript projects want type-checked source they can embed. Keeping three ports in parity costs a small amount of duplicated work and avoids forcing a runtime choice on users. The parity contract is enforced by `tests/parity.sh`, which runs in CI on every push.

## What it converts

| JMeter | Eggplant Performance |
|---|---|
| `TestPlan` | `.epa` project + `project/project.xml` + `gen-options.ini` |
| `ThreadGroup` | `VuType` with default `Action0_Run` |
| `TransactionController` | `Action<N>_<Name>()` method with `StartTransaction` / `EndTransaction` |
| `HTTPSampler` (GET) | `webBrowser.CreateRequest(url).Get()` + `QueryData` |
| `HTTPSampler` (form POST) | `Form` + `InputElement` + `SetMessageBody(form).Post()` |
| `HTTPSampler` (raw body) | `SetMessageBody(postDataString).Post()` with `${var}` → `" + GetString("var") + "` |
| `HeaderManager` | `request.SetHeader(name, value)` |
| `CookieManager` | `webBrowser.EnableCookies()` |
| `CSVDataSet` | Profile-level data source + `GetString(column)` |
| `RegexExtractor` `LB(.*?)RB` | `response.Extract(lb, rb)` (auto-reduced) |
| `RegexExtractor` (other) | TODO stub preserving the original regex |
| `ResponseAssertion` | `VerifyResult(...)` |
| `ConstantTimer` | `Pause(ms)` |
| User-Defined Variables | `Set<string>("name", "value")` in `EPP_BEFORE_RUN` |

The full reference lives in [`docs/element-mapping.md`](docs/element-mapping.md).

## Determinism

Every ZIP entry uses a fixed 1980-01-01 DOS timestamp, and UUIDs come from a seedable CSPRNG keyed by `--seed N`. Two runs with the same seed on any OS, using any of the three ports, produce **bitwise-identical** `.epa` archives. That's what makes byte-level diffing useful when you're iterating on a conversion.

## Installation

### Python (stdlib only)

```bash
# Python 3.9+ required; no dependencies
git clone https://github.com/<you>/jm2epa.git
cd jm2epa
python jm2epa.py --help
```

### Node.js

```bash
npm install    # installs ts-node, typescript, @types/node (dev only)
node jm2epa.js --help
```

### TypeScript

```bash
npm install
npx ts-node --transpile-only jm2epa.ts --help
# or compile once:
npx tsc --project tsconfig.json && node jm2epa.js --help
```

## CLI

```
jm2epa <jmx-file> --name <ScriptName> [--seed N] [--out DIR] [--namespace NS]
```

| Flag | Purpose |
|---|---|
| `--name NAME` | Output archive, VU-type, and C# class name. Required. |
| `--seed N` | Seed for the CSPRNG used to mint UUIDs. Omit for time-based seed (non-deterministic). |
| `--out DIR` | Directory to write the `.epa` into. Default: current directory. |
| `--namespace NS` | Override the generated C# namespace. Default: derived from `--name`. |

## What's in the `.epa`

```
<Name>.epa  (ZIP archive)
├── project/
│   ├── project.xml
│   └── gen-options.ini
├── vuTypes/
│   └── <Name>VU.xml
├── scripts/clr/
│   └── <Namespace>/<Name>.cs     # generated C# virtual-user script
├── profiles/
│   └── <Name>.profile.xml
├── source.csv                     # profile-level data source
├── data/                          # empty; drop CSVDataSet rows here
├── .epaproject
├── MANIFEST.MF
└── README.txt
```

Open the archive in Eggplant Performance Studio → `File` → `Import Project`.

## Parity testing

```bash
bash tests/parity.sh
# PARITY OK (py/js/ts)
```

`tests/parity.sh` runs all three ports against every fixture in `test_jmx/` and byte-compares every entry of every resulting `.epa`. CI runs this on every push — see [`.github/workflows/parity.yml`](.github/workflows/parity.yml).

## Project structure

```
.
├── jm2epa.py                  # Python port
├── jm2epa.js                  # JavaScript port
├── jm2epa.ts                  # TypeScript port
├── jm2epa_plan.md             # Original architecture + roadmap
├── tsconfig.json              # TypeScript compiler config
├── package.json               # Node / TS dev dependencies (ts-node, typescript, @types/node)
├── requirements.txt           # Python dependencies (stdlib-only; file is a no-op cache hint)
├── test_jmx/
│   ├── minimal_get.jmx        # GET + query params
│   ├── transactions.jmx       # TransactionControllers + form POST + ${var} body
│   └── correlation.jmx        # RegexExtractors (both boundary-reducible and complex) + assertions
├── tests/
│   └── parity.sh              # Cross-port byte-parity check
├── docs/
│   ├── architecture.md        # Pipeline, IR, parity contract
│   ├── element-mapping.md     # JMeter → Eggplant reference
│   └── usage.md               # Runnable recipes
├── .github/workflows/
│   └── parity.yml             # CI: runs parity + typecheck on every push
├── README.md                  # This file
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE                    # MIT
```

## Companion: `lr2jm`

If you're coming from LoadRunner, `jm2epa` pairs with the sibling `lr2jm` tool ([open-performance](https://github.com/<you>/open-performance)), which handles the LoadRunner → JMeter hop:

```bash
# LoadRunner → JMeter
python lr2jm.py my_lr_script
# writes my_lr_script/my_lr_script.jmx

# JMeter → Eggplant Performance
python jm2epa.py my_lr_script/my_lr_script.jmx --name MyScript --seed 1 --out build/
# writes build/MyScript.epa
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version:

1. `npm install` and `python --version` (3.9+).
2. Make your change in **all three ports**.
3. Run `bash tests/parity.sh` — it must print `PARITY OK (py/js/ts)`.
4. Add an entry to `CHANGELOG.md` under `[Unreleased]`.

## License

MIT. See [`LICENSE`](LICENSE).

## Tested with

- Apache JMeter 5.3
- Eggplant Performance 10.x
