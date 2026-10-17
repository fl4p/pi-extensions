import assert from "node:assert/strict";
import test from "node:test";
import ctxExecTimeout, {
	batchCutNotice,
	registerCtxExecTimeout,
	resolveBatchBudgetMs,
	resolveBudgetMs,
} from "../extensions/ctx-exec-timeout.ts";

const DEFAULT_MS = 600_000;

function createHandlers(register = ctxExecTimeout) {
	const handlers = {};
	register({
		on(event, fn) {
			handlers[event] = fn;
		},
	});
	return handlers;
}

/** Fire tool_call and assert the handler never blocks or replaces the call. */
function fire(handlers, toolName, input, toolCallId = "t1") {
	const event = { type: "tool_call", toolCallId, toolName, input };
	assert.equal(handlers.tool_call(event, {}), undefined, "tool_call handler must return undefined");
	return event.input;
}

function result(handlers, toolName, toolCallId, text) {
	return handlers.tool_result(
		{ type: "tool_result", toolCallId, toolName, input: {}, content: [{ type: "text", text }], isError: false },
		{},
	);
}

test("injects the default budget when the model omitted one", () => {
	const handlers = createHandlers();
	for (const tool of ["ctx_execute", "ctx_execute_file"]) {
		assert.equal(fire(handlers, tool, { language: "shell", code: "sleep 999" }).timeout, DEFAULT_MS);
	}
});

test("leaves a usable explicit timeout untouched", () => {
	const handlers = createHandlers();
	assert.equal(fire(handlers, "ctx_execute", { code: "x", timeout: 5000 }).timeout, 5000);
	assert.equal(fire(handlers, "ctx_execute", { code: "x", timeout: 2_147_483_647 }).timeout, 2_147_483_647);
});

test("treats an unusable explicit timeout as absent", () => {
	const handlers = createHandlers();
	assert.equal(fire(handlers, "ctx_execute", { code: "x", timeout: 0 }).timeout, DEFAULT_MS);
	assert.equal(fire(handlers, "ctx_execute", { code: "x", timeout: -1 }).timeout, DEFAULT_MS);
	// setTimeout wraps these to ~1ms: honoring them would kill the command at once
	assert.equal(fire(handlers, "ctx_execute", { code: "x", timeout: 2_147_483_648 }).timeout, DEFAULT_MS);
	assert.equal(fire(handlers, "ctx_execute", { code: "x", timeout: 3_000_000_000 }).timeout, DEFAULT_MS);
});

test("ignores tools it does not own", () => {
	const handlers = createHandlers();
	for (const tool of ["bash", "ctx_search", "read"]) {
		assert.equal(fire(handlers, tool, { command: "x" }).timeout, undefined);
	}
});

test("batch: serial budget scales with command count, capped", () => {
	const handlers = createHandlers();
	const commands3 = [{ label: "a", command: "x" }, { label: "b", command: "y" }, { label: "c", command: "z" }];
	assert.equal(fire(handlers, "ctx_batch_execute", { commands: commands3 }).timeout, DEFAULT_MS * 3);

	// concurrency 1 is the server's own default and models pass it explicitly: still serial
	assert.equal(fire(handlers, "ctx_batch_execute", { commands: commands3, concurrency: 1 }).timeout, DEFAULT_MS * 3);

	const many = Array.from({ length: 50 }, (_, i) => ({ label: `c${i}`, command: "x" }));
	assert.equal(fire(handlers, "ctx_batch_execute", { commands: many }).timeout, 1_800_000);

	// concurrency > 1 is already per-command upstream, so no scaling
	assert.equal(fire(handlers, "ctx_batch_execute", { commands: commands3, concurrency: 2 }).timeout, DEFAULT_MS);
});

test("batch: a cut is announced to the model, a completed batch is left alone", () => {
	let clock = 1_000;
	const handlers = createHandlers((pi) => registerCtxExecTimeout(pi, { now: () => clock }));
	const commands = [{ label: "a", command: "x" }];

	fire(handlers, "ctx_batch_execute", { commands }, "cut");
	clock += DEFAULT_MS + 250; // ran past the injected budget
	const cut = result(handlers, "ctx_batch_execute", "cut", "Executed 1 commands (3 lines, 0.1KB).");
	assert.ok(cut, "a cut batch must be annotated");
	assert.equal(cut.content[0].text, "Executed 1 commands (3 lines, 0.1KB).", "original output is preserved");
	assert.match(cut.content.at(-1).text, /ran 600250ms, at or past the 600000ms budget/);
	assert.match(cut.content.at(-1).text, /possibly incomplete/);

	fire(handlers, "ctx_batch_execute", { commands }, "fast");
	clock += 5_000;
	assert.equal(result(handlers, "ctx_batch_execute", "fast", "ok"), undefined);
});

test("batch: a caller-supplied budget is the caller's to judge — no notice", () => {
	let clock = 0;
	const handlers = createHandlers((pi) => registerCtxExecTimeout(pi, { now: () => clock }));
	fire(handlers, "ctx_batch_execute", { commands: [{ label: "a", command: "x" }], timeout: 1_000 }, "own");
	clock += 60_000;
	assert.equal(result(handlers, "ctx_batch_execute", "own", "ok"), undefined);
});

test("results for calls it never touched pass through", () => {
	const handlers = createHandlers();
	assert.equal(result(handlers, "ctx_execute", "unknown", "ok"), undefined);
	assert.equal(result(handlers, "bash", "other", "ok"), undefined);
});

test("env override: honored, disengageable, and typo-proof", () => {
	assert.equal(resolveBudgetMs(undefined), DEFAULT_MS);
	assert.equal(resolveBudgetMs("30000"), 30_000);
	assert.equal(resolveBudgetMs("  30000  "), 30_000);
	assert.equal(resolveBudgetMs("off"), undefined);
	assert.equal(resolveBudgetMs("0"), undefined);
	// a value setTimeout cannot represent must not become a ~1ms budget
	for (const bad of ["2147483648", "3000000000", "1.5", "abc", "-5", "Infinity"]) {
		assert.equal(resolveBudgetMs(bad), DEFAULT_MS, `expected fallback for ${bad}`);
	}
	assert.equal(resolveBudgetMs("2147483647"), 2_147_483_647);
});

test("disabled via env leaves the call unbounded", () => {
	const handlers = createHandlers();
	const saved = process.env.CTX_EXEC_DEFAULT_TIMEOUT_MS;
	process.env.CTX_EXEC_DEFAULT_TIMEOUT_MS = "off";
	try {
		assert.equal(fire(handlers, "ctx_execute", { code: "x" }).timeout, undefined);
	} finally {
		if (saved === undefined) delete process.env.CTX_EXEC_DEFAULT_TIMEOUT_MS;
		else process.env.CTX_EXEC_DEFAULT_TIMEOUT_MS = saved;
	}
});

test("batch budget never exceeds the timer ceiling", () => {
	const huge = resolveBatchBudgetMs({ commands: Array.from({ length: 1000 }, () => ({})) }, 2_000_000_000);
	assert.ok(huge <= 2_147_483_647, "must stay representable");
});

test("cut notice names both numbers", () => {
	const text = batchCutNotice(1234, 1000);
	assert.match(text, /1234ms/);
	assert.match(text, /1000ms/);
});
