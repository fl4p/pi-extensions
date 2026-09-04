import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import claudeCodeExtension, {
	API_ID,
	buildArgs,
	CLAUDE_CODE_MODELS,
	createClaudeCodeProvider,
	encodeClaudeInput,
	MAX_INPUT_BYTES,
	MAX_OUTPUT_BYTES,
	parseClaudeJson,
	PROVIDER_ID,
	runClaudeCode,
	serializeContext,
} from "../extensions/claude-code.ts";

// Tests always substitute a local script for `claude`; they never make a model request.
function fakeClaude(body) {
	const dir = mkdtempSync(join(tmpdir(), "pi-claude-provider-"));
	const path = join(dir, "fake-claude");
	writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
	return { dir, path };
}

function envelope(structuredOutput, overrides = {}) {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "fallback answer",
		structured_output: structuredOutput,
		session_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
		usage: {
			input_tokens: 11,
			output_tokens: 7,
			cache_read_input_tokens: 5,
			cache_creation_input_tokens: 3,
		},
		total_cost_usd: 0.012,
		modelUsage: { "claude-sonnet-current": { inputTokens: 11 } },
		...overrides,
	};
}

function recordingClaude(recordPath, response) {
	return fakeClaude(`
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    input,
    disableTerminalTitle: process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE,
    disableNonessentialTraffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    simpleSystemPrompt: process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT,
  }));
  process.stdout.write(${JSON.stringify(JSON.stringify(response))});
});
`);
}

const textContext = {
	systemPrompt: "System says be exact.",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
	tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
};

async function eventsOf(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("extension registers a native provider, not an LLM-callable tool", () => {
	let registered;
	const handlers = new Map();
	claudeCodeExtension({
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerProvider(provider) {
			registered = provider;
		},
		registerTool() {
			assert.fail("claude-code must not register a tool");
		},
	});
	assert.equal(registered.id, PROVIDER_ID);
	assert.equal(registered.name, "Claude Code CLI");
	assert.deepEqual(registered.getModels().map(({ id }) => id), ["default", "fable", "sonnet", "opus"]);
	assert.equal(typeof handlers.get("session_start"), "function");
});

test("model entries are selectable provider models", () => {
	assert.equal(CLAUDE_CODE_MODELS.length, 4);
	for (const model of CLAUDE_CODE_MODELS) {
		assert.equal(model.provider, PROVIDER_ID);
		assert.equal(model.api, API_ID);
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.reasoning, true);
	}
});

test("default argv disables Claude tools and side effects without --bare", () => {
	const args = buildArgs({ modelId: "default", toolNames: ["read"] });
	assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
	assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
	assert.ok(args.includes("--verbose"));
	assert.equal(args[args.indexOf("--tools") + 1], "");
	assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
	assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
	assert.ok(args.includes("--no-session-persistence"));
	assert.ok(args.includes("--safe-mode"));
	assert.ok(!args.includes("--model"));
	for (const forbidden of ["--bare", "--dangerously-skip-permissions", "--allowedTools"]) {
		assert.ok(!args.includes(forbidden), `${forbidden} must never be emitted`);
	}
	const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
	assert.deepEqual(schema.properties.content.items.anyOf[1].properties.name.enum, ["read"]);
	assert.deepEqual(schema.properties.content.items.anyOf[1].properties.argumentsJson, { type: "string" });
	assert.equal(schema.properties.content.items.anyOf[1].additionalProperties, false);
});

test("explicit model aliases and Pi effort become fixed CLI flags", () => {
	const fable = buildArgs({ modelId: "fable", reasoning: "high" });
	assert.equal(fable[fable.indexOf("--model") + 1], "fable");
	const sonnet = buildArgs({ modelId: "sonnet", reasoning: "minimal" });
	assert.equal(sonnet[sonnet.indexOf("--model") + 1], "sonnet");
	assert.equal(sonnet[sonnet.indexOf("--effort") + 1], "low");
	const opus = buildArgs({ modelId: "opus", reasoning: "max" });
	assert.equal(opus[opus.indexOf("--model") + 1], "opus");
	assert.equal(opus[opus.indexOf("--effort") + 1], "max");
	assert.throws(() => buildArgs({ modelId: "--bare" }), /Unknown Claude Code model/);
});

