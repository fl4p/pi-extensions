import assert from "node:assert/strict";
import test from "node:test";
import skillReread, { collectSkillFiles } from "../extensions/skill-reread.ts";

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

function ctxWithBranch(entries) {
	return { sessionManager: { getBranch: () => entries } };
}

function readCall(id, path) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
		},
	};
}

function readResult(id, { isError = false } = {}) {
	return {
		type: "message",
		message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "..." }], isError },
	};
}

const SKILL_A = "/Users/x/.pi/agent/skills/kicad-design/PCBNEW.md";
const SKILL_B = "/Users/x/.pi/agent/skills/kicad-design/SKILL.md";

test("no reminder when the branch holds no skill files", async () => {
	const { handlers, sent } = createHarness();
	await handlers.get("session_compact")(
		{ reason: "threshold", willRetry: false },
		ctxWithBranch([readCall("r1", "/Users/x/project/main.py"), readResult("r1")]),
	);
	assert.equal(sent.length, 0);
});

test("successful skill reads are listed; failed and resultless reads are not", async () => {
	const entries = [
		readCall("ok", SKILL_A),
		readResult("ok"),
		readCall("failed", SKILL_B),
		readResult("failed", { isError: true }),
		readCall("noresult", "/Users/x/.pi/agent/skills/other/REF.md"),
	];
	const files = collectSkillFiles(ctxWithBranch(entries));
	assert.deepEqual(files, [SKILL_A]);
});

test("/skill:name expansions are tracked via the skill location header", async () => {
	const entries = [
		{
			type: "message",
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: '<skill name="deploy" location="/opt/capabilities/deploy.md">\nReferences are relative to /opt/capabilities.\n\nbody\n</skill>',
					},
				],
			},
		},
	];
	assert.deepEqual(collectSkillFiles(ctxWithBranch(entries)), ["/opt/capabilities/deploy.md"]);
});

test("windows-style separators are recognized as skill paths", async () => {
	const entries = [readCall("w", "C:\\Users\\x\\.pi\\agent\\skills\\s\\SKILL.md"), readResult("w")];
	assert.deepEqual(collectSkillFiles(ctxWithBranch(entries)), ["C:\\Users\\x\\.pi\\agent\\skills\\s\\SKILL.md"]);
});

test("output is sorted and deduplicated", async () => {
	const entries = [
		readCall("1", SKILL_B),
		readResult("1"),
		readCall("2", SKILL_A),
		readResult("2"),
		readCall("3", SKILL_B),
		readResult("3"),
	];
	assert.deepEqual(collectSkillFiles(ctxWithBranch(entries)), [SKILL_A, SKILL_B]);
});

test("non-retry compaction appends turn-neutrally; overflow retry steers", async () => {
	const { handlers, sent } = createHarness();
	const ctx = ctxWithBranch([readCall("r", SKILL_A), readResult("r")]);
	await handlers.get("session_compact")({ reason: "threshold", willRetry: false }, ctx);
	await handlers.get("session_compact")({ reason: "overflow", willRetry: true }, ctx);
	assert.equal(sent.length, 2);
	assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: false });
	assert.deepEqual(sent[1].options, { deliverAs: "steer" });
	for (const { message } of sent) {
		assert.equal(message.customType, "skill-reread-reminder");
		assert.match(message.content, /PCBNEW\.md/);
		assert.equal(message.display, true);
	}
});

test("a broken session manager is contained", async () => {
	const { handlers, sent } = createHarness();
	await handlers.get("session_compact")(
		{ reason: "manual", willRetry: false },
		{ sessionManager: { getBranch: () => { throw new Error("boom"); } } },
	);
	assert.equal(sent.length, 0);
});
