# Changelog

All notable changes to `jm2epa` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-20

### Added
- Initial release of the `jm2epa` converter in three ports: Python (`jm2epa.py`), JavaScript (`jm2epa.js`), and TypeScript (`jm2epa.ts`).
- Five-stage pipeline: parse → IR → plan → emit → package. Documented in `docs/architecture.md`.
- Deterministic `.epa` archives: fixed 1980-01-01 ZIP timestamps plus a seedable CSPRNG for UUIDs (`--seed N`).
- Element coverage:
  - `TestPlan`, `ThreadGroup`, `TransactionController`
  - `HTTPSampler` — GET, form POST, raw-body POST (with `${var}` → `GetString("var")` substitution)
  - `HeaderManager` (per-request and thread-group-scoped)
  - `CookieManager`
  - `CSVDataSet` (via profile-level data source)
  - `RegexExtractor` with automatic `LB(.*?)RB` → `Response.Extract(lb, rb)` reduction; other shapes preserved as TODO stubs
  - `ResponseAssertion`
  - `ConstantTimer` → `Pause(ms)`
  - User-Defined Variables
- `tests/parity.sh` — cross-port byte-for-byte parity check against every fixture in `test_jmx/`.
- JMX fixtures:
  - `minimal_get.jmx` — GET with query parameters
  - `transactions.jmx` — nested TransactionControllers + form POST + `${var}` body interpolation
  - `correlation.jmx` — boundary-reducible and complex RegexExtractors + ResponseAssertion + ConstantTimer
- `docs/architecture.md` — pipeline, IR shape, parity contract
- `docs/element-mapping.md` — authoritative JMeter-to-Eggplant reference
- `docs/usage.md` — runnable recipes (CLI flags, Studio import, parity runs)
- GitHub Actions workflow (`.github/workflows/parity.yml`) running parity + TypeScript type-check on every push.
- `tsconfig.json` with `@types/node`-backed type-checking; `jm2epa.ts` passes `tsc --noEmit` cleanly.
- `CONTRIBUTING.md` with parity-contract rules and determinism invariants.
