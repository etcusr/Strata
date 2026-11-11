# Context compaction diagnostics and safety

This change covers summary completion checks, optional lossless text fragmentation, diagnostic measurements,
linear history splitting, persistent tool archives, and optional pressure/checkpoint policies. It keeps the chosen model and the Harness. New policies are opt-in; no engine or KV layout changes are made.

## Configuration

Desktop users can save the same plugin keys in `<dataDir>/agent/context-policy.json`.
The file validates the keys listed below; unknown keys and out-of-range values are errors.
It is checked when the host builds a profile. A changed policy restarts the Harness after its current turns
are idle. Missing files retain the old defaults; invalid files produce a configuration error.
Environment variables override the file; `0` explicitly disables a boolean option.

Alternatively, set these variables in the **host process environment before starting the host**. They are serialized into
its generated `strata-context` plugin configuration; they are not read from the agent's filtered environment.
An existing running Harness needs to be restarted to read a changed profile.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STRATA_CONTEXT_DIAGNOSTICS=1` | off | Numeric diagnostic records in the Harness log. |
| `STRATA_CONTEXT_LOSSLESS=1` | off | Send every text fragment of oversized messages, in order. |
| `STRATA_CONTEXT_SUMMARY_RETRIES=0..3` | 2 | Retries per incomplete request and maximum repartitions. |

The corresponding plugin keys are `diagnostics`, `preserveOversizedMessages`, and `summaryRetries`.
`buildProfile({ contextPolicy: {...} })` also accepts these keys. With no variables set, the generated
profile is unchanged. The summary safety checks apply without opting in. Successful small summary requests
keep their original message contents, apart from the pre-existing summary language rule.

A retry first doubles the summary output limit if the estimated full request still fits. If that cannot
work, or retries fail, the plugin retries smaller input pieces. Each piece must end with `stop` and contain
non-whitespace text before it can be carried forward. Missing finishes, tool-call finishes, or persistent
truncation fail the operation. No partial checkpoint is yielded as a successful replacement. Cancellation
and transport failures propagate. The retry limit is bounded at both levels; it is not a single global
request-count limit. The Harness may additionally apply its own compaction retry policy.

## Large messages

Legacy clipping remains the default for compatibility. In lossless mode, a tool exchange that fits stays
unchanged. An oversized exchange becomes quoted transcript fragments with source message index, available
id/seq, role, block index, tool-call identifier, and character offset. Offsets are UTF-16 code units.
Text and reasoning blocks retain every character; surrogate pairs stay together. Tool-call JSON is quoted
as a whole atomic block, never sent as a partial executable call. If an atomic block cannot fit, compaction
fails and retains history. This intentionally trades more model requests for retaining source text.

The tests prove complete delivery and sequential carry on scripted outputs. They do not prove that a model
will remember every fact in arbitrary long logs. Semantic retention requires a model evaluation.

## Measurements

`strata-context-metric` records contain no prompts, answers, paths, tool arguments, session identifiers,
or provider error bodies. Request records use numeric compaction/request identifiers for correlation.

- `prepare-history`, `token-meter`, `estimate-tokens`, `estimate-tools`, `split-history`: synchronous wall time
  inside the plugin, in milliseconds. This is not all JavaScript time inside the Harness.
- `summary-request`: each summary attempt, including failed attempts.
- `first-reply`: the first ordinary adapter request after a committed compaction, including the
  `prepareCall` / `streamWithSnapshot` path.
- Requests report elapsed time, first text/reasoning delta, time after that delta, finish kind, available
  input/cache/output/reasoning counts, and Node process RSS.

The installed pi-ai adapter does not expose separate engine queue, prefill, or generation durations.
These fields are `null`, not inferred from time to first delta. It folds reasoning into output tokens;
separate reasoning counts are included only if an adapter supplies them. Node RSS is not Metal/model memory.
The separate model benchmark records engine timing fields from raw SSE when supplied by the server.

## Reproduction

From the repository root, using the same Node runtime as the installed application:

```sh
STRATA_HARNESS_DIR=/path/to/Strata.app/Contents/Resources/harness node --test \
  apps/host/tests/agent-context.test.mjs apps/host/tests/context-compaction-safety.test.mjs