test("toolChoice none removes tool calls from the response schema", () => {
	const args = buildArgs({ modelId: "default", toolNames: ["read"], toolChoice: "none" });
	const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
	assert.equal(schema.properties.content.items.anyOf.length, 1);
});

test("Pi context is canonicalized without binary or cross-provider metadata", () => {
	const payload = serializeContext({
		systemPrompt: "system",
		messages: [
			{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "SECRETBASE64" }], timestamp: 1 },
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "PRIVATE_REASONING", thinkingSignature: "SECRET_SIGNATURE" },
				{ type: "text", text: "checking", textSignature: "SECRET_TEXT_SIGNATURE" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" }, thoughtSignature: "SECRET_THOUGHT_SIGNATURE" },
			], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2, responseId: "SECRET_RESPONSE_ID" },
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file text" }], isError: false, timestamp: 3, details: { secret: "SECRET_DETAILS" } },
		],
		tools: textContext.tools,
	});
	const encoded = JSON.stringify(payload);
	assert.match(encoded, /System says|system/);
	assert.match(encoded, /file text/);
	assert.match(encoded, /Binary image omitted/);
	assert.doesNotMatch(encoded, /SECRETBASE64/);
	for (const omitted of ["PRIVATE_REASONING", "SECRET_SIGNATURE", "SECRET_TEXT_SIGNATURE", "SECRET_THOUGHT_SIGNATURE", "SECRET_RESPONSE_ID", "SECRET_DETAILS", '"timestamp"', '"usage"', '"provider"']) {
		assert.doesNotMatch(encoded, new RegExp(omitted));
	}
});

test("stream-json input preserves an exact content-block prefix as history grows", () => {
	const first = serializeContext(textContext, { reasoning: "high" });
	const second = serializeContext({
		...textContext,
		messages: [
			...textContext.messages,
			{ role: "assistant", content: [{ type: "text", text: "answer" }], api: API_ID, provider: PROVIDER_ID, model: "sonnet", usage: envelope({}).usage, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: "next", timestamp: 3 },
		],
	}, { reasoning: "high" });
	const firstContent = JSON.parse(encodeClaudeInput(first)).message.content;
	const secondContent = JSON.parse(encodeClaudeInput(second)).message.content;
	assert.deepEqual(secondContent.slice(0, firstContent.length), firstContent);
	assert.equal(secondContent.length, firstContent.length + 2);
});

test("structured_output parses text, validates tools, and generates missing IDs", () => {
	const parsed = parseClaudeJson(JSON.stringify(envelope({
		content: [
			{ type: "text", text: "checking" },
			{ type: "toolCall", name: "read", argumentsJson: '{"path":"README.md"}' },
		],
	})), new Set(["read"]));
	assert.equal(parsed.content[0].text, "checking");
	assert.match(parsed.content[1].id, /^claude-code:/);
	assert.equal(parsed.content[1].name, "read");
	assert.deepEqual(parsed.content[1].arguments, { path: "README.md" });
	assert.equal(parsed.usage.totalTokens, 26);
	assert.equal(parsed.usage.cost.total, 0.012);
	assert.equal(parsed.responseModel, "claude-sonnet-current");
	assert.equal(parsed.rawStopReason, undefined);
	assert.throws(
		() => parseClaudeJson(JSON.stringify(envelope({ content: [{ type: "toolCall", name: "bash", argumentsJson: "{}" }] })), new Set(["read"])),
		/unavailable tool "bash"/,
	);
	assert.throws(
		() => parseClaudeJson(JSON.stringify(envelope({ content: [{ type: "toolCall", name: "read", argumentsJson: "[1]" }] })), new Set(["read"])),
		/tool arguments are not an object/,
	);
	const legacy = parseClaudeJson(
		JSON.stringify(envelope({ content: [{ type: "toolCall", name: "read", arguments: { path: "legacy" } }] })),
		new Set(["read"]),
	);
	assert.deepEqual(legacy.content[0].arguments, { path: "legacy" });
});

test("JSON encoded in result is accepted, with plain text as compatibility fallback", () => {
	const structured = { content: [{ type: "text", text: "from result" }] };
	const encoded = parseClaudeJson(JSON.stringify(envelope(undefined, { structured_output: undefined, result: JSON.stringify(structured) })));
	assert.equal(encoded.content[0].text, "from result");
	const plain = parseClaudeJson(JSON.stringify(envelope(undefined, { structured_output: undefined, result: "plain answer" })));
	assert.equal(plain.content[0].text, "plain answer");
});

