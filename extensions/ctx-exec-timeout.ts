/**
 * ctx-exec-timeout — give context-mode's exec tools the default timeout they lack on pi.
 *
 * Problem: a `ctx_execute` that omits `timeout` is unbounded at EVERY layer under
 * pi, so one hung command blocks the turn until the session is killed. Measured
 * 2026-09-10: a model ran a recursive `grep -rn` over ~/dev with no timeout and
 * the call sat for 75 minutes with no tool result, Esc and Ctrl+C doing nothing.
 * Three separate deliberate decisions compose into that:
 *
 *   1. context-mode's `resolveExecTimeout()` returns undefined for every host
 *      except Antigravity CLI, on the premise that "every other host enforces
 *      its own RPC timeout".
 *   2. its executor arms no timer at all when the timeout is undefined (#406 —
 *      long builds must not be cut off).
 *   3. context-mode's own pi adapter (build/adapters/pi/mcp-bridge.js, not pi
 *      code) forwards `tools/call` with `Number.POSITIVE_INFINITY` (#643, same
 *      reason) and drops the AbortSignal pi hands it, so cancelling does not
 *      reach the child either.
 *
 * Upstream: mksglu/context-mode#959 (bug), PR #1147 (a per-host default), PR
 * #1029 (the cancellation half). Until one of those ships in a release, every
 * pi session on this machine can still hang.
 *
 * Why an extension rather than patching the installed bundle: `pi update` and
 * every context-mode release overwrite ~/.pi/agent/npm/node_modules/context-mode
 * wholesale. An explicit `timeout` in the tool arguments is honored by
 * context-mode 1.0.169 and by the PR #1147 branch — the path predates the bug —
 * so supplying it from our side survives updates and is narrower than editing
 * their code. `event.input` is mutable by contract: "Mutate it in place to patch
 * tool arguments before execution" (pi 0.84.x ToolCallEvent docs).
 *
 * The batch tool fails SILENTLY when cut. Released context-mode spends an
 * explicit timeout as a shared budget across a serial `ctx_batch_execute` and
 * reports a truncated batch as `Executed N commands` — a killed command renders
 * as "(no output)", later ones never run, and the skip markers are indexed but
 * never returned. So when an injected batch budget has been used up, the
 * `tool_result` handler appends a notice the model can see. That turns "hangs
 * forever" into "cut, and says so" rather than "cut, and looks complete".
 *
 * Tuning: CTX_EXEC_DEFAULT_TIMEOUT_MS=<ms> overrides the budget,
 * CTX_EXEC_DEFAULT_TIMEOUT_MS=off disables the extension. An unusable value
 * falls back to the built-in default rather than to "unbounded", so a typo
 * cannot restore the hang.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tools whose `timeout` is a single per-call budget. */
const EXEC_TOOLS = new Set(["ctx_execute", "ctx_execute_file"]);

/** Batch tool — its `timeout` means different things per concurrency (see below). */
const BATCH_TOOL = "ctx_batch_execute";

/**
 * 10 minutes, matching PR #1147's per-host default: far above the 2–5 minute
 * test suites and builds that #643 protected, far below a hang worth killing.
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Ceiling for the scaled batch budget. 30 minutes bounds a runaway batch
 * without cutting a legitimately long one.
 */
const BATCH_TIMEOUT_CAP_MS = 1_800_000;

/**
 * Largest delay setTimeout represents. Node wraps anything above this back to a
 * 1ms delay, so an over-large "effectively unlimited" value kills the command
 * almost instantly — the opposite of what whoever set it intended.
 * Canonical: ~/dev/kb/tooling/settimeout-delay-over-int32-fires-immediately.md
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Injected batch budgets awaiting their result, keyed by tool call id. Bounded
 * because a call that is aborted before completing never produces a result.
 */
const MAX_PENDING_BATCHES = 256;

const ENV_VAR = "CTX_EXEC_DEFAULT_TIMEOUT_MS";

/**
 * A budget already supplied by the caller wins — unless setTimeout cannot
 * represent it, in which case it would fire at ~1ms and is treated as absent.
 */
function hasUsableTimeout(input: Record<string, unknown>): boolean {
	const timeout = input.timeout;
	return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 && timeout <= MAX_TIMER_DELAY_MS;
}