git show 9fab487:apps/host/server/agent/context-budget.mjs > /tmp/context-budget-before.mjs
node --expose-gc apps/host/scripts/bench-context-split.mjs /tmp/context-budget-before.mjs
node --expose-gc apps/host/scripts/bench-context-split.mjs
```

The split benchmark makes five timed runs after warmup. It hashes the complete output, including boundaries,
to detect behavior changes. Estimates are reused only within one synchronous split; no mutable history,
model, tool list, or template receives a persistent estimate cache.

Measured on Apple M1 Max, bundled Node v24.12.0, 10 November 2026:

| Fixture | Before, median ms | After, median ms |
| --- | ---: | ---: |
| 30,000 short messages | 297.578 | 2.106 |
| 6,000 tool exchanges (12,000 messages) | 134.482 | 0.676 |
| 200 large results | 0.322 | 0.188 |

All three output hashes matched. Process peak RSS was 252.5 MiB before and 255.1 MiB after; this includes
fixture creation and output hashing, not just splitting. No model ran in this benchmark. Another task was
performing Metal calibration, so these are local diagnostic measurements rather than an isolated system benchmark.

For a small real-model ABBA check, keep the same loaded model, quantization, engine settings, and window.
Use an idle server and a baseline checkout that contains the old plugin and its relative imports:

```sh
node apps/host/scripts/bench-context-model.mjs \
  --url http://127.0.0.1:PORT/v1 --model MODEL --window 131072 \
  --baseline /path/to/baseline/apps/host/server/agent/plugins/strata-context.mjs \
  --output /tmp/context-model-results.json
