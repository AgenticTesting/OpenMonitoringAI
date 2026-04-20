#!/usr/bin/env bash
# tests/parity.sh — Verify jm2epa.py / jm2epa.js / jm2epa.ts produce byte-identical .epa archives.
#
# Runs all three converters against every JMX fixture in test_jmx/ and compares every
# entry of every resulting .epa zip. Exits 0 on parity, 1 on any divergence.
#
# Usage: bash tests/parity.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/py" "$TMP/js" "$TMP/ts"

declare -A FIXTURES=(
  [minimal_get]=MinimalGet
  [transactions]=Transactions
  [correlation]=Correlation
)

have_tsnode=0
if [ -x "./node_modules/.bin/ts-node" ]; then
  have_tsnode=1
fi

for src in "${!FIXTURES[@]}"; do
  name="${FIXTURES[$src]}"
  echo "== $name =="
  python3 jm2epa.py "test_jmx/$src.jmx" --name "$name" --seed 1 --out "$TMP/py/" >/dev/null
  node     jm2epa.js "test_jmx/$src.jmx" --name "$name" --seed 1 --out "$TMP/js/" >/dev/null
  if [ "$have_tsnode" = 1 ]; then
    ./node_modules/.bin/ts-node --transpile-only jm2epa.ts "test_jmx/$src.jmx" --name "$name" --seed 1 --out "$TMP/ts/" >/dev/null
  fi
done

python3 - "$TMP" "$have_tsnode" <<'PY'
import os, sys, zipfile
tmp, have_ts = sys.argv[1], sys.argv[2] == "1"

def entries(path):
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in sorted(z.namelist())}

def diff(a, b, label):
    ka, kb = set(a), set(b)
    bad = 0
    for n in ka ^ kb:
        print(f"  {label}: only one side has {n}"); bad += 1
    for n in sorted(ka & kb):
        if a[n] != b[n]:
            print(f"  {label}: differs {n} ({len(a[n])} vs {len(b[n])} B)"); bad += 1
    return bad

total = 0
fixtures = ["MinimalGet", "Transactions", "Correlation"]
for f in fixtures:
    py_zip = os.path.join(tmp, "py", f"{f}.epa")
    js_zip = os.path.join(tmp, "js", f"{f}.epa")
    py = entries(py_zip); js = entries(js_zip)
    total += diff(py, js, f"{f} py/js")
    if have_ts:
        ts_zip = os.path.join(tmp, "ts", f"{f}.epa")
        ts = entries(ts_zip)
        total += diff(py, ts, f"{f} py/ts")
        total += diff(js, ts, f"{f} js/ts")

if total == 0:
    suffix = " (py/js/ts)" if have_ts else " (py/js — ts-node not installed)"
    print(f"PARITY OK{suffix}")
    sys.exit(0)
print(f"PARITY FAILED ({total} diffs)")
sys.exit(1)
PY