/**
 * Resolve the configured budget, or `undefined` when the extension is switched
 * off. Anything unusable falls back to {@link DEFAULT_TIMEOUT_MS}.
 */
export function resolveBudgetMs(raw: string | undefined): number | undefined {
	if (raw === undefined) return DEFAULT_TIMEOUT_MS;
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "off" || trimmed === "0" || trimmed === "false") return undefined;
	if (trimmed === "") return DEFAULT_TIMEOUT_MS;
	const value = Number(trimmed);
	if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) return DEFAULT_TIMEOUT_MS;
	return value;
}

/**
 * Budget for one `ctx_batch_execute` call.
 *
 * With concurrency > 1 context-mode applies `timeout` per command, so the base
 * budget is already right. The serial path (concurrency omitted or 1) instead
 * spends an explicit timeout as a SHARED budget with a cascading skip, so the
 * budget is scaled by command count to keep a legitimately long batch clear of
 * it while still bounding a hung one.
 */
export function resolveBatchBudgetMs(input: Record<string, unknown>, base: number): number {
	const concurrency = input.concurrency;
	if (typeof concurrency === "number" && concurrency > 1) return base;
	const commands = Array.isArray(input.commands) ? input.commands.length : 1;
	const scaled = base * Math.max(1, commands);
	return Math.min(scaled, BATCH_TIMEOUT_CAP_MS, MAX_TIMER_DELAY_MS);
}

/** Notice appended to a batch result whose injected budget was used up. */
export function batchCutNotice(elapsedMs: number, budgetMs: number): string {
	return (
		`[ctx-exec-timeout] This ctx_batch_execute ran ${elapsedMs}ms, at or past the ${budgetMs}ms budget ` +
		"that the ctx-exec-timeout pi extension supplied because no `timeout` was passed. context-mode spends " +
		"that budget across a serial batch and does not report a cut: a command shown as \"(no output)\" may " +
		"have been killed, and later commands may not have run at all, even though the header says they were " +
		"executed. Treat the output as possibly incomplete. To re-run, pass an explicit larger `timeout`, or " +
		"`concurrency` > 1 so each command gets its own budget."
	);
}

export interface CtxExecTimeoutOptions {
	/** Clock, injectable for tests. */
	now?: () => number;
}

export function registerCtxExecTimeout(pi: ExtensionAPI, options: CtxExecTimeoutOptions = {}) {
	const now = options.now ?? Date.now;
	const pendingBatches = new Map<string, { budgetMs: number; startedAt: number }>();

	pi.on("tool_call", (event) => {
		try {
			const toolName = event.toolName;
			const isBatch = toolName === BATCH_TOOL;
			if (!isBatch && !EXEC_TOOLS.has(toolName)) return undefined;

			const input = event.input as Record<string, unknown>;
			if (hasUsableTimeout(input)) return undefined;

			const base = resolveBudgetMs(process.env[ENV_VAR]);
			if (base === undefined) return undefined;

			if (!isBatch) {
				input.timeout = base;
				return undefined;
			}
			const budgetMs = resolveBatchBudgetMs(input, base);
			input.timeout = budgetMs;
			if (pendingBatches.size >= MAX_PENDING_BATCHES) {
				const oldest = pendingBatches.keys().next().value;
				if (oldest !== undefined) pendingBatches.delete(oldest);
			}
			pendingBatches.set(event.toolCallId, { budgetMs, startedAt: now() });
		} catch {
			// emitToolCall does not isolate handler errors: a throw here would fail
			// the very call this handler only annotates.
		}
		return undefined;
	});

	pi.on("tool_result", (event) => {
		const pending = pendingBatches.get(event.toolCallId);
		if (!pending) return undefined;
		pendingBatches.delete(event.toolCallId);
		// The server starts its budget after our tool_call timestamp, so a batch
		// that was cut always reaches this threshold; one that finished early never does.
		const elapsedMs = now() - pending.startedAt;
		if (elapsedMs < pending.budgetMs) return undefined;
		return {
			content: [...event.content, { type: "text" as const, text: batchCutNotice(elapsedMs, pending.budgetMs) }],
		};
	});
}

export default function ctxExecTimeout(pi: ExtensionAPI) {
	registerCtxExecTimeout(pi);
}
