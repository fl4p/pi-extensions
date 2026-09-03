import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import autoContinue, {
	applyToolChoiceRequired,
	findStall,
	isStalledAssistant,
} from "../extensions/auto-continue.ts";

function createHarness(options) {
	const handlers = new Map();
	const sent = [];
	const pi = {
		on(name, fn) {
			handlers.set(name, fn);
		},
		sendMessage(message, opts) {
			sent.push({ message, options: opts });
		},
	};
	autoContinue(pi, options);
	return { handlers, sent };
}

// An injected continue that pi accepted produces a run: agent_start .. agent_end.
// Sequence tests must replay that cycle between settles, or the one-send-per-run
// gate (sentSinceLastStart) correctly refuses the next injection.
function runCycle(handlers) {
	handlers.get("agent_start")({});
	handlers.get("agent_end")({});
}

function ctxWithBranch(entries) {
	return { sessionManager: { getBranch: () => entries } };
}

function assistant(stopReason, content) {
	return { type: "message", message: { role: "assistant", stopReason, content } };
}

const THINKING_ONLY = [{ type: "thinking", thinking: "planning forever..." }];
const HEALTHY = [{ type: "text", text: "Done. Here is the result." }];
const TOOL_CALL = [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }];

test("isStalledAssistant: the observed stall shapes", () => {
	// GLM-5.3-Flash 2026-08-31/09-01: whole budget inside thinking.
	assert.equal(isStalledAssistant({ stopReason: "length", content: THINKING_ONLY }), true);
	// GLM-5.3-Flash 2026-09-01T11:11Z: stop with an entirely empty content array.
	assert.equal(isStalledAssistant({ stopReason: "stop", content: [] }), true);
	// Whitespace-only text is not usable output.
	assert.equal(
		isStalledAssistant({ stopReason: "stop", content: [{ type: "text", text: "  \n" }] }),
		true,
	);
});

test("isStalledAssistant: healthy and out-of-scope turn ends", () => {
	assert.equal(isStalledAssistant({ stopReason: "stop", content: HEALTHY }), false);
	assert.equal(isStalledAssistant({ stopReason: "toolUse", content: TOOL_CALL }), false);
	// Truncated-but-visible text: a human should judge it, not an auto-nudge.
	assert.equal(isStalledAssistant({ stopReason: "length", content: HEALTHY }), false);
	// Errors belong to the retry layer; aborts belong to the user.
	assert.equal(isStalledAssistant({ stopReason: "error", content: [] }), false);
	assert.equal(isStalledAssistant({ stopReason: "aborted", content: [] }), false);
	// A non-empty string body counts as output.
	assert.equal(isStalledAssistant({ stopReason: "stop", content: "text" }), false);
});

test("findStall skips trailing non-message entries (compaction, custom)", () => {
	const stall = findStall(
		ctxWithBranch([
			assistant("length", THINKING_ONLY),
			{ type: "compaction", summary: "..." },
			{ type: "custom_message", customType: "skill-reread-reminder" },
		]),
	);
	assert.deepEqual(stall, { stopReason: "length", thinkingOnly: true });
});

test("findStall never fires over a human: user message after the stall wins", () => {
	const stall = findStall(
		ctxWithBranch([
			assistant("length", THINKING_ONLY),
			{ type: "message", message: { role: "user", content: "continue" } },
		]),
	);
	assert.equal(stall, undefined);
});

test("findStall: a broken session manager is contained", () => {
	assert.equal(
		findStall({ sessionManager: { getBranch: () => { throw new Error("boom"); } } }),
		undefined,
	);
});

test("a stalled settle triggers one continue with triggerTurn", () => {
	const { handlers, sent } = createHarness();
	handlers.get("agent_settled")({}, ctxWithBranch([assistant("length", THINKING_ONLY)]));
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, "auto-continue");
	assert.equal(sent[0].message.display, true);
	assert.match(sent[0].message.content, /stopReason=length/);
	assert.match(sent[0].message.content, /thinking/);
	assert.deepEqual(sent[0].options, { triggerTurn: true });
});

