import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bashBackgroundExtension from "../extensions/bash-background.ts";

// Comfortably longer than the extension's PUMP_MS, so "nothing was dispatched"
// assertions are not just racing the pump.
const PUMP_SETTLE_MS = 900;

function createHarness(options = {}) {
	const tools = new Map();
	const handlers = new Map();
	const messages = [];
	const userMessages = [];
	// Number of upcoming triggerTurn sends that pi should reject. Models
	// sendCustomMessage() rejecting (e.g. the core "Agent is already processing a
	// prompt" guard): the send is fire-and-forget, so nothing throws at the call
	// site and no message events are emitted, but _runAgentPrompt's finally still
	// emits agent_settled.
	let rejectSends = options.rejectSends ?? 0;
	// When set, EVERY triggerTurn send is rejected the way the core active-run guard
	// rejects it (agent.js:226): a foreign run owns activeRun and does not release it,
	// so the false agent_settled from the rejected wrapper's finally never means the
	// next attempt can succeed. This is what turns a synchronous retry into a hot loop.
	const activeRunHeld = options.activeRunHeld ?? false;
	const sendTimes = [];

	const emit = async (name, event) => {
		for (const handler of handlers.get(name) ?? []) await handler(event);
	};

	const pi = {
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(name, handler) {
			const entries = handlers.get(name) ?? [];
			entries.push(handler);
			handlers.set(name, entries);
		},
		sendMessage(message, sendOptions) {
			messages.push(message.content);
			if (!sendOptions?.triggerTurn) return;
			sendTimes.push(Date.now());
			// Pi's runAgentLoop emits agent_start, then message_start/message_end for
			// every prompt message (custom ones included), before the provider call.
			// agent_settled is driven by the test, as pi drives it from the run's end.
			void (async () => {
				if (activeRunHeld || rejectSends > 0) {
					if (!activeRunHeld) rejectSends -= 1;
					await emit("agent_settled");
					return;
				}
				await emit("agent_start");
				await emit("message_start", { message });
				await emit("message_end", { message });
			})();
		},
		sendUserMessage(message) {
			userMessages.push(message);
		},
	};
	bashBackgroundExtension(pi, options.extension);
	return { tools, handlers, messages, userMessages, emit, sendTimes };
}

