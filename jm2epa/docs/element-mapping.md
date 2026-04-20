# JMeter → Eggplant Performance Element Mapping

This is the authoritative reference for how `jm2epa` translates JMeter test-plan elements into Eggplant Performance constructs. When you change the mapping for an element, update both the converter and this document.

## Test plan structure

| JMeter | Eggplant Performance | Notes |
|---|---|---|
| `TestPlan` | `.epa` project + `project/project.xml` + `project/gen-options.ini` | TestPlan `name` becomes the `.epa` name, VU-type name, and C# class name. |
| `TestPlan.user_defined_variables` | `Set<string>("name", "value")` in `EPP_BEFORE_RUN` region | Emitted once at VU start. |
| `ThreadGroup` | `VuType` (`vuTypes/<Name>VU.xml`) + default `Action0_Run` | One VU type per ThreadGroup. `num_threads` and `ramp_time` become profile-level properties. |

## Flow control

| JMeter | Eggplant Performance | Notes |
|---|---|---|
| `TransactionController` | `Action<N>_<Name>()` method bracketed by `StartTransaction(...)` / `EndTransaction(...)` | `N` is the 1-based index of the controller; `<Name>` is the controller's `testname`. |
| `TransactionController.includeTimers` | Unchanged (timers run inside the action scope regardless) | |
| `LoopController` | Action loop in the C# script | Currently emits `loops=1`; finite loops > 1 are honored in the profile. |

## HTTP requests

| JMeter | Eggplant Performance | Notes |
|---|---|---|
| `HTTPSampler` (method `GET`) | `webBrowser.CreateRequest(url).Get()` | URL built from domain + path + `QueryData`. |
| `HTTPSampler` (method `POST`, form) | `Form` + `InputElement` + `request.SetMessageBody(form).Post()` | Used when `postBodyRaw` is false and Arguments has named parameters. |
| `HTTPSampler` (method `POST`, raw body) | `string postDataStringN = "..."; request.SetMessageBody(postDataStringN).Post()` | Used when `postBodyRaw` is true. `${var}` references become `" + GetString("var") + "` string-concat. |
| Arbitrary HTTP methods (`PUT`, `DELETE`, `PATCH`) | Same pattern as POST, using `.Put()` / `.Delete()` / `.Patch()` | |
| `HTTPSampler.domain` / `port` / `protocol` | `IpEndPoint` + `Protocol` + `Url` | First sampler's host becomes the default `IpEndPoint`; subsequent hosts are declared as additional endpoints. |
| `HTTPSampler.path` | `Url` | Path stripped of query string; query params promoted to `QueryData`. |
| Query parameters on GETs | `QueryData.Add("name", "value")` → `.WithQuery(queryData)` | |

## Headers & cookies

| JMeter | Eggplant Performance | Notes |
|---|---|---|
| `HeaderManager` (per-request) | `request.SetHeader("Name", "Value")` before `.Get()`/`.Post()` | Runs after `CreateRequest`, before the verb call. |
| `HeaderManager` (thread-group scope) | Global header applied to every `request.SetHeader(...)` in the action | Merged with per-request headers; per-request wins on conflict. |
| `CookieManager` | `webBrowser.EnableCookies()` + stub `ResetCookies()` hook | |

## Correlation

| JMeter | Eggplant Performance | Notes |
|---|---|---|
| `RegexExtractor` matching `LB(.*?)RB` | `string refname = response.Extract(lb, rb);` | Auto-reduction when the regex has the classic boundary shape. |
| `RegexExtractor` (any other regex) | `// TODO: port this regex extractor — JMeter regex: <original>` | Preserved verbatim in a comment so the human porter can rewrite it using `ExtractionCursor` or a regex equivalent. |
| `BoundaryExtractor` | Same as reduced `RegexExtractor` — `response.Extract(lb, rb)` | Direct 1:1 mapping. |
| `JSONPostProcessor` | Not yet supported | Emits TODO stub with the JSONPath preserved. |

## Data

| JMeter | Eggplant Performance | Notes |
|---|---|---|
| `CSVDataSet` | Profile-level data source + `GetString("column")` | CSVDataSet `filename` references become `data/<filename>`; the schema is registered in `source.csv`. |
| Thread-safe sharing modes | Not yet honored — treated as per-thread | Shared-across-threads mode will need `GetSharedString` (TODO). |
| `${VariableName}` references in request fields | `" + GetString("VariableName") + "` string-concat | Applied to URL path, query values, header values, form values, and raw bodies. |

## Assertions & timers

| JMeter | Eggplant Performance | Notes |
|---|---|---|
| `ResponseAssertion` (response code field, equals) | `VerifyResult(response.StatusCode == 200, "Status 200")` | |
| `ResponseAssertion` (response text, substring/regex) | `VerifyResult(response.Body.Contains("..."), "...")` | Regex mode emits a `Regex.IsMatch` call. |
| `ConstantTimer` | `Pause(ms)` | Emitted after the last HTTP call in the step. |
| `UniformRandomTimer` | `Pause(min + rng.Next(range))` | Uses the seeded RNG to remain deterministic under a fixed seed. |

## Script regions

Every emitted C# script contains preserved regions that survive regeneration:

| Region | When it's used |
|---|---|
| `EPP_IMPORTS` | Extra `using` directives the human porter adds. |
| `EPP_PRE` | Class-level static helpers. |
| `EPP_SCRIPT` | Free-form script body outside action methods. |
| `EPP_GLOBAL_VARIABLES` | Instance fields shared across actions. |
| `EPP_BEFORE_START_TRANSACTION` | Custom logic before every `StartTransaction`. |
| `EPP_BEFORE_END_TRANSACTION` | Custom logic before every `EndTransaction`. |
| `EPP_BEFORE_REQUEST_SENT` | Hook fired on every request just before it's sent. |
| `EPP_AFTER_RESPONSE_RECEIVED` | Hook fired on every response just after it's received. |

These are emitted as empty `#region`/`#endregion` blocks. Eggplant Studio preserves anything inside them across regeneration.

## What's not yet mapped

The following JMeter elements are on the roadmap but not yet emitted. The converter skips them with a stderr warning so the resulting `.epa` still opens:

- `WhileController`, `IfController`, `ForEachController` (non-trivial conditional control flow)
- `BeanShell` / `JSR223` samplers and assertions (would need a JavaScript or Groovy interpreter; likely TODO-stubbed)
- `JDBC`/`JMS`/`FTP` samplers (protocol coverage beyond HTTP)
- `ThroughputShapingTimer` / `PreciseThroughputTimer` (map to profile-level shaping)
- BlazeMeter / custom plugin elements

PRs adding any of these should add a fixture in `test_jmx/` that exercises the new element.
