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
 *   3. pi's MCP bridge forwards `tools/call` with `Number.POSITIVE_INFINITY`
 *      (#643 — same reason), and its registered-tool callback drops the
 *      AbortSignal pi hands it, so cancelling does not reach the child either.
 *
 * Upstream: mksglu/context-mode#959 (bug), PR #1147 (this default, per host),
 * PR #1029 (the cancellation half). Until one of those ships in a release, every
 * pi session on this machine can still hang.
 *
 * Why an extension rather than patching the installed bundle: the fix has to
 * survive `pi update` and every context-mode release, which overwrite
 * ~/.pi/agent/npm/node_modules/context-mode wholesale. An explicit `timeout` in
 * the tool arguments is honored by every context-mode version on every host —
 * that code path predates the bug — so supplying it from our side is both
 * version-proof and strictly narrower than editing their code.
 *
 * `event.input` is mutable by contract: "Mutate it in place to patch tool
 * arguments before execution" (pi 0.84.x ToolCallEvent docs).
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
 * 1ms delay, so an over-large "effectively unlimited" value would kill every
 * command almost instantly — the opposite of what someone setting it intends.
 * Canonical: ~/dev/kb/tooling/settimeout-delay-over-int32-fires-immediately.md
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const ENV_VAR = "CTX_EXEC_DEFAULT_TIMEOUT_MS";

/** A budget already supplied by the caller wins — never second-guess the model. */
function hasUsableTimeout(input: Record<string, unknown>): boolean {
	const timeout = input.timeout;
	return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0;
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
 * budget is already right. The serial path instead spends an explicit timeout as
 * a SHARED budget with a cascading skip — a batch that outlives it reports
 * "Executed N commands" with killed commands rendered as "(no output)". Scaling
 * by command count keeps that truncation out of reach while still bounding the
 * batch. (PR #1147 fixes the shared-budget semantics upstream; this mirrors the
 * released behavior, which is what is installed here.)
 */
export function resolveBatchBudgetMs(input: Record<string, unknown>, base: number): number {
	const concurrency = input.concurrency;
	if (typeof concurrency === "number" && concurrency > 1) return base;
	const commands = Array.isArray(input.commands) ? input.commands.length : 1;
	const scaled = base * Math.max(1, commands);
	return Math.min(scaled, BATCH_TIMEOUT_CAP_MS, MAX_TIMER_DELAY_MS);
}

export default function ctxExecTimeout(pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		try {
			const toolName = event.toolName;
			const isBatch = toolName === BATCH_TOOL;
			if (!isBatch && !EXEC_TOOLS.has(toolName)) return undefined;

			const input = event.input as Record<string, unknown>;
			if (hasUsableTimeout(input)) return undefined;

			const base = resolveBudgetMs(process.env[ENV_VAR]);
			if (base === undefined) return undefined;

			input.timeout = isBatch ? resolveBatchBudgetMs(input, base) : base;
		} catch {
			// Never let this handler block the call it is only annotating.
		}
		return undefined;
	});
}
