/**
 * auto-continue — nudge the agent when a run ends with a contentless turn.
 *
 * Problem: pi treats any assistant turn that returns no tool call as the end of
 * the run and goes idle without a warning. Providers produce such turns
 * mid-task: stopReason "length" with the whole token budget spent inside
 * thinking (observed: GLM-5.3-Flash burning 16k, then 32k tokens on planning
 * with zero text/tool output), and stopReason "stop" with an entirely empty
 * content array (observed once from the same serving at the context-window
 * edge). Each one silently strands an unattended session until a human types
 * "continue".
 *
 * Fix: on `agent_settled` — which pi fires only after the run, its automatic
 * retries, and post-run compaction have all finished — inspect the final
 * assistant message on the active branch. If it stalled (stopReason "length"
 * or "stop" with no tool call and no non-whitespace text) send a continue
 * message that triggers a fresh run. Consecutive auto-continues are capped
 * (default 3) so a model that stalls forever cannot loop-bill; the cap resets
 * on any productive turn end or real user input.
 *
 * The thinking-overflow nudge is action-forcing, not neutral. Measured
 * (glm5p3-flash, Fireworks, 2026-09-03, exact captured payload replays): pi
 * drops thinking-only stalled turns from history (no content, no tool_calls),
 * so the model never sees its own overflowed reasoning and restarts the full
 * plan from scratch every turn — a Sisyphus loop no budget fixes (131,072
 * tokens: still 100% reasoning, finish=length; the model was hand-computing
 * an entire PCB routing solution in-head). Two interventions each broke the
 * loop on the identical payload:
 *   - a nudge saying the reasoning was discarded + act in small tool-call
 *     steps + persist plans to files → 896 thinking chars, then a large
 *     productive tool call;
 *   - `tool_choice: "required"` → 1,393 completion tokens, clean tool call.
 * Both are used here: the tested nudge text on every thinking-overflow stall,
 * and from the second consecutive stall on (configurable) a one-shot
 * `tool_choice: "required"` injected into the recovery run's first provider
 * request via `before_provider_request`. The injection only touches
 * OpenAI-completions-style payloads that carry function tools and no explicit
 * tool_choice (Anthropic-style payloads are skipped: `{type:"any"}` conflicts
 * with extended thinking), and is consumed only when actually applied, so a
 * tool-less compaction/summarization request passes through unchanged.
 *
 * Deliberately NOT handled: stopReason "error" (pi's retry layer owns errors),
 * "aborted" (the user pressed ESC — never override a human), and length-stops
 * that did emit text (truncated but visible output; a human should judge it).
 * Known trade-off: a task whose correct final answer is deliberately empty or
 * thinking-only would receive up to maxConsecutive unwanted nudges; for
 * agentic coding work such turns are stalls in practice.
 *
 * The handler runs synchronously — flag checks, branch scan, send — with no
 * awaits, so nothing can interleave between the decision and the send. If
 * another run is live (pi emits spurious agent_settled from rejected prompt
 * wrappers) or a compaction is in flight, it skips without queuing; the next
 * agent_settled reconsiders. Skipping is the fail-safe direction.
 *
 * NOTE for benchmarking: this actively helps the model — an unattended session
 * survives stalls a bare harness would not. Record its presence as part of the
 * harness condition, and count its injections (customType "auto-continue" in
 * the session file) as run events.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface AutoContinueOptions {
	/** Max consecutive auto-continues before giving up (default 3). */
	maxConsecutive?: number;
	/** Lazy deadline releasing a prompt gate orphaned by a prompt() preflight exit (default 2 min). */
	promptGateMaxMs?: number;
	/**
	 * From this consecutive-stall count on, the recovery run's first provider
	 * request gets `tool_choice: "required"` (default 2; 1 = every recovery,
	 * Infinity = never force).
	 */
	forceToolCallFrom?: number;
}

interface MessageEntry {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
	};
}