```

If needed, supply the API key through `STRATA_BENCH_API_KEY`. The script does not load a model or clear its KV
cache. It uses synthetic data, deterministic sampling, and thinking off in both variants. It checks four exact
facts in the summary and the following reply, and saves metrics/booleans only. It uses a minimal OpenAI SSE
adapter; real Harness integration is tested separately. This small fixture does not exercise window overflow.
Cold-versus-warm effects must be read from the reported cache counts, not attributed to the code change.

## Validation and remaining work

39 context tests and 16 related compaction/reply-recovery tests passed with bundled Node v24.12.0 and Harness 0.2.1-alpha.3 (commit 571902028a).
The two truncation regression tests fail against the original plugin. A real Harness integration test verifies
that failed compaction leaves original Russian text, paths, and numbers in the next model request.

The broader host suite recorded 1,515 passes, 12 failures, and 124 skips at the first full run. All 12 failing
tests also failed on a separate HEAD copy. That copy contained only `apps/host`, so additional missing-component
failures in that copy are not a full-repository baseline. The 12 common failures concern folders, packaged
Control/update handling, settings, translations, and CSS; no context test failed in that full run.

The second stage adds independent local budgets and a repeat-cycle benchmark (see below). Exact full-request token counting remains separate: the available count endpoint renders Anthropic requests, while this Harness sends OpenAI requests. Equivalence of tools, thinking and templates must be established before that count replaces the conservative estimate. No KV state is relocated under a changed prefix.

## Real-model check on this computer

The ABBA check completed on the same `q2_0_hybrid` model (health name
`qwen3.8-flash-next-hybrid-uncensored`), 131,072-token window, engine 0.1.58-metal,
FP16, calibrated kernels, and spec 2. The other task's GPU calibration had finished before this test.
No model settings changed between runs. All four exact facts were present both in every summary and in
every subsequent recall answer. This fixture uses one compaction cycle and fits the window; it does not
establish semantic retention after fragmenting a history larger than 128K or after repeated cycles.

| Run | Summary seconds | Prefill seconds | Generation seconds | Cached input tokens | Next reply seconds | Facts recalled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1: before | 37.054 | 34.221 | 2.796 | 0 | 3.606 | 4/4 |
| 2: after | 3.027 | 0.154 | 2.866 | 8562 | 2.334 | 4/4 |
| 3: after | 3.066 | 0.124 | 2.935 | 8562 | 2.318 | 4/4 |
| 4: before | 3.097 | 0.130 | 2.959 | 8562 | 2.414 | 4/4 |

The first run was cold; all following summaries reused 8,562 input tokens. The large drop from 37 seconds
to about 3 seconds is cache reuse, not a measured speedup from the plugin. Warm old/new runs are close.
Instrumented preparation and estimation took 0.131 and 0.122 ms in the two new-code runs. These do not
include all Harness/adapter JavaScript work. Raw SSE supplies prefill and generation timings; separate
queue duration was not reported.

The server reported unchanged free Metal memory (4,844 MiB), conversation-cache growth from 0 to
610,147,176 bytes, and total system RAM use rising from 25,858,064,384 to 60,775,661,568 bytes across the
whole ABBA sequence. These are system/cache snapshots, not isolated per-variant model peaks; lazy model
page reads and cache growth cannot be assigned to the code change from this measurement.

## Installed verification

On 10 November 2026, four host files (context-budget, strata-context plugin, profile, agent-bridge) were
installed in the local Strata.app after backing up their originals. The app's ad hoc signature passed
`codesign --verify --deep --strict`. The persistent policy enables lossless fragments and numeric diagnostics,
with two retries. A synthetic no-tools request through the installed host/Harness returned the expected
marker without errors; the generated profile contained both enabled options. The original q2_0_hybrid model
was reloaded with its saved 128K window and spec 2 settings. No GitHub push was performed.

The lossless option applies to text reaching this plugin. The separate existing tool-result pruner can
already remove text earlier; the on-demand web tool can also condense large JSON. These remain unchanged.
Preserving their complete originals with retrieval links is a separate follow-up, not guaranteed by this option.


## Persistent tool archives and fewer summaries (second stage)

Set these keys in the same `agent/context-policy.json`. Boolean options default to false.

| Key | Default | Allowed values / effect |
| --- | --- | --- |
| `archiveToolResults` | false | Keep approved tool content in private durable files; bound large inline text. |
| `archiveInlineChars` | 6000 | Integer 2048–32000; includes the retrieval notice. |
| `archiveKeepRecent` | 8 | Integer 2–64; recent tool observations left intact during pressure pruning. |
| `archiveMinPruneTokens` | 4096 | Integer 512–32768; minimum estimated batch saving before rewriting old observations. |
| `skipLowPressureCompaction` | false | Guard stops trigger a summary only at measured local context pressure; actual overflow recovery remains. |
| `structuredSummaries` | false | Strengthen checkpoint guidance: exact constraints, evidence, decisions, failures and next actions; distinguish sources and explicit supersession. |
| `thresholdRatio` | 0.75 | Number 0.5–0.9; also capped by available reply/headroom space. Local routes only. |
| `replyReserveTokens` | 20% of window, capped at 32768 | Integer 512–32768; further capped at the default reserve for the window. Generation ceiling remains independent. |
| `summaryTokens` | 20% of window, 2048–8192 | Integer 1024–16384; further capped at the default summary ceiling for the window. |
| `retainTokens` | Harness default ratio 0.16 | Integer 1024–65536; capped at 25% of the window. Recent verbatim history budget. |

The budgets apply consistently to ordinary local routes, shaped local routes, and the host's pre-send fit
check. Settings with no opt-ins preserve the existing generated profile. A 131072-token window still
starts compaction at 98304 with default budgets. For example, an explicitly chosen 8192 reply reserve and
0.85 ratio permit 111411; raising the ratio alone is capped by the unchanged reply reservation. The more
aggressive example is not enabled automatically.

The archive root is host-owned: `<dataDir>/agent/tool-results`. A session hash selects a private directory;
content-addressed `.json` files preserve all accepted content blocks, and `.txt` files preserve joined text.
Per-call receipts identify the tool and paths. Files are created exclusively with mode 0600, directories
with 0700; existing symlinks are rejected. Hash verification runs before old content can be replaced by a
pointer, and the current visible result must match its receipt. Missing/corrupt files and reused call IDs
cannot justify dropping a different result. Failure to save leaves the accepted inline content unchanged.
Other post-execution policy decisions (including redaction, value replacement and refusal) retain authority.
The existing Harness spill backend uses the same persistent root, with expiration disabled, so a result
spilled by that backend remains retrievable too.

Large previews contain the beginning, end, selected error/requirement lines, and a full-text/JSON locator.
This keyword preview is not a semantic guarantee. Read/grep can retrieve omitted details; explicit archive
reads are not recursively previewed. Non-text blocks stay inline. Failed results are archived but are not
shortened by this feature. The on-demand web JSON condenser is disabled under this opt-in, so it cannot
remove the middle before archiving. Tools can still impose their own upstream limits: this archive saves
what the tool returned, not an entire web page or file that the tool never read. Earlier already-truncated
results cannot be reconstructed retrospectively.

Only a pressure check invokes batch pruning. It keeps recent observations and errors, touches no user
message or tool arguments, and commits only when the configured minimum saving is available. It records
normal Harness prune/replacement events, retaining valid tool-call/result pairs. If clearing observations
brings pressure below the threshold, the Harness does not ask an LLM for a summary. A plain search/rewrite
loop stop is no longer sufficient reason to force `/compact`. Unknown pressure defers to the normal next
request checks; explicit user `/compact` remains available.

Every successful summary receives a deterministic session archive locator after model generation. It does
not depend on the model remembering paths; the locator survived ten scripted successive summaries even
when the model omitted every path. This guarantees a retrieval route, not semantic recall of every fact.
Archives have no automatic expiration: deleting them makes their locators unusable. They contain tool output
and should be treated like the original local session history.

The existing Harness checkpoint prompt already has structured sections. The optional guidance reinforces
provenance, exact identifiers and explicit updates rather than adding an independent memory service.

Reproduce the new checks:

```sh
STRATA_HARNESS_DIR=/path/to/harness node --test \
  apps/host/tests/tool-archive.test.mjs apps/host/tests/agent-turn-guard.test.mjs \
  apps/host/tests/agent-context.test.mjs apps/host/tests/context-compaction-safety.test.mjs
