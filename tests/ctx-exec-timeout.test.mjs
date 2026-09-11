import assert from "node:assert/strict";
import test from "node:test";
import ctxExecTimeout, { resolveBatchBudgetMs, resolveBudgetMs } from "../extensions/ctx-exec-timeout.ts";

const DEFAULT_MS = 600_000;

function createHandler() {
	let handler;
	ctxExecTimeout({
		on(event, fn) {
			if (event === "tool_call") handler = fn;
		},
	});
	return handler;
}

function fire(handler, toolName, input) {
	const event = { type: "tool_call", toolCallId: "t1", toolName, input };
	handler(event, {});
	return event.input;
}

test("injects the default budget when the model omitted one", () => {
	const handler = createHandler();
	for (const tool of ["ctx_execute", "ctx_execute_file"]) {
		assert.equal(fire(handler, tool, { language: "shell", code: "sleep 999" }).timeout, DEFAULT_MS);
	}
});

test("leaves an explicit timeout untouched", () => {
	const handler = createHandler();
	assert.equal(fire(handler, "ctx_execute", { code: "x", timeout: 5000 }).timeout, 5000);
	// an unusable one is treated as absent, so the hang cannot slip through
	assert.equal(fire(handler, "ctx_execute", { code: "x", timeout: 0 }).timeout, DEFAULT_MS);
	assert.equal(fire(handler, "ctx_execute", { code: "x", timeout: -1 }).timeout, DEFAULT_MS);
});

test("ignores tools it does not own", () => {
	const handler = createHandler();
	for (const tool of ["bash", "ctx_search", "read"]) {
		assert.equal(fire(handler, tool, { command: "x" }).timeout, undefined);
	}
});

test("batch: serial budget scales with command count, capped", () => {
	const handler = createHandler();
	const three = fire(handler, "ctx_batch_execute", {
		commands: [{ label: "a", command: "x" }, { label: "b", command: "y" }, { label: "c", command: "z" }],
	});
	assert.equal(three.timeout, DEFAULT_MS * 3);

	const many = fire(handler, "ctx_batch_execute", {
		commands: Array.from({ length: 50 }, (_, i) => ({ label: `c${i}`, command: "x" })),
	});
	assert.equal(many.timeout, 1_800_000);

	// concurrency > 1 is already per-command upstream, so no scaling
	const parallel = fire(handler, "ctx_batch_execute", {
		commands: [{ label: "a", command: "x" }, { label: "b", command: "y" }],
		concurrency: 2,
	});
	assert.equal(parallel.timeout, DEFAULT_MS);
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
	const handler = createHandler();
	const saved = process.env.CTX_EXEC_DEFAULT_TIMEOUT_MS;
	process.env.CTX_EXEC_DEFAULT_TIMEOUT_MS = "off";
	try {
		assert.equal(fire(handler, "ctx_execute", { code: "x" }).timeout, undefined);
	} finally {
		if (saved === undefined) delete process.env.CTX_EXEC_DEFAULT_TIMEOUT_MS;
		else process.env.CTX_EXEC_DEFAULT_TIMEOUT_MS = saved;
	}
});

test("batch budget never exceeds the timer ceiling", () => {
	const huge = resolveBatchBudgetMs({ commands: Array.from({ length: 1000 }, () => ({})) }, 2_000_000_000);
	assert.ok(huge <= 2_147_483_647, "must stay representable");
});