/** A turn end pi will idle on even though the model produced nothing usable. */
export function isStalledAssistant(msg: { stopReason?: string; content?: unknown }): boolean {
	if (msg.stopReason !== "length" && msg.stopReason !== "stop") return false;
	const content = msg.content;
	if (!Array.isArray(content)) return content === undefined || content === null;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as { type?: string; text?: unknown };
		if (b.type === "toolCall") return false;
		if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") return false;
	}
	return true;
}

/**
 * Decide from the active branch whether the run just stalled.
 *
 * Scans from the end for the message that ended the run. A user message seen
 * first means a human already responded — never auto-continue over a person.
 * Tool results are skipped (a run can end on a dangling result); custom
 * messages, compaction entries, and everything non-message are ignored.
 */
export function findStall(
	ctx: ExtensionContext,
): { stopReason: string; thinkingOnly: boolean } | undefined {
	let entries: unknown[];
	try {
		entries = ctx.sessionManager.getBranch();
	} catch {
		return undefined;
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as MessageEntry;
		if (typeof e !== "object" || e === null || e.type !== "message" || !e.message) continue;
		const msg = e.message;
		if (msg.role === "user") return undefined;
		if (msg.role !== "assistant") continue;
		if (!isStalledAssistant(msg)) return undefined;
		const thinkingOnly =
			Array.isArray(msg.content) &&
			msg.content.some(
				(b: unknown) =>
					typeof b === "object" && b !== null && (b as { type?: string }).type === "thinking",
			);
		return { stopReason: msg.stopReason ?? "", thinkingOnly };
	}
	return undefined;
}

/**
 * Return a copy of an OpenAI-completions-style payload with
 * `tool_choice: "required"`, or undefined when the payload must not be touched:
 * not an object, already has an explicit tool_choice, carries no function
 * tools (e.g. a compaction/summarization request), or is Anthropic-style
 * (where `tool_choice: {type:"any"}` conflicts with extended thinking).
 */
export function applyToolChoiceRequired(payload: unknown): Record<string, unknown> | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	const p = payload as Record<string, unknown>;
	if (p.tool_choice !== undefined) return undefined;
	const tools = p.tools;
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	const openaiStyle = tools.every(
		(t: unknown) => typeof t === "object" && t !== null && (t as { type?: unknown }).type === "function",
	);
	if (!openaiStyle) return undefined;
	return { ...p, tool_choice: "required" };
}