node apps/host/scripts/bench-tool-archive.mjs
# Add --cycles 10 to bench-context-model.mjs for checkpoints after cycles 2, 5 and 10.
```

Real Harness checks cover full-result retrieval through direct tools and nested tool_dispatch, resumption
after a Harness restart, stable tool schemas, low-pressure guard stops, actual context pressure, and a batch
of 14 tool observations that can be cleared without an LLM summary. The latter deliberately sets the
threshold to 0.5, retains four observations and requires at least 512 estimated saved tokens to exercise
the pressure path on a compact synthetic fixture. Production defaults remain 0.75 / eight / 4096.

Design references: [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing),
[Manus context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus),
and [effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents).
These motivate durable retrieval and preserving recent observations; they are not performance evidence for Strata.


### Second-stage results on this computer

Bundled Node v24.12.0 and the real Harness passed 87 targeted tests. A final archive-only rerun passed
13 tests, including explicit reads through nested tool_dispatch; a final profile check passed three
budget/configuration tests. Six default-profile comparisons (8K/32K/128K windows, direct/on-demand tools)
matched the original generated bytes after normalizing only the absolute checkout prefix in plugin paths.
The system Node v26.13.0 full host suite completed with 1529 passes, 12 failures and 130 skips; the same
12 failures were present in the first-stage baseline. The bundled Node 24 full-suite attempt ended early
with pending-test cancellations, so it is not counted as a completed full-suite validation.

The synthetic archive benchmark saved 32 full results totalling 1729260 text characters. Their inline
previews totalled 125078 (92.77% fewer characters); all originals matched on readback. Disk writes plus
receipt hashes/previews took 30.90 ms, separately generating previews took 7.20 ms, and readback comparison
2.04 ms; process RSS was 60 MiB. This is one local JS/disk measurement, not model-token or end-to-end speedup.

The actual q2_0_hybrid model, 131072 window, thinking off and spec2 with the coordinated Cyrillic MTP vocabulary
retained all four exact facts after cycles 2, 5 and 10, and recalled all four in the final answer, in both
variants. Facts were a Russian prohibition, the number 7319, a Cyrillic path and a shell command. The simple
baseline used 1543 output tokens over 11 requests and 80.63 seconds; the structured variant used 3794 output
tokens and 138.67 seconds. This is a small before/after test with warm-cache effects, not a statistical speed
comparison. There was no demonstrated retention improvement on this fixture, so structuredSummaries remains
false in the installed policy. No more aggressive threshold/reply budgets were enabled.

The installed app smoke read a 28990-character tool result, received a preview missing the middle fact,
then recovered it using grep on the published archive. All five resulting receipts verified against their
content hashes. A final restart and short real-agent response succeeded; nine installed runtime files
matched the checkout and installation manifest byte for byte. Model configuration and Metal source changes
belonging to the coordinated session were not included in the host patch.
