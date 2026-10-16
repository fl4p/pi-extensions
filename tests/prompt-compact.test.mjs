import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	MERGE_GROUPS,
	PROMPT_COMPACT_ENV,
	compactGuidelines,
	compactSystemPrompt,
	promptCompactEnabled,
} from "../extensions/prompt-compact.ts";

// pi 0.84.3's base system prompt (before <project_context>), captured from a
// real session with this machine's extensions loaded.
const BASE = readFileSync(new URL("./fixtures/pi-0.84.3-base-prompt.txt", import.meta.url), "utf8");
const PROMPT = `${BASE}\n\n<project_context>\nAGENTS.md body\n</project_context>\n`;

const guidelineLines = (prompt) => {
	const start = prompt.indexOf("\nGuidelines:\n") + "\nGuidelines:\n".length;
	const lines = [];
	for (const line of prompt.slice(start).split("\n")) {
		if (!line.startsWith("- ")) break;
		lines.push(line.slice(2));
	}
	return lines;
};

test("off unless PI_PROMPT_COMPACT=1", () => {
	assert.equal(promptCompactEnabled({}), false);
	assert.equal(promptCompactEnabled({ [PROMPT_COMPACT_ENV]: "0" }), false);
	assert.equal(promptCompactEnabled({ [PROMPT_COMPACT_ENV]: "1" }), true);
});

test("fixture still has the shape the rewrite expects", () => {
	assert.ok(BASE.includes("\nAvailable tools:\n"));
	assert.ok(BASE.includes("\nPi documentation (read only when"));
	const present = new Set(guidelineLines(BASE));
	for (const group of MERGE_GROUPS) {
		for (const member of group.members) assert.ok(present.has(member), `fixture lacks: ${member}`);
	}
});

test("drops the Available tools list and keeps everything after the base prompt", () => {
	const out = compactSystemPrompt(PROMPT);
	assert.doesNotMatch(out, /Available tools:/);
	assert.doesNotMatch(out, /In addition to the tools above/);
	assert.ok(out.startsWith("You are an expert coding assistant operating inside pi"));
	assert.ok(out.endsWith("\n\n<project_context>\nAGENTS.md body\n</project_context>\n"));
});

test("merges every group and keeps unrecognised guidelines verbatim and in order", () => {
	const before = guidelineLines(PROMPT);
	const after = guidelineLines(compactSystemPrompt(PROMPT));
	const merged = new Set(MERGE_GROUPS.flatMap((g) => g.members));
	const untouched = before.filter((l) => !merged.has(l));
	assert.deepEqual(after.filter((l) => !MERGE_GROUPS.some((g) => g.text === l)), untouched);
	for (const group of MERGE_GROUPS) assert.equal(after.filter((l) => l === group.text).length, 1, group.text);
	assert.ok(untouched.includes("Do not invoke subagents unless the operator requested delegation directly or through applicable instructions."));
	assert.ok(untouched.includes("Be concise in your responses"));
});

test("a group with a missing member is left alone", () => {
	const [timeouts] = MERGE_GROUPS;
	const lines = [timeouts.members[0], "Use read to examine files instead of cat or sed."];
	assert.deepEqual(compactGuidelines(lines), lines);
});

test("shrinks the docs block to one line with the same paths", () => {
	const out = compactSystemPrompt(PROMPT);
	assert.doesNotMatch(out, /Pi documentation \(read only when/);
	for (const label of ["Main documentation", "Additional docs", "Examples"]) {
		const path = BASE.match(new RegExp(`- ${label}: (\\S+)`))[1];
		assert.ok(out.includes(path), `${label} path lost`);
	}
});

test("leaves a prompt of unexpected shape unchanged and is idempotent", () => {
	assert.equal(compactSystemPrompt("custom prompt"), "custom prompt");
	const once = compactSystemPrompt(PROMPT);
	assert.equal(compactSystemPrompt(once), once);
});
