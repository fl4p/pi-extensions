# Codex adversarial review of 7f22757

Cold run 2026-08-24 via `codex exec`, told not to re-report the ac40780
findings. All three findings were verified against the pi sources and fixed.

## Findings

1. **(c) Real design defect — rejection can cause an immediate resend loop, and `agent_settled` is not causally tied to the in-flight batch.**

   On any unacknowledged `agent_settled`, the handler requeues the batch and immediately calls `dispatchPendingWakes()` at [bash-background.ts:257](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:257) and [bash-background.ts:268](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:268).

   The principal unacknowledged rejection is the core `activeRun` guard at [agent.js:226](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js:226). But the rejected `_runAgentPrompt()` still emits `agent_settled` from its `finally` at [agent-session.js:744](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:744), even though the run owning `activeRun` remains active. That settlement also sets `_isAgentRunActive=false`.

   Consequently the retry immediately attempts another non-streaming `_runAgentPrompt`, hits the same guard, emits another false settlement, and repeats at microtask speed. The 500 ms pump is bypassed entirely. This can produce a hot error/resend loop until the actual owner finishes, potentially starving it.

   The same lack of causality can requeue a batch that was accepted: another wrapper’s nested `agent_settled` can occur while the accepted run is still inside its awaited `agent_start` handlers, before its prompt `message_end`. The batch is then resent even though its acknowledgement is about to arrive.

   The rejection test hides this by rejecting exactly once and allowing the next send immediately at [bash-background.test.mjs:43](/Users/fab/dev/vibe/pi-extensions/tests/bash-background.test.mjs:43). A real active-run rejection does not clear the owning `activeRun`. The test at [bash-background.test.mjs:318](/Users/fab/dev/vibe/pi-extensions/tests/bash-background.test.mjs:318) would therefore pass while the production implementation spins.

2. **(c) Real design defect — several post-`input` exits orphan `promptPending`, and its stale timestamp can undermine a later prompt.**

   Every non-streaming path that reaches pre-prompt `_checkCompaction()` does pass through `emitInput` first, so the desired compaction path is covered. However, [bash-background.ts:228](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:228) has no matching close for prompt preflight exits:

   | Path | Gate consequence |
   |---|---|
   | Extension command handled | Safe: happens before `input` at [agent-session.js:799](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:799). |
   | Manual-compaction-in-progress throw | Safe: happens before `input` at [agent-session.js:807](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:807). |
   | Later input handler returns `handled` | Orphaned until another run or deadline; prompt returns at [agent-session.js:815](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:815). No such other handler exists in the checked extension set, so currently unlikely. |
   | Missing model/API key or auth-check failure | Orphaned at [agent-session.js:847](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:847). Model absence is unusual after a job was armed, but auth expiry/network failure is credible over hours. |
   | Template expansion failure | The installed implementations are effectively non-throwing for ordinary strings: skill reads are caught and template argument parsing does not throw. Pathological only. |
   | Streaming prompt | A real active run already exists, so its eventual `agent_settled` opens the gate. |

   The pump bounds a pending wake’s delay to the 30-minute deadline, but that is still a substantial unattended stall.

   More importantly, another `input` does not refresh `gateSince`, because `shutGate()` stamps only when both flags were previously clear at [bash-background.ts:206](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:206). If an abandoned latch is older than 30 minutes, a wake arriving during the next legitimate prompt immediately expires the old deadline and dispatches inside that prompt—the very boundary the gate was added to protect.

   Pi exposes no general “prompt preflight finished without a run” extension event, so the present `input`-to-lifecycle model cannot be made exact solely by adding another existing event.

3. **(c) Incomplete fix of prior finding 3 — the active deadline can still create a spurious wake during legitimate compaction.**

   The pump fixes the previous *passive* timeout: pending terminal work now causes regular deadline checks. But [gateShut()](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:196) actively calls `openGate()` after 30 minutes even when `compacting=true`.

   `agentBusy` protects post-turn compaction, but pre-prompt and manual compaction run with `agentBusy=false`. A legitimate compaction lasting over 30 minutes therefore launches the wake concurrently.

   The wake cannot alter the already-running summarization request itself, but this is not a harmless collision:

   - The wake starts against the pre-compaction message snapshot.
   - Compaction later appends its stale summary and replaces `agent.state.messages` at [agent-session.js:1670](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1670).
   - The wake continues from its private old context while persisting messages into the newly replaced state.
   - In the pre-prompt case, the original prompt then reaches `_runAgentPrompt()` and can hit the active-run guard.

   Thus the summary text is not byte-corrupted, but its integration into live/session state can be invalidated, and the original prompt can be dropped. This preserves the unsafe half of the previous timeout finding, merely moving it from 15 to 30 minutes.

   `input` followed by `session_before_compact` does retain the original input timestamp as intended. Given the safety goal, that is undesirable: authentication/template time consumes part of the compaction allowance, and an older abandoned prompt can supply the timestamp for an entirely new compaction.

## Mechanisms that survive review

- The normal `session_compact` race from `ac40780` is fixed: successful pre-prompt compaction remains gated through the original run’s `agent_start`/`agent_settled`.
- Pi preserves `details.wakeId` unchanged through `sendCustomMessage` at [agent-session.js:1068](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1068), and prompt `message_end` is emitted before the provider call at [agent-loop.js:49](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:49).
- A normally consumed steered custom message also retains `details` and emits `message_end` when the steering queue is drained. Under healthy bookkeeping this extension cannot send while streaming because `agentBusy` blocks it.
- Returning `undefined` from this extension’s `message_end` handler does not interfere with later replacements; `emitMessageEnd` simply continues its chain at [runner.js:610](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:610).
- The pump timer itself cannot spin hot: only one timer is armed and it runs at 2 Hz. `hasPendingWork()` and `drainMonitorBatch()` use matching stopped/done/pending predicates, and finished jobs are removed.
- `unref()` means the pump alone will not keep Node alive. The harness’s `waitFor` timers mask that, but an actual interactive/unattended pi process normally has other referenced handles.
- `background_stop` still clears pending monitor output and deferred batches at [bash-background.ts:648](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:648). The pump holds no snapshot, so it cannot later resurrect that output. I found no batching regression.

## Verification

`npm run typecheck` passes.

The requested `.tmp` test run was environmentally inconclusive because `.tmp` does not exist. Retrying with `/tmp` confirmed the sandbox rejects temp creation with `EPERM`; 13 process/temp tests failed as cascades, while 7 non-temp tests passed. I did not treat those failures as findings.