test("one send per started run: a duplicate settle over the same stall is ignored", () => {
	const { handlers, sent } = createHarness();
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("stop", [])]);
	settle({}, stalled);
	settle({}, stalled); // spurious settle in the agent_end -> agent_settled gap
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /\(1\/3\)/); // budget consumed once, not twice
	runCycle(handlers); // the injected run happens and stalls again
	settle({}, stalled);
	assert.equal(sent.length, 2);
	assert.match(sent[1].message.content, /\(2\/3\)/);
});

test("a healthy settle sends nothing and resets the cap", () => {
	const { handlers, sent } = createHarness({ maxConsecutive: 2 });
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("stop", [])]);
	settle({}, stalled);
	runCycle(handlers);
	settle({}, stalled);
	runCycle(handlers);
	settle({}, stalled); // cap of 2 reached
	assert.equal(sent.length, 2);
	runCycle(handlers);
	settle({}, ctxWithBranch([assistant("stop", HEALTHY)])); // healthy: reset
	assert.equal(sent.length, 2);
	runCycle(handlers);
	settle({}, stalled); // budget is fresh again
	assert.equal(sent.length, 3);
});

test("interactive and rpc input reset the cap; extension input does not", () => {
	const { handlers, sent } = createHarness({ maxConsecutive: 1 });
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("length", THINKING_ONLY)]);
	settle({}, stalled);
	runCycle(handlers);
	settle({}, stalled); // capped
	assert.equal(sent.length, 1);

	handlers.get("input")({ source: "extension" }); // sendUserMessage from another extension
	runCycle(handlers);
	settle({}, stalled); // still capped: no human was here
	assert.equal(sent.length, 1);

	handlers.get("input")({ source: "interactive" });
	runCycle(handlers);
	settle({}, stalled);
	assert.equal(sent.length, 2);

	handlers.get("input")({ source: "rpc" });
	runCycle(handlers);
	settle({}, stalled);
	assert.equal(sent.length, 3);
});

test("no action while a run is live or a compaction is in flight", () => {
	const { handlers, sent } = createHarness();
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("stop", [])]);

	handlers.get("agent_start")({});
	settle({}, stalled); // spurious settled while another run owns the loop
	assert.equal(sent.length, 0);
	handlers.get("agent_end")({});

	handlers.get("session_before_compact")({});
	settle({}, stalled); // spurious settled during a manual idle compaction
	assert.equal(sent.length, 0);
	handlers.get("session_compact")({});
	settle({}, stalled);
	assert.equal(sent.length, 1);
});

test("the prompt gate suppresses settles between input and the run it starts", () => {
	const { handlers, sent } = createHarness();
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("length", THINKING_ONLY)]);

	// Human typed; prompt() is live. A pre-prompt compaction completes, then a
	// spurious settle lands before agent_start: the previous stall is on the
	// branch, the human's message is not yet — must NOT inject over the human.
	handlers.get("input")({ source: "interactive" });
	handlers.get("session_before_compact")({});
	handlers.get("session_compact")({});
	settle({}, stalled);
	assert.equal(sent.length, 0);

	// The human's run starts, runs, and stalls again: normal handling resumes.
	runCycle(handlers);
	settle({}, stalled);
	assert.equal(sent.length, 1);
});

test("an orphaned prompt gate expires after its deadline", async () => {
	const { handlers, sent } = createHarness({ promptGateMaxMs: 1 });
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("stop", [])]);
	// A "handled" input (e.g. a slash command) exits prompt() preflight and
	// never reaches agent_start — the gate must not stay shut forever.
	handlers.get("input")({ source: "interactive" });
	settle({}, stalled);
	assert.equal(sent.length, 0);
	await sleep(10);
	settle({}, stalled);
	assert.equal(sent.length, 1);
});

test("compact-failed and agent_start both release a stranded compacting flag", () => {
	const { handlers, sent } = createHarness();
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("stop", [])]);

	handlers.get("session_before_compact")({});
	handlers.get("session_compact_failed")({}); // post-run auto-compaction failed
	settle({}, stalled); // the legitimate final settle must still recover the stall
	assert.equal(sent.length, 1);

	runCycle(handlers);
	handlers.get("session_before_compact")({}); // fails without even the failed event
	handlers.get("agent_start")({});
	handlers.get("agent_end")({});
	settle({}, stalled);
	assert.equal(sent.length, 2);
});

