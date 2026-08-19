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
	const pi = {
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(name, handler) {
			const entries = handlers.get(name) ?? [];
			entries.push(handler);
			handlers.set(name, entries);
		},
		sendUserMessage(message) {
			messages.push(message);
		},
	};
	bashBackgroundExtension(pi);
	return { tools, handlers, messages };
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
