# Contributing to jm2epa

Thanks for your interest in improving `jm2epa`. This project's core invariant is simple and non-negotiable: **the three ports (Python, JavaScript, TypeScript) produce byte-identical `.epa` archives for every fixture under a fixed seed.** Every change has to preserve that.

## Development setup

```bash
git clone https://github.com/<you>/jm2epa.git
cd jm2epa

# Node + TypeScript (dev deps only)
npm install

# Python (stdlib only; this is a no-op)
pip install -r requirements.txt
```

## Running the converter

```bash
# Python
python jm2epa.py test_jmx/minimal_get.jmx --name MinimalGet --seed 1 --out build/

# JavaScript
node jm2epa.js test_jmx/minimal_get.jmx --name MinimalGet --seed 1 --out build/

# TypeScript (no compile step)
npx ts-node --transpile-only jm2epa.ts test_jmx/minimal_get.jmx --name MinimalGet --seed 1 --out build/
```

All three must produce identical `build/MinimalGet.epa` bytes.

## Running parity tests

```bash
bash tests/parity.sh
# Expected: PARITY OK (py/js/ts)
```

The script runs every port against every fixture and byte-compares every ZIP entry. If any byte differs, it prints the diverging files with sizes. CI runs the same command on every push.

## Type-checking TypeScript

```bash
./node_modules/.bin/tsc --noEmit --project tsconfig.json
```

`jm2epa.ts` must type-check cleanly. `@types/node` is the only type dependency.

## Adding a new JMX fixture

1. Drop a hand-written `.jmx` into `test_jmx/`. Keep it small and readable — these are reviewed manually.
2. Add it to the `FIXTURES` table in `tests/parity.sh`.
3. Run `bash tests/parity.sh` and confirm all three ports produce the same output.
4. If the fixture exercises a JMX element not already covered, document the mapping in `docs/element-mapping.md` and add a `CHANGELOG.md` entry.

Good fixtures exercise **one specific feature** — a single transaction controller, a single extractor type. Avoid giant everything-in-one-file fixtures; they make diffs unreadable.

## Modifying a converter

Every port runs the same five-stage pipeline:

```
parse → IR → plan → emit → package
```

See `docs/architecture.md` for the IR contract. When you change one port:

1. Apply the matching change to the other two.
2. Run `bash tests/parity.sh`.
3. Run `tsc --noEmit` for the TS port.

### Determinism rules (must not be violated)

- All ZIP entries use the fixed 1980-01-01 00:00:00 timestamp (DOS date `0x0021`, DOS time `0x0000`).
- UUIDs come from the seeded CSPRNG (`UuidSource`). **Never** call `Guid.NewGuid()`, `uuid.uuid4()`, or `crypto.randomUUID()` directly in an emitter path.
- Iterate maps/dicts in **insertion order**; never rely on hash-implementation order.
- Sort deterministically when you have to iterate an unordered collection.

## Commit style

Short imperative subject (≤72 chars), optional body. Example:

```
Auto-reduce LB(.*?)RB regex to Response.Extract

RegexExtractors whose pattern matches the classic LB(.*?)RB shape are
now emitted as Response.Extract(lb, rb). Other shapes remain TODO
stubs preserving the original regex in a comment.
```

## Pull request checklist

- [ ] `bash tests/parity.sh` prints `PARITY OK (py/js/ts)`
- [ ] `./node_modules/.bin/tsc --noEmit --project tsconfig.json` is clean
- [ ] If adding fixtures: new entry registered in `tests/parity.sh`
- [ ] If changing element mapping: `docs/element-mapping.md` updated
- [ ] If changing the IR or pipeline: `docs/architecture.md` updated
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]`

## Reporting bugs

Open a GitHub issue with:

- The `.jmx` input (or a minimal reproducer).
- The command you ran (which port, which flags).
- The expected vs. actual `.epa` contents or error message.
- Versions: `python --version`, `node --version`, and `./node_modules/.bin/tsc --version` if TS-related.

The parity contract means any bug that affects output is a bug in *all three ports*, so please don't open separate issues per language.