test("counter message reflects the consecutive count", () => {
	const { handlers, sent } = createHarness({ maxConsecutive: 3 });
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("stop", [])]);
	settle({}, stalled);
	runCycle(handlers);
	settle({}, stalled);
	assert.match(sent[0].message.content, /\(1\/3\)/);
	assert.match(sent[1].message.content, /\(2\/3\)/);
	assert.match(sent[1].message.content, /empty message/);
});

test("length stalls carry the action-forcing recovery text; empty stalls stay neutral", () => {
	const { handlers, sent } = createHarness();
	const settle = handlers.get("agent_settled");
	settle({}, ctxWithBranch([assistant("length", THINKING_ONLY)]));
	assert.match(sent[0].message.content, /discarded/);
	assert.match(sent[0].message.content, /next single small step/);
	runCycle(handlers);
	handlers.get("input")({ source: "interactive" });
	runCycle(handlers);
	settle({}, ctxWithBranch([assistant("stop", [])]));
	assert.match(sent[1].message.content, /Continue the task from where you left off/);
	assert.doesNotMatch(sent[1].message.content, /discarded/);
});

const OPENAI_PAYLOAD = {
	model: "m",
	messages: [],
	tools: [{ type: "function", function: { name: "bash" } }],
};

test("applyToolChoiceRequired: shapes it must and must not touch", () => {
	assert.deepEqual(applyToolChoiceRequired(OPENAI_PAYLOAD), {
		...OPENAI_PAYLOAD,
		tool_choice: "required",
	});
	// Anthropic-style tools ({type:"any"} conflicts with extended thinking).
	assert.equal(
		applyToolChoiceRequired({ tools: [{ name: "bash", input_schema: {} }] }),
		undefined,
	);
	// No tools (e.g. a compaction/summarization request).
	assert.equal(applyToolChoiceRequired({ model: "m", messages: [] }), undefined);
	assert.equal(applyToolChoiceRequired({ tools: [] }), undefined);
	// An explicit tool_choice is never overridden.
	assert.equal(
		applyToolChoiceRequired({ ...OPENAI_PAYLOAD, tool_choice: "auto" }),
		undefined,
	);
	assert.equal(applyToolChoiceRequired("nope"), undefined);
	assert.equal(applyToolChoiceRequired(null), undefined);
});

test("tool_choice escalation arms on the second consecutive stall and is one-shot", () => {
	const { handlers, sent } = createHarness();
	const settle = handlers.get("agent_settled");
	const request = handlers.get("before_provider_request");
	const stalled = ctxWithBranch([assistant("length", THINKING_ONLY)]);

	settle({}, stalled); // stall 1: nudge only
	assert.doesNotMatch(sent[0].message.content, /constrained/);
	assert.equal(request({ payload: OPENAI_PAYLOAD }), undefined);

	runCycle(handlers);
	settle({}, stalled); // stall 2: nudge + one-shot force
	assert.match(sent[1].message.content, /constrained to produce a tool call/);
	// A tool-less request (compaction) passes through without consuming the shot.
	assert.equal(request({ payload: { model: "m", messages: [] } }), undefined);
	const forced = request({ payload: OPENAI_PAYLOAD });
	assert.equal(forced.tool_choice, "required");
	// Consumed: the run's later turns are unconstrained.
	assert.equal(request({ payload: OPENAI_PAYLOAD }), undefined);
});

test("human input and a healthy settle disarm a pending tool_choice shot", () => {
	const { handlers, sent } = createHarness({ forceToolCallFrom: 1 });
	const settle = handlers.get("agent_settled");
	const request = handlers.get("before_provider_request");
	const stalled = ctxWithBranch([assistant("length", THINKING_ONLY)]);

	settle({}, stalled); // forceToolCallFrom=1: armed immediately
	assert.match(sent[0].message.content, /constrained/);
	handlers.get("input")({ source: "interactive" }); // human takes over
	assert.equal(request({ payload: OPENAI_PAYLOAD }), undefined);

	runCycle(handlers);
	settle({}, stalled); // re-armed
	runCycle(handlers);
	settle({}, ctxWithBranch([assistant("stop", HEALTHY)])); // healthy: disarmed
	assert.equal(request({ payload: OPENAI_PAYLOAD }), undefined);
});