test("stream-json lifecycle records are ignored in favor of the terminal result", () => {
	const result = envelope({ content: [{ type: "text", text: "done" }] }, { stop_reason: "max_tokens" });
	const parsed = parseClaudeJson([
		JSON.stringify({ type: "system", subtype: "init" }),
		JSON.stringify({ type: "assistant", message: { stop_reason: null } }),
		JSON.stringify(result),
	].join("\n"));
	assert.equal(parsed.content[0].text, "done");
	assert.equal(parsed.rawStopReason, "max_tokens");
});

test("hostile prompt content travels over stdin as data, never argv", async () => {
	const workdir = mkdtempSync(join(tmpdir(), "pi-claude-cwd-"));
	const record = join(workdir, "request.json");
	const hostile = '--bare; rm -rf / $(whoami) `id`';
	const { path } = recordingClaude(record, envelope({ content: [{ type: "text", text: "ok" }] }));
	const outcome = await runClaudeCode({
		modelId: "default",
		payload: { messages: [hostile] },
		allowedToolNames: new Set(),
		cwd: workdir,
		timeoutMs: 10_000,
		executable: path,
	});
	assert.equal(outcome.ok, true);
	const seen = JSON.parse(readFileSync(record, "utf8"));
	assert.equal(seen.argv.includes(hostile), false);
	assert.match(seen.input, /rm -rf/);
	assert.equal(JSON.parse(seen.input).type, "user");
	assert.equal(seen.cwd.endsWith(workdir.split("/").at(-1)), true);
	assert.equal(seen.argv.includes("--bare"), false);
	assert.equal(seen.disableTerminalTitle, "1");
	assert.equal(seen.disableNonessentialTraffic, "1");
	assert.equal(seen.simpleSystemPrompt, "1");
});

test("provider emits the Pi text and tool-call event protocol", async () => {
	const response = envelope({ content: [
		{ type: "text", text: "I will read it." },
		{ type: "toolCall", id: "call-1", name: "read", argumentsJson: '{"path":"README.md"}' },
	] });
	const { path } = recordingClaude(join(mkdtempSync(join(tmpdir(), "pi-claude-stream-")), "request.json"), response);
	const provider = createClaudeCodeProvider({ executable: path, cwd: process.cwd() });
	const model = provider.getModels().find(({ id }) => id === "sonnet");
	let responseHook = 0;
	const events = await eventsOf(provider.streamSimple(model, textContext, {
		onResponse() {
			responseHook++;
		},
	}));
	assert.deepEqual(events.map(({ type }) => type), [
		"start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done",
	]);
	const done = events.at(-1);
	assert.equal(done.reason, "toolUse");
	assert.equal(done.message.provider, PROVIDER_ID);
	assert.equal(done.message.model, "sonnet");
	assert.equal(done.message.content[1].name, "read");
	assert.equal(done.message.responseId, response.session_id);
	// The subprocess API does not expose the underlying HTTP response, so the
	// provider must not fabricate a successful response callback.
	assert.equal(responseHook, 0);
});

test("max_tokens becomes Pi length while preserving Claude's raw stop reason", async () => {
	const response = envelope({ content: [{ type: "text", text: "partial" }] }, { stop_reason: "max_tokens" });
	const { path } = recordingClaude(join(mkdtempSync(join(tmpdir(), "pi-claude-length-")), "request.json"), response);
	const provider = createClaudeCodeProvider({ executable: path, cwd: process.cwd() });
	const events = await eventsOf(provider.streamSimple(provider.getModels()[0], textContext));
	const done = events.at(-1);
	assert.equal(done.type, "done");
	assert.equal(done.reason, "length");
	assert.equal(done.message.rawStopReason, "max_tokens");
});

test("onPayload replacement is the exact request sent to the CLI", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-claude-hook-"));
	const record = join(dir, "request.json");
	const { path } = recordingClaude(record, envelope({ content: [{ type: "text", text: "ok" }] }));
	const provider = createClaudeCodeProvider({ executable: path, cwd: dir });
	await provider.streamSimple(provider.getModels()[0], textContext, {
		onPayload() {
			return { replaced: true };
		},
	}).result();
	const seen = JSON.parse(readFileSync(record, "utf8"));
	const input = JSON.parse(seen.input);
	assert.deepEqual(JSON.parse(input.message.content[0].text), { kind: "payload", value: { replaced: true } });
});

