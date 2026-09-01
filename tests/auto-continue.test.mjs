import assert from "node:assert/strict";
import test from "node:test";
import autoContinue, { findStall, isStalledAssistant } from "../extensions/auto-continue.ts";

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

test("a healthy settle sends nothing and resets the cap", () => {
	const { handlers, sent } = createHarness({ maxConsecutive: 2 });
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("stop", [])]);
	settle({}, stalled);
	settle({}, stalled);
	settle({}, stalled); // cap of 2 reached
	assert.equal(sent.length, 2);
	settle({}, ctxWithBranch([assistant("stop", HEALTHY)])); // healthy: reset
	assert.equal(sent.length, 2);
	settle({}, stalled); // budget is fresh again
	assert.equal(sent.length, 3);
});

test("user input resets the cap", () => {
	const { handlers, sent } = createHarness({ maxConsecutive: 1 });
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("length", THINKING_ONLY)]);
	settle({}, stalled);
	settle({}, stalled); // capped
	assert.equal(sent.length, 1);
	handlers.get("input")({});
	settle({}, stalled);
	assert.equal(sent.length, 2);
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

test("agent_start clears a stranded compacting flag from a failed compaction", () => {
	const { handlers, sent } = createHarness();
	handlers.get("session_before_compact")({}); // compaction fails: no session_compact
	handlers.get("agent_start")({});
	handlers.get("agent_end")({});
	handlers.get("agent_settled")({}, ctxWithBranch([assistant("stop", [])]));
	assert.equal(sent.length, 1);
});

test("counter message reflects the consecutive count", () => {
	const { handlers, sent } = createHarness({ maxConsecutive: 3 });
	const settle = handlers.get("agent_settled");
	const stalled = ctxWithBranch([assistant("stop", [])]);
	settle({}, stalled);
	settle({}, stalled);
	assert.match(sent[0].message.content, /\(1\/3\)/);
	assert.match(sent[1].message.content, /\(2\/3\)/);
	assert.match(sent[1].message.content, /empty message/);
});
