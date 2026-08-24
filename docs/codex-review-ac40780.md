# Codex adversarial review of ac40780

Run 2026-08-24 via `codex exec`. Findings 1-4 were verified against the pi
sources and fixed in 7f22757; the surviving claims are recorded as-is.

## Findings

1. **(c) Real design defect — `session_compact` dispatches before the original prompt resumes.**

   The handler clears the gate and immediately calls `dispatchPendingWakes()` at [`bash-background.ts:207`](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:207).

   In pre-prompt auto-compaction, the real ordering is:

   1. `prompt()` awaits `_checkCompaction()` at [`agent-session.js:865`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:865).
   2. Auto-compaction installs the summary into session and agent state at [`agent-session.js:1670`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1670).
   3. Pi awaits `session_compact` at [`agent-session.js:1678`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1678).
   4. Your handler dispatches a wake. `sendCustomMessage()` immediately starts `_runAgentPrompt()` at [`agent-session.js:1089`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1089).
   5. `_runAutoCompaction()` returns, and the original `prompt()` proceeds to its own `_runAgentPrompt()` at [`agent-session.js:919`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:919).
   6. Pi-agent-core rejects the second run because the wake run owns `activeRun`, at [`agent.js:226`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js:226).

   This should not destroy the newly installed summary, but it can drop the original user prompt and reproduce “Agent is already processing a prompt.” Worse, the rejected wrapper executes its `finally` and emits `agent_settled` at [`agent-session.js:752`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:752), setting `_isAgentRunActive` false while the wake’s core run is still active.

   The post-turn path does not have this problem because `agentBusy` remains true through its `session_compact`.

2. **(c) Real design defect — a delivery acknowledgement is observable; the stated reason for accepting loss is incorrect.**

   `drainMonitorBatch()` destroys pending output at [`bash-background.ts:217`](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:217) before the fire-and-forget call at [`bash-background.ts:244`](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:244).

   But a triggered custom message produces extension-visible `message_start` and `message_end` events:

   - Agent-core puts the custom prompt into the turn context, then emits its message events before calling the provider at [`agent-loop.js:43`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:43).
   - AgentSession forwards `message_end`, including the custom message and `customType`, at [`agent-session.js:481`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:481).
   - The event is explicitly in the extension API at [`types.d.ts:889`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:889).

   A unique wake ID in `details` would permit an in-flight batch to be retained until a matching custom `message_end`. On the normal path that acknowledgement arrives, so no resend occurs. If the send is rejected before acceptance, no matching custom message event occurs, while `_runAgentPrompt` still reaches `agent_settled`; that supplies a retry point.

   `appendEntry`, `isIdle`, and `getContextUsage` are not delivery acknowledgements. The matching custom message event is.

3. **(c) Real design defect — the 15-minute “timeout” is passive and can strand terminal wakes indefinitely.**

   The elapsed-time condition is checked only when `dispatchPendingWakes()` happens to run at [`bash-background.ts:227`](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:227). No timer is scheduled for the deadline.

   Concrete interleaving:

   1. Manual compaction reaches `session_before_compact`; `compacting=true`.
   2. A finite background job exits and enqueues its only wake before 15 minutes.
   3. Dispatch returns because compaction is apparently active.
   4. Manual compaction fails or is cancelled after the hook. Pi emits only its internal/UI `compaction_end`; no `session_compact`, `agent_start`, or `agent_settled` follows.
   5. The finite job was removed and has no remaining timer at [`bash-background.ts:341`](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:341). At 15 minutes, nothing calls dispatch.

   A later wake after 15 minutes would release the batch, so it does not swallow *every future wake forever*. It can nevertheless strand the only terminal wake forever—the exact unattended deadlock this extension is meant to prevent. A live monitor happens to recheck every 200 ms via [`bash-background.ts:336`](/Users/fab/dev/vibe/pi-extensions/extensions/bash-background.ts:336); finite jobs do not.

   The arithmetic is correct: 15 minutes / 105 seconds ≈ 8.57×. The safety inference is not defensible. Pi permits two sequential summarization calls for a split turn at [`compaction.js:588`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:588), and each call can retry at [`compaction.js:440`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:440). There is no 15-minute absolute upper bound, so the wedge can also reopen the gate during a legitimate long compaction.

4. **(c) Real test-design defect — the new test verifies local handler wiring, not the host invariant.**

   The test directly invokes `session_before_compact`, later directly invokes `session_compact`, and asserts that a send happened at [`bash-background.test.mjs:215`](/Users/fab/dev/vibe/pi-extensions/tests/bash-background.test.mjs:215).

   Its `sendMessage` only pushes into an array at [`bash-background.test.mjs:22`](/Users/fab/dev/vibe/pi-extensions/tests/bash-background.test.mjs:22). It never:

   - starts a core agent run;
   - emits `agent_start`;
   - resumes the original `prompt()` after `session_compact`;
   - enforces the core `activeRun` guard;
   - rejects asynchronously.

   Therefore it misses finding 1 and actually codifies the unsafe behavior: immediate dispatch from `session_compact`. Failing without the source change proves the two new handlers implement the tested latch, not that they prevent the real race.

## Claims that survive

- The pre-prompt window is real. `_isAgentRunActive` is set only inside `_runAgentPrompt()` at [`agent-session.js:744`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:744), while pre-prompt compaction happens earlier at line 865. `isIdle` is consequently wrong during that window at [`agent-session.js:591`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:591).
- The old post-turn gate really did cover post-turn compaction: `_handlePostAgentRun()` invokes `_checkCompaction()` at [`agent-session.js:758`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:758), still inside `_runAgentPrompt`, before `agent_settled`.
- `compaction_start`/`compaction_end` are not extension events. `ExtensionEvent` includes the session hooks but not those UI events at [`types.d.ts:773`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:773). Their emit sites use `_emit`, whereas the session hooks use the extension runner.
- `session_compact` is success-only. Cancellation and failure paths emit only internal `compaction_end`; the extension hook is reached only after `appendCompaction`.
- Returning synchronous `undefined` is safe. The runner awaits every handler, ignores falsy results, lets the last truthy non-cancel result win, and short-circuits on cancellation at [`runner.js:579`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:579).
- Your `undefined` cannot clobber pi-memory’s checkpoint. Pi-memory performs its checkpoint as a side effect and returns no result at [`claude-memory.ts:895`](/Users/fab/dev/vibe/pi-memory/extensions/claude-memory.ts:895).
- Apart from the premature `session_compact` release and rejected-send loss, I found no independent same-batch double-send or permanent `sendPending` latch path. The dispatcher is synchronous and sets the latch before calling `sendMessage`.