test("abort, timeout, and missing executable become bounded provider failures", async () => {
	const { path } = fakeClaude("setInterval(() => {}, 1000);");
	const aborted = await runClaudeCode({ modelId: "default", payload: {}, allowedToolNames: new Set(), cwd: process.cwd(), timeoutMs: 30_000, signal: AbortSignal.abort(), executable: path });
	assert.equal(aborted.reason, "cancelled");
	const timed = await runClaudeCode({ modelId: "default", payload: {}, allowedToolNames: new Set(), cwd: process.cwd(), timeoutMs: 1_000, executable: path });
	assert.equal(timed.reason, "timeout");
	const missing = await runClaudeCode({ modelId: "default", payload: {}, allowedToolNames: new Set(), cwd: process.cwd(), timeoutMs: 10_000, executable: join(tmpdir(), "missing-claude", "claude") });
	assert.equal(missing.reason, "spawn-failed");
	assert.equal(missing.message.includes(tmpdir()), false);
});

test("nonzero exit and malformed output never echo captured data", async () => {
	const failed = fakeClaude('process.stderr.write("SECRET diagnostic"); process.exit(2);');
	const nonzero = await runClaudeCode({ modelId: "default", payload: {}, allowedToolNames: new Set(), cwd: process.cwd(), timeoutMs: 10_000, executable: failed.path });
	assert.equal(nonzero.reason, "nonzero-exit");
	assert.doesNotMatch(nonzero.message, /SECRET/);
	const malformed = fakeClaude('process.stdout.write("SECRET not json");');
	const bad = await runClaudeCode({ modelId: "default", payload: {}, allowedToolNames: new Set(), cwd: process.cwd(), timeoutMs: 10_000, executable: malformed.path });
	assert.equal(bad.reason, "malformed-json");
	assert.doesNotMatch(bad.message, /SECRET/);
});

test("nonzero Claude context errors are parsed and normalized for Pi compaction", async () => {
	const response = envelope(undefined, {
		is_error: true,
		structured_output: undefined,
		result: "Prompt is too long: SECRET token counts",
	});
	const { path } = fakeClaude(`process.stdout.write(${JSON.stringify(JSON.stringify(response))}); process.exit(1);`);
	const outcome = await runClaudeCode({ modelId: "default", payload: {}, allowedToolNames: new Set(), cwd: process.cwd(), timeoutMs: 10_000, executable: path });
	assert.equal(outcome.reason, "claude-error");
	assert.match(outcome.message, /^context_length_exceeded:/);
	assert.doesNotMatch(outcome.message, /SECRET/);
});

test("input and output size limits fail without retaining oversized data", async () => {
	const noSpawn = await runClaudeCode({ modelId: "default", payload: { text: "x".repeat(MAX_INPUT_BYTES + 1) }, allowedToolNames: new Set(), cwd: process.cwd(), timeoutMs: 10_000, executable: "/definitely/not/run" });
	assert.equal(noSpawn.reason, "invalid-request");
	assert.match(noSpawn.message, /^context_length_exceeded:/);
	const { path } = fakeClaude(`process.stdout.write("x".repeat(${MAX_OUTPUT_BYTES} + 4096)); setInterval(() => {}, 1000);`);
	const overflow = await runClaudeCode({ modelId: "default", payload: {}, allowedToolNames: new Set(), cwd: process.cwd(), timeoutMs: 30_000, executable: path });
	assert.equal(overflow.reason, "output-overflow");
});

test("Claude-reported failures and unavailable tool calls surface as Pi errors", async () => {
	for (const response of [
		envelope(undefined, { is_error: true, structured_output: undefined, result: "authentication failed" }),
		envelope({ content: [{ type: "toolCall", name: "bash", argumentsJson: "{}" }] }),
	]) {
		const { path } = recordingClaude(join(mkdtempSync(join(tmpdir(), "pi-claude-error-")), "request.json"), response);
		const provider = createClaudeCodeProvider({ executable: path, cwd: process.cwd() });
		const events = await eventsOf(provider.streamSimple(provider.getModels()[0], textContext));
		assert.equal(events.at(-1).type, "error");
		assert.equal(events.at(-1).error.stopReason, "error");
	}
});
