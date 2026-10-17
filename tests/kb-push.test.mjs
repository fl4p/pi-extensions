import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import kbPush, {
	CUSTOM_TYPE,
	DEFAULT_SCRIPT,
	parseHookOutput,
	registerKbPush,
	runKbPush,
	stampSessionId,
} from "../extensions/kb-push.ts";

// Tests substitute local scripts for ~/.claude/hooks/kb-push.sh, except the
// contract test at the end, which runs the real one against a scratch TMPDIR.
function fakeScript(body) {
	const dir = mkdtempSync(join(tmpdir(), "pi-kb-push-"));
	const path = join(dir, "hook.sh");
	writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return { dir, path };
}

const HIT = JSON.stringify({
	hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "kb notes in esp32/ ...\n- note\n\n" },
});

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
	registerKbPush(pi, options);
	return { call: handlers.get("tool_call"), handlers, sent };
}

const ctx = (id = "0f8fad5b-d9cb-469f-a165-70867728950e") => ({ sessionManager: { getSessionId: () => id } });
const bash = (command) => ({ type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command } });

test("the script receives Claude Code's PreToolUse stdin shape and its context is returned", async () => {
	const { dir, path } = fakeScript(`cat > "${"$"}(dirname "$0")/stdin.json"\nprintf '%s' '${HIT}'`);
	const content = await runKbPush("esptool chip_id", "pi-abc", { script: path });
	assert.equal(content, "kb notes in esp32/ ...\n- note");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "stdin.json"), "utf8")), {
		tool_input: { command: "esptool chip_id" },
		session_id: "pi-abc",
	});
});

test("empty, garbage, fieldless, and non-zero-exit output all mean no message", async () => {
	for (const body of [
		"exit 0",
		"echo 'not json {'",
		`printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}'`,
		`printf '%s' '{"hookSpecificOutput":{"additionalContext":"   "}}'`,
		"printf null",
		`printf '%s' '${HIT}'; exit 3`,
	]) {
		const { path } = fakeScript(body);
		assert.equal(await runKbPush("esptool", "pi-x", { script: path }), undefined, body);
	}
	assert.equal(parseHookOutput("[]"), undefined);
});

test("a missing or non-executable script degrades silently", async () => {
	assert.equal(await runKbPush("esptool", "pi-x", { script: "/nonexistent/kb-push.sh" }), undefined);
	const { path } = fakeScript(`printf '%s' '${HIT}'`);
	const { chmodSync } = await import("node:fs");
	chmodSync(path, 0o644);
	assert.equal(await runKbPush("esptool", "pi-x", { script: path }), undefined);
});

test("a hung script is cut off at the timeout and its whole process group is killed", async () => {
	const { dir, path } = fakeScript(`sleep 30 &\necho $! > "${"$"}(dirname "$0")/child.pid"\nwait`);
	const started = Date.now();
	assert.equal(await runKbPush("esptool", "pi-x", { script: path, timeoutMs: 300 }), undefined);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 1_500, `took ${elapsed}ms`);
	const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
	await new Promise((r) => setTimeout(r, 100));
	assert.throws(() => process.kill(pid, 0), /ESRCH/, "grandchild sleep survived the timeout");
});

test("an aborted turn stops waiting for the script", async () => {
	const { path } = fakeScript("sleep 30");
	const controller = new AbortController();
	const pending = runKbPush("esptool", "pi-x", { script: path, timeoutMs: 10_000 }, controller.signal);
	setTimeout(() => controller.abort(), 50);
	const started = Date.now();
	assert.equal(await pending, undefined);
	assert.ok(Date.now() - started < 1_500);
	assert.equal(await runKbPush("esptool", "pi-x", { script: path }, AbortSignal.abort()), undefined);
});

test("a bash trigger steers one display message and never blocks or mutates the call", async () => {
	const { dir, path } = fakeScript(`cat > "${"$"}(dirname "$0")/stdin.json"\nprintf '%s' '${HIT}'`);
	const { call, sent } = createHarness({ script: path });
	const event = bash("echo esptool check");
	assert.equal(await call(event, ctx()), undefined);
	assert.deepEqual(event.input, { command: "echo esptool check" });
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].message, { customType: CUSTOM_TYPE, content: "kb notes in esp32/ ...\n- note", display: true });
	// Not { triggerTurn: false }: mid-run that appends outside the loop's context snapshot.
	assert.deepEqual(sent[0].options, { deliverAs: "steer" });
	assert.equal(
		JSON.parse(readFileSync(join(dir, "stdin.json"), "utf8")).session_id,
		"pi-0f8fad5b-d9cb-469f-a165-70867728950e",
	);
});