async function waitFor(predicate, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for condition");
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function removeLog(path) {
	try {
		unlinkSync(path);
	} catch {}
}

async function stopAndWait(stop, result) {
	await stop.execute("stop", { id: result.details.id }, undefined, undefined, { cwd: process.cwd() });
	await waitFor(() => !isAlive(result.details.pid), 4000);
}

test("bash_background requires a timeout without rejecting ordinary arguments", async () => {
	const { tools } = createHarness();
	const background = tools.get("bash_background");
	assert.equal(background.parameters.properties.timeout.type, "string");
	assert.ok(background.parameters.required.includes("timeout"));

	const rejected = await background.execute(
		"watch",
		{ command: "watch date", timeout: "1s" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(rejected.details.error, true);

	for (const command of ["echo watch", "echo tail -f"]) {
		const result = await background.execute(
			"finite",
			{ command, timeout: "1s" },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		assert.ok(result.details.pid);
		removeLog(result.details.logpath);
	}
});

test("timeout keeps descendants supervised and cancels unnecessary escalation", async () => {
	const { tools, messages } = createHarness();
	const background = tools.get("bash_background");
	const list = tools.get("background_list");
	const dir = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
	const pidFile = join(dir, "descendant.pid");
	const command = `nohup sh -c 'echo $$ > "${pidFile}"; sleep 10' >/dev/null 2>&1 &`;
	const signals = [];
	const originalKill = process.kill;
	process.kill = function (pid, signal) {
		if (typeof pid === "number" && pid < 0) signals.push(signal);
		return originalKill.call(process, pid, signal);
	};

	let result;
	try {
		result = await background.execute(
			"timeout",
			{ command, timeout: "300ms", description: "descendant-test" },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		assert.equal(statSync(result.details.logpath).mode & 0o777, 0o600);
		await waitFor(() => existsSync(pidFile));
		const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
		await waitFor(() => messages.some((message) => message.includes("timed out after 300ms")), 4000);
		await waitFor(() => !isAlive(descendantPid));
		const live = await list.execute("list", {}, undefined, undefined, { cwd: process.cwd() });
		assert.deepEqual(live.details.jobs, []);
		await new Promise((resolve) => setTimeout(resolve, 2100));
		assert.deepEqual(signals, ["SIGTERM"]);
	} finally {
		process.kill = originalKill;
		if (result) removeLog(result.details.logpath);
	}
});

test("timeout escalates only while the original process-group leader is alive", async () => {
	const { tools, messages } = createHarness();
	const background = tools.get("bash_background");
	const signals = [];
	const originalKill = process.kill;
	process.kill = function (pid, signal) {
		if (typeof pid === "number" && pid < 0) signals.push(signal);
		return originalKill.call(process, pid, signal);
	};
	let result;
	try {
		result = await background.execute(
			"stubborn",
			{
				command: `node -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`,
				timeout: "300ms",
				description: "stubborn",
			},
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		await waitFor(() => messages.some((message) => message.includes("timed out after 300ms")), 4000);
		assert.deepEqual(signals.slice(0, 2), ["SIGTERM", "SIGKILL"]);
	} finally {
		process.kill = originalKill;
		if (result) removeLog(result.details.logpath);
	}
});

test("session shutdown immediately kills every supervised process group", async () => {
	const { tools, handlers } = createHarness();
	const monitor = tools.get("monitor");
	const signals = [];
	const originalKill = process.kill;
	process.kill = function (pid, signal) {
		if (typeof pid === "number" && pid < 0) signals.push(signal);
		return originalKill.call(process, pid, signal);
	};
	let result;
	try {
		result = await monitor.execute(
			"shutdown",
			{ command: `node -e "setInterval(() => {}, 1000)"`, description: "shutdown" },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		for (const handler of handlers.get("session_shutdown")) handler();
		assert.deepEqual(signals.slice(0, 2), ["SIGTERM", "SIGKILL"]);
	} finally {
		process.kill = originalKill;
		if (result) removeLog(result.details.logpath);
	}
});

test("monitor holds busy output locally and releases one batch after agent_settled", async () => {
	const { tools, handlers, messages } = createHarness();
	const monitor = tools.get("monitor");
	const stop = tools.get("background_stop");
	for (const handler of handlers.get("agent_start") ?? []) await handler();

	const result = await monitor.execute(
		"monitor",
		{
			command: `node -e "console.log('first'); console.log('second'); setInterval(() => {}, 1000)"`,
			description: "busy-batch",
		},
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		await waitFor(() => readFileSync(result.details.logpath, "utf8").includes("second"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepEqual(messages, []);

		for (const handler of handlers.get("agent_settled") ?? []) await handler();
		assert.equal(messages.length, 1);
		assert.match(messages[0], /first/);
		assert.match(messages[0], /second/);
	} finally {
		await stopAndWait(stop, result);
		removeLog(result.details.logpath);
	}
});

test("no wake is dispatched anywhere inside a pre-prompt compaction, session_compact included", async () => {
	const { tools, emit, messages } = createHarness();
	const monitor = tools.get("monitor");
	const stop = tools.get("background_stop");
	// Pi's pre-prompt auto-compaction runs from inside prompt() (agent-session.js:865)
	// with _isAgentRunActive still false, so agent_start/agent_settled both say "idle".
	// input (:814) is the first extension-visible point of that call.
	await emit("input");
	await emit("session_before_compact");

	const result = await monitor.execute(
		"monitor",
		{
			command: `node -e "console.log('during-compaction'); setInterval(() => {}, 1000)"`,
			description: "compaction-window",
		},
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		await waitFor(() => readFileSync(result.details.logpath, "utf8").includes("during-compaction"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepEqual(messages, [], "no wake may be sent while compaction is in flight");

		// session_compact fires at agent-session.js:1677 — still inside prompt(), before
		// the original prompt reaches _runAgentPrompt at :919. Dispatching here would
		// start a competing run and reproduce "Agent is already processing a prompt".
		await emit("session_compact");
		await new Promise((resolve) => setTimeout(resolve, PUMP_SETTLE_MS));
		assert.deepEqual(messages, [], "session_compact still runs inside prompt(): must not dispatch");

		// The original prompt now runs. Only once it settles is a wake safe.
		await emit("agent_start");
		await new Promise((resolve) => setTimeout(resolve, PUMP_SETTLE_MS));
		assert.deepEqual(messages, [], "the prompt's own run is active");

		await emit("agent_settled");
		assert.equal(messages.length, 1);
		assert.match(messages[0], /during-compaction/);
	} finally {
		await stopAndWait(stop, result);
		removeLog(result.details.logpath);
	}
});

test("a terminal wake held during compaction is pumped out, not stranded", async () => {
	const { tools, emit, messages } = createHarness();
	const background = tools.get("bash_background");
	// A manual compaction while the session is idle: no input, and no agent_start or
	// agent_settled will follow. A finite job clears its flush interval in finish(),
	// so nothing but the pump can release its one terminal wake.
	await emit("session_before_compact");

	const result = await background.execute(
		"bash_background",
		{ command: `node -e "process.exit(3)"`, timeout: "30s", description: "stranded-exit" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.deepEqual(messages, [], "the exit wake must be held while compacting");

		await emit("session_compact");
		// No further lifecycle event is emitted: only the pump can deliver this.
		await waitFor(() => messages.length === 1, 3000);
		assert.match(messages[0], /exited with code 3/);
	} finally {
		removeLog(result.details.logpath);
	}
});

test("a persistently rejected send backs off instead of spinning", async () => {
	// The core active-run guard keeps rejecting while a foreign run holds activeRun,
	// and each rejected wrapper emits a false agent_settled from its finally. Retrying
	// on that settlement synchronously spins at microtask speed and starves the owner.
	const { tools, sendTimes, messages } = createHarness({ activeRunHeld: true });
	const background = tools.get("bash_background");
	const result = await background.execute(
		"bash_background",
		{ command: `node -e "process.exit(5)"`, timeout: "30s", description: "spin-guard" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		await waitFor(() => sendTimes.length >= 1, 3000);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		// Backoff is 500 ms doubling: within ~2 s of the first attempt only a handful
		// of retries are possible. A synchronous retry loop produces thousands.
		assert.ok(sendTimes.length <= 6, `expected a backed-off retry count, got ${sendTimes.length}`);
		assert.ok(messages.every((message) => /exited with code 5/.test(message)));

		// Gaps must grow, not stay flat.
		if (sendTimes.length >= 3) {
			const first = sendTimes[1] - sendTimes[0];
			const last = sendTimes[sendTimes.length - 1] - sendTimes[sendTimes.length - 2];
			assert.ok(last >= first, `expected widening backoff, got ${first}ms then ${last}ms`);
		}
	} finally {
		removeLog(result.details.logpath);
	}
});

test("an accepted send is never requeued, even if a foreign settle arrives first", async () => {
	const { tools, emit, messages } = createHarness();
	const background = tools.get("bash_background");
	const result = await background.execute(
		"bash_background",
		{ command: `node -e "process.exit(11)"`, timeout: "30s", description: "accepted-once" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		await waitFor(() => messages.length === 1, 3000);
		assert.match(messages[0], /exited with code 11/);
		// A settle for some other run, after ours was acknowledged. Nothing to resend.
		await emit("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, PUMP_SETTLE_MS));
		assert.equal(messages.length, 1, "an acknowledged batch must not be resent");
	} finally {
		removeLog(result.details.logpath);
	}
});

test("a stale abandoned prompt gate does not collapse the gate for the next prompt", async () => {
	// Shortened so the orphan can actually go stale within a test.
	const { tools, emit, messages } = createHarness({ extension: { promptGateMaxMs: 1500 } });
	const background = tools.get("bash_background");
	// A prompt that never reaches a run — pi has preflight exits after `input`
	// (a handled input result, or missing model / expired auth) with no closing event.
	await emit("input");
	// Let it go well past its deadline. Its timestamp must not be inherited below.
	await new Promise((resolve) => setTimeout(resolve, 2000));
	// A new, legitimate prompt. Its gate must be timed from here, not from the
	// abandoned one, or a wake arriving now expires immediately and dispatches
	// inside prompt() — exactly what the gate exists to prevent. No compaction is
	// emitted here on purpose: `compacting` would hold the gate on its own and mask
	// whether promptPending was timed correctly.
	await emit("input");

	const result = await background.execute(
		"bash_background",
		{ command: `node -e "process.exit(13)"`, timeout: "30s", description: "stale-gate" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.deepEqual(messages, [], "the second prompt's gate must still hold");

		// Its own deadline then expires, and the wake goes out.
		await waitFor(() => messages.length === 1, 3000);
		assert.match(messages[0], /exited with code 13/);
	} finally {
		removeLog(result.details.logpath);
	}
});

test("a rejected send is requeued and redelivered rather than dropped", async () => {
	const { tools, emit, messages } = createHarness({ rejectSends: 1 });
	const background = tools.get("bash_background");
	const result = await background.execute(
		"bash_background",
		{ command: `node -e "process.exit(7)"`, timeout: "30s", description: "rejected-send" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		// First dispatch is rejected: pi emits agent_settled with no message_end, so
		// the batch is never acknowledged. drainMonitorBatch has already destroyed the
		// job's copy, making the held batch the only one left.
		await waitFor(() => messages.length >= 1, 3000);
		assert.match(messages[0], /exited with code 7/);

		// The requeue happens on that agent_settled; the pump carries it out.
		await waitFor(() => messages.length === 2, 3000);
		assert.match(messages[1], /exited with code 7/, "the wake must survive a rejected send");
	} finally {
		removeLog(result.details.logpath);
	}
});

test("monitor completion waits for the active custom wake and does not repeat output", async () => {
	const { tools, handlers, messages, userMessages } = createHarness();
	const monitor = tools.get("monitor");
	const result = await monitor.execute(
		"monitor",
		{
			command: `node -e "console.log('first'); setTimeout(() => process.exit(0), 400)"`,
			description: "exit-during-wake",
		},
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		await waitFor(() => messages.length === 1);
		await waitFor(() => !isAlive(result.details.pid), 3000);
		assert.equal(messages.length, 1);
		assert.match(messages[0], /first/);
		assert.deepEqual(userMessages, []);

		for (const handler of handlers.get("agent_settled") ?? []) await handler();
		assert.equal(messages.length, 2);
		assert.doesNotMatch(messages[1], /first/);
		assert.match(messages[1], /exited with code 0/);
	} finally {
		removeLog(result.details.logpath);
	}
});

test("background_stop discards monitor output accumulated while the agent is busy", async () => {
	const { tools, handlers, messages } = createHarness();
	const monitor = tools.get("monitor");
	const stop = tools.get("background_stop");
	for (const handler of handlers.get("agent_start") ?? []) await handler();

	const result = await monitor.execute(
		"monitor",
		{
			command: `node -e "console.log('must-not-wake'); setInterval(() => {}, 1000)"`,
			description: "cancel-pending",
		},
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		await waitFor(() => readFileSync(result.details.logpath, "utf8").includes("must-not-wake"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepEqual(messages, []);

		await stopAndWait(stop, result);
		for (const handler of handlers.get("agent_settled") ?? []) await handler();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(messages, []);
	} finally {
		if (isAlive(result.details.pid)) await stopAndWait(stop, result);
		removeLog(result.details.logpath);
	}
});

test("monitor bounds newline-free output while retaining the full private log", async () => {
	const { tools, messages } = createHarness();
	const monitor = tools.get("monitor");
	const result = await monitor.execute(
		"monitor",
		{ command: `node -e "process.stdout.write('x'.repeat(100000))"`, description: "long-line" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	await waitFor(() => messages.some((message) => message.includes("[monitor:long-line]")));
	assert.equal(statSync(result.details.logpath).mode & 0o777, 0o600);
	assert.equal(statSync(result.details.logpath).size, 100000);
	assert.ok(Math.max(...messages.map((message) => Buffer.byteLength(message, "utf8"))) < 10_000);
	assert.ok(messages.some((message) => message.includes("dropped")));
	removeLog(result.details.logpath);
});

test("startup cleanup removes expired extension logs", () => {
	const path = join(tmpdir(), `pi-bg-stale-${Date.now()}.log`);
	writeFileSync(path, "stale", { mode: 0o600 });
	const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
	utimesSync(path, old, old);
	createHarness();
	assert.equal(existsSync(path), false);
});

// ---- monitor silence warning -----------------------------------------------
// A monitor wakes only on NEW OUTPUT, so one whose filter never matches is silent
// forever and reads exactly like a healthy quiet run. These cover the three cases
// that matter: it fires when nothing is produced, it does NOT fire when something
// is, and "off" opts out. `silenceWarning` is given in ms here so the tests do not
// have to wait minutes for the real 10m default.

test("a monitor that produces nothing warns once that its filter may be wrong", async () => {
	const { tools, handlers, messages } = createHarness();
	const monitor = tools.get("monitor");
	const stop = tools.get("background_stop");
	for (const handler of handlers.get("agent_start") ?? []) await handler();
	for (const handler of handlers.get("agent_settled") ?? []) await handler();

	// Matches nothing, ever -- the shape of a wrong grep against a live source.
	const result = await monitor.execute(
		"monitor",
		{
			command: `node -e "setInterval(() => {}, 1000)"`,
			description: "silent-filter",
			silenceWarning: "300ms",
		},
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		assert.match(result.content[0].text, /still silent after 300ms/);
		await waitFor(() => messages.length > 0);
		assert.equal(messages.length, 1);
		assert.match(messages[0], /has produced NO output in 300ms/);
		assert.match(messages[0], /the filter is probably wrong/);
		// One-shot: it questions the filter once, it does not nag.
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(messages.length, 1);
	} finally {
		await stop.execute("stop", { id: result.details.id }, undefined, undefined, {});
	}
});

test("a monitor that produces output never warns about silence", async () => {
	const { tools, handlers, messages } = createHarness();
	const monitor = tools.get("monitor");
	const stop = tools.get("background_stop");
	for (const handler of handlers.get("agent_start") ?? []) await handler();
	for (const handler of handlers.get("agent_settled") ?? []) await handler();

	const result = await monitor.execute(
		"monitor",
		{
			command: `node -e "console.log('matched'); setInterval(() => {}, 1000)"`,
			description: "producing",
			silenceWarning: "2s",
		},
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		// Wait for the output itself, which is what disarms the warning...
		await waitFor(() => messages.length > 0);
		// ...then sit past the window and confirm nothing further arrives.
		await new Promise((resolve) => setTimeout(resolve, 2500));
		assert.equal(messages.length, 1);
		assert.match(messages[0], /new output/);
		for (const message of messages) assert.doesNotMatch(message, /produced NO output/);
	} finally {
		await stop.execute("stop", { id: result.details.id }, undefined, undefined, {});
	}
});

test('silenceWarning "off" suppresses the warning, and a bad duration is rejected', async () => {
	const { tools, handlers, messages } = createHarness();
	const monitor = tools.get("monitor");
	const stop = tools.get("background_stop");
	for (const handler of handlers.get("agent_start") ?? []) await handler();
	for (const handler of handlers.get("agent_settled") ?? []) await handler();

	const off = await monitor.execute(
		"monitor",
		{ command: `node -e "setInterval(() => {}, 1000)"`, description: "quiet-ok", silenceWarning: "off" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, PUMP_SETTLE_MS));
		assert.deepEqual(messages, []);
		assert.doesNotMatch(off.details.wakeWhen ?? "", /silent/);
	} finally {
		await stop.execute("stop", { id: off.details.id }, undefined, undefined, {});
	}

	// A bare number is as invalid here as it is for bash_background's timeout.
	const bad = await monitor.execute(
		"monitor",
		{ command: "true", description: "bad-duration", silenceWarning: "300" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	assert.match(bad.output ?? JSON.stringify(bad), /Invalid silenceWarning/);
});
