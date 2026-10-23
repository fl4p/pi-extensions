import assert from "node:assert/strict";
import test from "node:test";
import hideTools, { HIDE_TOOLS_ENV, hiddenTools, withoutHidden } from "../extensions/hide-tools.ts";

test("parses a comma-separated list, ignoring blanks and spaces", () => {
	assert.deepEqual([...hiddenTools({})], []);
	assert.deepEqual([...hiddenTools({ [HIDE_TOOLS_ENV]: "" })], []);
	assert.deepEqual([...hiddenTools({ [HIDE_TOOLS_ENV]: " memory_dream, ,memory_why " })], ["memory_dream", "memory_why"]);
});

test("removes only hidden tools, keeps order, and reports no change as undefined", () => {
	const active = ["read", "memory_save", "memory_dream", "bash", "memory_why"];
	assert.deepEqual(withoutHidden(active, new Set(["memory_dream", "memory_why"])), ["read", "memory_save", "bash"]);
	assert.equal(withoutHidden(active, new Set(["not_there"])), undefined);
	assert.equal(withoutHidden([], new Set(["x"])), undefined);
});

test("hooks deactivate hidden tools at session start and before each turn", () => {
	const handlers = {};
	let active = ["read", "memory_save", "memory_dream"];
	const calls = [];
	hideTools({
		on: (name, fn) => (handlers[name] = fn),
		getActiveTools: () => active,
		setActiveTools: (names) => {
			calls.push(names);
			active = names;
		},
	});
	const saved = process.env[HIDE_TOOLS_ENV];
	try {
		process.env[HIDE_TOOLS_ENV] = "memory_dream";
		handlers.session_start({}, {});
		assert.deepEqual(active, ["read", "memory_save"]);
		handlers.before_agent_start({}, {});
		assert.equal(calls.length, 1, "no setActiveTools call when nothing changes");
		active = [...active, "memory_dream"]; // another extension re-enabled it
		handlers.before_agent_start({}, {});
		assert.deepEqual(active, ["read", "memory_save"]);
		delete process.env[HIDE_TOOLS_ENV];
		active = ["memory_dream"];
		handlers.session_start({}, {});
		assert.deepEqual(active, ["memory_dream"], "unset env hides nothing");
	} finally {
		if (saved === undefined) delete process.env[HIDE_TOOLS_ENV];
		else process.env[HIDE_TOOLS_ENV] = saved;
	}
});