test("non-bash tools and empty commands never reach the script", async () => {
	const { dir, path } = fakeScript(`touch "${"$"}(dirname "$0")/ran"\nprintf '%s' '${HIT}'`);
	const { call, sent } = createHarness({ script: path });
	assert.equal(await call({ type: "tool_call", toolName: "read", toolCallId: "r", input: { path: "esptool" } }, ctx()), undefined);
	assert.equal(await call({ type: "tool_call", toolName: "write", toolCallId: "w", input: { command: "esptool" } }, ctx()), undefined);
	assert.equal(await call(bash("   "), ctx()), undefined);
	assert.equal(await call({ type: "tool_call", toolName: "bash", toolCallId: "b", input: {} }, ctx()), undefined);
	assert.equal(existsSync(join(dir, "ran")), false);
	assert.equal(sent.length, 0);
});

test("failing scripts and a broken session manager produce no message and no throw", async () => {
	const { path } = fakeScript("echo garbage; exit 1");
	const { call, sent } = createHarness({ script: path });
	assert.equal(await call(bash("esptool"), ctx()), undefined);
	const throwing = { sessionManager: { getSessionId: () => { throw new Error("boom"); } } };
	const good = fakeScript(`printf '%s' '${HIT}'`);
	const second = createHarness({ script: good.path });
	assert.equal(await second.call(bash("esptool"), throwing), undefined);
	assert.equal(sent.length, 0);
	assert.equal(second.sent.length, 1, "a missing session id must not suppress the push");
	// A throwing tool_call handler blocks the tool, so even a broken sendMessage must be contained.
	let handler;
	registerKbPush({ on: (_name, fn) => (handler = fn), sendMessage: () => { throw new Error("boom"); } }, { script: good.path });
	assert.equal(await handler(bash("esptool"), ctx()), undefined);
});

test("stamp ids are prefixed, filename-safe, and fall back to a per-process id", () => {
	assert.equal(stampSessionId(ctx("abc-123")), "pi-abc-123");
	assert.equal(stampSessionId(ctx("../x y")), "pi-.._x_y");
	const fallback = stampSessionId({ sessionManager: { getSessionId: () => "" } });
	assert.match(fallback, /^pi-proc-[0-9a-f-]{36}$/);
	assert.equal(stampSessionId({ sessionManager: {} }), fallback);
});

test("the default export registers exactly one tool_call handler", () => {
	const names = [];
	kbPush({ on: (name) => names.push(name), sendMessage() {} });
	assert.deepEqual(names, ["tool_call"]);
	assert.equal(DEFAULT_SCRIPT, join(homedir(), ".claude", "hooks", "kb-push.sh"));
});

// Contract test against the live script: triggers, once-per-session dedupe, and
// no false positive. Runs with a scratch TMPDIR so the shared stamp directory
// used by real Claude Code and pi sessions is never touched.
const realIndex = join(homedir(), "dev", "kb", "INDEX.md");
test(
	"the real kb-push.sh fires once per domain per pi session",
	{ skip: !(existsSync(DEFAULT_SCRIPT) && existsSync(realIndex)) && "kb-push.sh or ~/dev/kb/INDEX.md absent" },
	async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-kb-push-stamps-"));
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = scratch;
		try {
			const { call, sent } = createHarness();
			const session = ctx("contract-test");
			await call(bash("echo esptool check"), session);
			await call(bash("pio run -t upload"), session);
			await call(bash("ls api/pio_stats pioneer"), session);
			assert.equal(sent.length, 1);
			assert.match(sent[0].message.content, /^kb notes in esp32\//);
			assert.match(sent[0].message.content, /~\/dev\/kb\/esp32\//);
			await call(bash("echo esptool again"), ctx("another-session"));
			assert.equal(sent.length, 2, "a different session is pushed independently");
			assert.deepEqual(readdirSync(join(scratch, "claude-kb-push")).sort(), [
				"pi-another-session-esp32",
				"pi-contract-test-esp32",
			]);
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
			rmSync(scratch, { recursive: true, force: true });
		}
	},
);