export default function autoContinue(pi: ExtensionAPI, options?: AutoContinueOptions) {
	const maxConsecutive = options?.maxConsecutive ?? 3;
	const forceToolCallFrom = options?.forceToolCallFrom ?? 2;

	// Gate model, after bash-background's documented races (its lines 150-230
	// are the authority on pi's agent_settled/compaction interleavings):
	//
	// - agentBusy: never act while a run is live — pi emits spurious
	//   agent_settled from rejected prompt wrappers while the owning run holds
	//   the loop.
	// - compacting: never act while a compaction is in flight. Registering
	//   session_before_compact is also what makes pi emit it; session_compact
	//   fires on success only, so session_compact_failed (pi >= 0.84.3) and
	//   agent_start also clear the flag to avoid stranding.
	// - promptPending: `input` is the earliest extension-visible point in
	//   prompt(), and prompt() runs pre-prompt compaction BEFORE agent_start —
	//   a spurious settled in that window would see the previous run's stalled
	//   assistant (the new user message is not on the branch yet) and inject a
	//   run that collides with the human's prompt. Suppress from input until
	//   agent_start/agent_end, with a lazy deadline for prompt() preflight
	//   exits that never reach a run (handled input, missing model) — the
	//   deadline is suspended while a compaction is actually running.
	// - sentSinceLastStart: at most one injection per started run. Back-to-back
	//   settles over the same stall (spurious settle in the agent_end →
	//   agent_settled gap) must not double-send or double-count the budget.
	//
	// In every ambiguous state the extension skips without queuing or retrying;
	// the next agent_settled reconsiders. Skipping is the fail-safe direction.
	const promptGateMaxMs = options?.promptGateMaxMs ?? 2 * 60 * 1000;

	let agentBusy = false;
	let compacting = false;
	let promptPending = false;
	let promptPendingSince = 0;
	let sentSinceLastStart = false;
	let consecutive = 0;
	// One-shot: the next provider request that can carry tool_choice gets
	// "required". Consumed only when actually applied, so tool-less requests
	// (compaction) pass through without spending it.
	let forceToolCallPending = false;

	function promptGateShut(): boolean {
		if (!promptPending) return false;
		// No deadline while compacting: releasing into a live compaction is the
		// failure this gate exists to prevent.
		if (compacting) return true;
		if (Date.now() - promptPendingSince > promptGateMaxMs) {
			promptPending = false;
			return false;
		}
		return true;
	}

	pi.on("agent_start", () => {
		agentBusy = true;
		compacting = false;
		promptPending = false;
		sentSinceLastStart = false;
	});
	pi.on("agent_end", () => {
		agentBusy = false;
		// A steer delivered into a live run never gets its own agent_start; the
		// run ending releases its prompt gate. The pre-prompt window is not
		// weakened: there, input precedes any run, so no agent_end intervenes.
		promptPending = false;
	});
	pi.on("session_before_compact", () => {
		compacting = true;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});
	pi.on("input", (event) => {
		promptPending = true;
		promptPendingSince = Date.now();
		// A new prompt owns the next run — never force a tool call on it.
		forceToolCallPending = false;
		// Only a human replenishes the stall budget. Extension-sourced input
		// (sendUserMessage from another extension) must not rearm the cap.
		if (event.source === "interactive" || event.source === "rpc") {
			consecutive = 0;
		}
	});

	pi.on("before_provider_request", (event) => {
		if (!forceToolCallPending) return undefined;
		const next = applyToolChoiceRequired(event.payload);
		if (next !== undefined) {
			forceToolCallPending = false;
		}
		return next;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (agentBusy || compacting || sentSinceLastStart || promptGateShut()) return;
		const stall = findStall(ctx);
		if (stall === undefined) {
			consecutive = 0;
			// A healthy settle means any armed one-shot was never needed.
			forceToolCallPending = false;
			return;
		}
		if (consecutive >= maxConsecutive) return;
		consecutive++;
		sentSinceLastStart = true;
		const shape =
			stall.stopReason === "length"
				? stall.thinkingOnly
					? "the entire token budget was spent inside thinking"
					: "the output hit the token limit with no text or tool call"
				: "the model returned an empty message";
		// Length stalls get the action-forcing recovery text (validated against a
		// captured stall payload: it collapsed a non-terminating 131k-token
		// reasoning loop into a small think plus a productive tool call). Empty
		// messages keep the neutral nudge.
		const instruction =
			stall.stopReason === "length"
				? "That output was discarded — none of it was saved, and re-deriving a full plan " +
					"in your head will overflow and be lost again. Act now: emit a tool call " +
					"implementing only the next single small step, and persist any plan you need " +
					"by writing it to a file first. Keep each turn small, and split long file " +
					"writes into several smaller steps."
				: "Continue the task from where you left off.";
		const forceToolCall = consecutive >= forceToolCallFrom;
		if (forceToolCall) {
			forceToolCallPending = true;
		}
		pi.sendMessage(
			{
				customType: "auto-continue",
				content:
					`Automatic continue (${consecutive}/${maxConsecutive}): the previous turn ` +
					`ended with no usable output — stopReason=${stall.stopReason}, ${shape}. ` +
					instruction +
					(forceToolCall ? " (This turn is constrained to produce a tool call.)" : ""),
				display: true,
			},
			{ triggerTurn: true },
		);
	});
}
