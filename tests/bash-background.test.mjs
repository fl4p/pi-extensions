import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bashBackgroundExtension from "../extensions/bash-background.ts";

function createHarness() {
	const tools = new Map();
	const handlers = new Map();
	const messages = [];
	const userMessages = [];
	const pi = {
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(name, handler) {
			const entries = handlers.get(name) ?? [];
			entries.push(handler);
			handlers.set(name, entries);
		},
		sendMessage(message) {
			messages.push(message.content);
		},
		sendUserMessage(message) {
			userMessages.push(message);
		},
	};
	bashBackgroundExtension(pi);
	return { tools, handlers, messages, userMessages };
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
