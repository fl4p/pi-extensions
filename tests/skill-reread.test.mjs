import assert from "node:assert/strict";
import test from "node:test";
import skillReread from "../extensions/skill-reread.ts";

function createHarness() {
	const handlers = new Map();
	const sent = [];
	const pi = {
		on(name, fn) {
			handlers.set(name, fn);
		},
		sendMessage(message, options) {
			sent.push({ message, options });
		},
	};
	skillReread(pi);
	return { handlers, sent };
}

function ctxWithEntries(entries) {
	return { sessionManager: { getEntries: () => entries } };
}

test("no reminder when no skill files were read", async () => {
	const { handlers, sent } = createHarness();
	await handlers.get("session_compact")({}, {});
	assert.equal(sent.length, 0);
});

test("live-tracked skill reads are listed after compaction", async () => {
	const { handlers, sent } = createHarness();
	await handlers.get("tool_call")(
		{ toolName: "read", input: { path: "/Users/x/.pi/agent/skills/kicad-design/PCBNEW.md" } },
		{},
	);
	// Non-skill reads and other tools must not be tracked.
	await handlers.get("tool_call")({ toolName: "read", input: { path: "/Users/x/project/main.py" } }, {});
	await handlers.get("tool_call")({ toolName: "bash", input: { command: "ls /skills/" } }, {});
	await handlers.get("session_compact")({}, {});
	assert.equal(sent.length, 1);
	const { message, options } = sent[0];
	assert.equal(message.customType, "skill-reread-reminder");
	assert.match(message.content, /PCBNEW\.md/);
	assert.doesNotMatch(message.content, /main\.py/);
	assert.equal(options.deliverAs, "steer");
});

test("session history is harvested on session_start (resume case)", async () => {
	const { handlers, sent } = createHarness();
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "reading the skill" },
					{
						type: "toolCall",
						name: "read",
						arguments: { path: "/Users/x/.pi/agent/skills/kicad-design/SKILL.md" },
					},
				],
			},
		},
		{ type: "message", message: { role: "user", content: "hello" } },
		{ type: "compaction", summary: "..." },
	];
	await handlers.get("session_start")({}, ctxWithEntries(entries));
	await handlers.get("session_compact")({}, {});
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /SKILL\.md/);
});

test("reminder repeats on every compaction and deduplicates files", async () => {
	const { handlers, sent } = createHarness();
	const read = { toolName: "read", input: { path: "/a/skills/s/SKILL.md" } };
	await handlers.get("tool_call")(read, {});
	await handlers.get("tool_call")(read, {});
	await handlers.get("session_compact")({}, {});
	await handlers.get("session_compact")({}, {});
	assert.equal(sent.length, 2);
	const occurrences = sent[0].message.content.match(/SKILL\.md/g);
	assert.equal(occurrences.length, 1);
});

test("harvest survives a broken session manager", async () => {
	const { handlers, sent } = createHarness();
	await handlers.get("session_start")({}, { sessionManager: { getEntries: () => { throw new Error("boom"); } } });
	await handlers.get("tool_call")({ toolName: "read", input: { path: "/b/skills/t/REF.md" } }, {});
	await handlers.get("session_compact")({}, {});
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /REF\.md/);
});
