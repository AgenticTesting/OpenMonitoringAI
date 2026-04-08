# LoadRunner to JMeter Converters

A collection of tools for converting LoadRunner performance test assets into Apache JMeter format. Includes both a **correlation rules converter** and a **full script converter** available in four languages.

---

## Converters at a Glance

| Script | Language | What It Converts | Output |
|--------|----------|-----------------|--------|
| `app.py` | Python | Correlation rules (`.cor`) | BlazeMeter Correlation Recorder JSON |
| `lr2jm.pl` | Perl | Full LR script directory | JMeter `.jmx` test plan |
| `lr2jm.py` | Python | Full LR script directory | JMeter `.jmx` test plan |
| `lr2jm.js` | JavaScript | Full LR script directory | JMeter `.jmx` test plan |
| `lr2jm.ts` | TypeScript | Full LR script directory | JMeter `.jmx` test plan |

---

## 1. Correlation Rules Converter (`app.py`)

Converts LoadRunner correlation rule files (`.cor`) into JSON for JMeter's BlazeMeter Correlation Recorder plugin.

### Prerequisites

- Python 3
- `pip install -r requirements.txt`
- JMeter with BlazeMeter Correlation Recorder plugin

### Usage

```bash
python app.py -f <your-LoadRunner-Correlation-File>
```

Example:

```bash
python app.py -f LR.cor
```

The tool prompts for metadata (id, description, version, components, response filters). Press Enter to accept defaults.

### Output

Two JSON files are created in a folder named after the first correlation group:

- `{id}-{version}-template.json` — correlation rules with regex extractors
- `{id}-repository.json` — version metadata for JMeter's plugin manager

### Loading Rules in JMeter

1. Add `bzm - Correlation Recorder` to your test plan
2. Click `Load Template` > `Config`
3. Enter a unique `Id` and the `URL` where the JSON files are hosted
4. Install and load the rules from Templates Manager
5. Fill in `Match Number`, `Group Number`, and `Correlation Replacement` fields as needed

---

## 2. Full Script Converter (`lr2jm`)

Converts an entire LoadRunner script directory into a runnable JMeter `.jmx` test plan. Available in Perl, Python, JavaScript, and TypeScript — all produce identical output.

### What It Converts

| LoadRunner Feature | JMeter Equivalent |
|---|---|
| `web_url()` | HTTPSampler (GET) |
| `web_submit_data()` | HTTPSampler (POST) with form parameters |
| `web_custom_request()` | HTTPSampler (custom method) with body parameters |
| `web_reg_save_param()` | RegexExtractor post-processor |
| Parameter data files (`.dat`) | CSVDataSet (`.csv`) |
| `{ParamName}` references | `${VariableName}` substitution |

### JMX Structure Generated

```
jmeterTestPlan
  └── TestPlan
       └── ThreadGroup (1 thread, 1 loop)
            ├── HTTP Request Defaults (port 80)
            ├── HTTP Cookie Manager
            ├── CSVDataSet (one per parameter table)
            └── HTTPSampler (one per request)
                 └── RegexExtractor (for correlations)
```

### Input: LoadRunner Script Directory

The converter expects a directory containing:

```
MyScript/
  MyScript.usr        # Script manifest (lists .c action files)
  MyScript.prm        # Parameter definitions (optional)
  Action.c            # Action file(s) with web_* function calls
  users.dat           # Parameter data file(s) (optional)
```

### Usage

Choose whichever language runtime you have available:

**Perl**
```bash
perl lr2jm.pl <LoadRunner_Script_Directory>
```
Requires: `XML::DOM`, `XML::Tidy`, `File::Util`

**Python**
```bash
python lr2jm.py <LoadRunner_Script_Directory>
```
Requires: Python 3.9+ (stdlib only, plus `colorit` for colored output)

**JavaScript**
```bash
node lr2jm.js <LoadRunner_Script_Directory>
```
Requires: Node.js (no dependencies)

**TypeScript**
```bash
npx tsc lr2jm.ts --strict --target ES2020 --module commonjs --types node
node lr2jm.js <LoadRunner_Script_Directory>
```
Requires: Node.js, TypeScript, `@types/node`

### Output

- `<ScriptDir>/<ScriptName>.jmx` — complete JMeter test plan
- `<ScriptDir>/<tablename>.csv` — converted parameter data files (if `.dat` files exist)

### Example

```bash
python lr2jm.py test_lr_script
# Output: test_lr_script/test_lr_script.jmx
```

---

## Project Structure

```
.
├── app.py                  # Correlation rules converter (.cor → JSON)
├── lr2jm.pl                # Full script converter — Perl (original)
├── lr2jm.py                # Full script converter — Python
├── lr2jm.js                # Full script converter — JavaScript
├── lr2jm.ts                # Full script converter — TypeScript
├── LR.cor                  # Sample correlation rules file
├── ASP.NET/                # Sample app.py output
├── test_lr_script/         # Sample lr2jm input/output
├── utils/
│   ├── __init__.py
│   └── display.py          # Colored console output helper
├── requirements.txt        # Python dependencies
├── package.json            # Node.js/TypeScript dependencies
└── assets/                 # README images
```

---

## Tested With

- Micro Focus LoadRunner 2020 SP 2
- Apache JMeter 5.3
- BlazeMeter Correlation Recorder 1.1

## License

MIT
