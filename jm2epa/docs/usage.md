# Usage Recipes

Everything on this page is runnable from the repo root. For detail on what each JMeter element becomes on the other side, see [`element-mapping.md`](element-mapping.md).

## Converting a single JMX file

```bash
# Python
python jm2epa.py path/to/plan.jmx --name MyScript --seed 1 --out ./out/

# JavaScript
node jm2epa.js path/to/plan.jmx --name MyScript --seed 1 --out ./out/

# TypeScript (ts-node, no separate compile step)
npx ts-node --transpile-only jm2epa.ts path/to/plan.jmx \
    --name MyScript --seed 1 --out ./out/
```

All three commands produce `./out/MyScript.epa`. With the same `--seed`, all three produce byte-identical bytes.

### Flags

| Flag | Purpose |
|---|---|
| `--name NAME` | Output archive, VU-type, and C# class name. Required. |
| `--seed N` | Seed for the CSPRNG used to mint UUIDs. Omit for a time-based seed (non-deterministic). |
| `--out DIR` | Directory to write the `.epa` into. Default: current directory. |
| `--namespace NS` | Override the generated C# namespace. Default: derived from `--name`. |

## Chaining with `lr2jm`

If you're coming from LoadRunner, pair `jm2epa` with the sibling `lr2jm` tool (shipped in the [open-performance](https://github.com/<you>/open-performance) repo):

```bash
# 1. LoadRunner → JMeter
python lr2jm.py my_lr_script
# writes my_lr_script/my_lr_script.jmx

# 2. JMeter → Eggplant Performance
python jm2epa.py my_lr_script/my_lr_script.jmx \
    --name MyScript --seed 1 --out build/
# writes build/MyScript.epa
```

Open `build/MyScript.epa` in Eggplant Performance Studio. The first time you do this you'll usually want to walk through:

1. Profile → set load (VUs, ramp, duration) to match your target workload.
2. Data source → drop your real CSV rows into `data/<filename>.csv`.
3. Script → review any `// TODO: port this regex extractor` comments and rewrite them using `ExtractionCursor` if the boundary auto-reducer didn't match.

## Loading the `.epa` in Eggplant Performance Studio

1. Eggplant Studio → **File** → **Import Project** → select `build/MyScript.epa`.
2. Studio unpacks the archive in-place and opens the project.
3. Right-click the VU type → **Generate Code** (only needed if you plan to modify the C# script — the archive already contains generated code).
4. Press **Run** against the associated profile to execute a smoke test.

If the import fails, confirm that the archive contents are intact:

```bash
unzip -l build/MyScript.epa
# Expect 11 entries: project/*, vuTypes/*, scripts/clr/*, profiles/*, source.csv, data/*, .epaproject, MANIFEST.MF, README.txt
```

## Running parity tests

Before opening a PR, confirm all three ports still agree:

```bash
bash tests/parity.sh
# PARITY OK (py/js/ts)
```

The script runs all three converters against every fixture in `test_jmx/`, then unzips and byte-compares every entry of every resulting `.epa`.

## Running the TypeScript port directly

The easiest way is `ts-node`:

```bash
npm install
npx ts-node --transpile-only jm2epa.ts test_jmx/minimal_get.jmx --name MinimalGet --seed 1
```

If you prefer ahead-of-time compilation:

```bash
npm run build
node jm2epa.js test_jmx/minimal_get.jmx --name MinimalGet --seed 1
```

(Note: the current `tsconfig.json` emits a `.js` next to the `.ts`. If you'd rather route the output to a build folder, add `"outDir": "build"` to `tsconfig.json` and run `node build/jm2epa.js ...`.)

## Checking the contents of an `.epa`

```bash
unzip -p build/MyScript.epa scripts/clr/MyScript/MyScript.cs | less
# or
python -c "import zipfile; zipfile.ZipFile('build/MyScript.epa').printdir()"
```

The generated C# is the most useful artefact to skim — it's what you'll hand-edit in Studio.

## Regenerating fixture output for review

If you're debugging a conversion, it's sometimes useful to inspect the emitted archive directly:

```bash
python jm2epa.py test_jmx/correlation.jmx --name Correlation --seed 1 --out /tmp/epa/
unzip -o /tmp/epa/Correlation.epa -d /tmp/epa/Correlation/
ls /tmp/epa/Correlation/scripts/clr/Correlation/
```

The `--seed 1` flag plus byte-identical ports is what makes textual diffs like this meaningful.
