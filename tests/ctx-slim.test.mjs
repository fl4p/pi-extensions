import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ctxSlim, {
	CTX_SLIM_ENV,
	DROPPED_TOOLS,
	SLIM_TOOLS,
	ctxSlimEnabled,
	slimDeclaration,
	slimPayload,
	slimTools,
} from "../extensions/ctx-slim.ts";

// context-mode 1.0.169's 11 tools plus pi's read and bash, in OpenAI chat shape,
// from a pi 0.84.3 request captured with local-inference/mock_endpoint.py.
const TOOLS = JSON.parse(readFileSync(new URL("./fixtures/context-mode-1.0.169-tools.json", import.meta.url), "utf8"));
const byName = (tools) => new Map(tools.map((t) => [t.function?.name ?? t.name, t]));

test("on unless CTX_SLIM is off/0/false", () => {
	assert.equal(ctxSlimEnabled({}), true);
	for (const v of ["off", "0", "false", " OFF "]) assert.equal(ctxSlimEnabled({ [CTX_SLIM_ENV]: v }), false, v);
	assert.equal(ctxSlimEnabled({ [CTX_SLIM_ENV]: "1" }), true);
});

test("fixture covers every tool in the table with the parameter set it expects", () => {
	const tools = byName(TOOLS);
	for (const name of DROPPED_TOOLS) assert.ok(tools.has(name), name);
	for (const [name, slim] of Object.entries(SLIM_TOOLS)) {
		const props = Object.keys(tools.get(name).function.parameters.properties).sort();
		assert.deepEqual(props, Object.keys(slim.params).sort(), name);
	}
});

test("drops maintenance tools, rewrites the rest, leaves other tools byte-identical", () => {
	const out = byName(slimTools(TOOLS));
	for (const name of DROPPED_TOOLS) assert.ok(!out.has(name), name);
	const before = byName(TOOLS);
	for (const name of ["read", "bash"]) assert.deepEqual(out.get(name), before.get(name));
	for (const [name, slim] of Object.entries(SLIM_TOOLS)) {
		const fn = out.get(name).function;
		const orig = before.get(name).function;
		assert.equal(fn.description, slim.description);
		assert.deepEqual(fn.parameters.required, orig.parameters.required, name);
		for (const [prop, def] of Object.entries(orig.parameters.properties)) {
			const { description: _a, ...keep } = def;
			const { description: _b, ...kept } = fn.parameters.properties[prop];
			assert.deepEqual(kept, keep, `${name}.${prop} lost schema fields`);
		}
	}
});

test("shrinks the context-mode schemas to under 30%", () => {
	const ctx = (tools) => JSON.stringify(tools.filter((t) => t.function.name.startsWith("ctx_"))).length;
	const before = ctx(TOOLS);
	const after = ctx(slimTools(TOOLS));
	assert.ok(after < before * 0.3, `${before} -> ${after} bytes`);
});

test("a tool whose parameters drifted keeps its original schema", () => {
	const orig = byName(TOOLS).get("ctx_execute").function;
	const added = { ...orig, parameters: { ...orig.parameters, properties: { ...orig.parameters.properties, env: { type: "object" } } } };
	assert.equal(slimDeclaration(added), added);
	const { cwd: _cwd, ...fewer } = orig.parameters.properties;
	const removed = { ...orig, parameters: { ...orig.parameters, properties: fewer } };
	assert.equal(slimDeclaration(removed), removed);
});

test("handles Anthropic, OpenAI responses and Google tool shapes", () => {
	const fn = byName(TOOLS).get("ctx_search").function;
	const doctor = byName(TOOLS).get("ctx_doctor").function;
	const anthropic = slimTools([
		{ name: fn.name, description: fn.description, input_schema: fn.parameters },
		{ name: doctor.name, description: doctor.description, input_schema: doctor.parameters },
	]);
	assert.equal(anthropic.length, 1);
	assert.equal(anthropic[0].description, SLIM_TOOLS.ctx_search.description);
	assert.equal(anthropic[0].input_schema.properties.queries.description, SLIM_TOOLS.ctx_search.params.queries);

	const responses = slimTools([{ type: "function", ...fn }]);
	assert.equal(responses[0].description, SLIM_TOOLS.ctx_search.description);
	assert.equal(responses[0].type, "function");

	const google = slimTools([{ functionDeclarations: [{ ...doctor }, { name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters }] }]);
	assert.equal(google[0].functionDeclarations.length, 1);
	assert.equal(google[0].functionDeclarations[0].description, SLIM_TOOLS.ctx_search.description);
});

test("payloads without tools, and junk entries, pass through", () => {
	const noTools = { model: "m", messages: [] };
	assert.equal(slimPayload(noTools), noTools);
	assert.equal(slimPayload(null), null);
	assert.deepEqual(slimTools([null, 3, { name: 5 }]), [null, 3, { name: 5 }]);
	const payload = { model: "m", tools: TOOLS };
	const out = slimPayload(payload);
	assert.notEqual(out, payload);
	assert.equal(out.model, "m");
	assert.equal(payload.tools, TOOLS, "input not mutated");
});

test("hooks: rewrites requests and blocks calls to dropped tools", () => {
	const handlers = {};
	ctxSlim({ on: (name, fn) => (handlers[name] = fn) });
	const saved = process.env[CTX_SLIM_ENV];
	try {
		delete process.env[CTX_SLIM_ENV];
		const out = handlers.before_provider_request({ payload: { tools: TOOLS } });
		assert.equal(out.tools.length, TOOLS.length - DROPPED_TOOLS.size);
		assert.equal(handlers.before_provider_request({ payload: { messages: [] } }), undefined);
		assert.equal(handlers.tool_call({ toolName: "ctx_purge", input: {} }).block, true);
		assert.equal(handlers.tool_call({ toolName: "ctx_search", input: {} }), undefined);
		process.env[CTX_SLIM_ENV] = "off";
		assert.equal(handlers.before_provider_request({ payload: { tools: TOOLS } }), undefined);
		assert.equal(handlers.tool_call({ toolName: "ctx_purge", input: {} }), undefined);
	} finally {
		if (saved === undefined) delete process.env[CTX_SLIM_ENV];
		else process.env[CTX_SLIM_ENV] = saved;
	}
});
