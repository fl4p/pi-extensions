import assert from "node:assert/strict";
import test from "node:test";
import bashDurationExtension from "../extensions/bash-duration.ts";

function createTool() {
	let tool;
	bashDurationExtension({
		registerTool(value) {
			tool = value;
		},
	});
	return tool;
}

test("bash override requires explicit duration strings and delegates execution", async () => {
	const tool = createTool();
	assert.equal(tool.parameters.properties.timeout.type, "string");
	await assert.rejects(tool.execute("invalid", { command: "true", timeout: 180 }), /explicit duration/);
	const ctx = {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
		model: undefined,
		thinkingLevel: undefined,
	};
	const result = await tool.execute("valid", { command: "printf ok", timeout: "1s" }, undefined, undefined, ctx);
	assert.equal(result.content[0].text, "ok");
});
