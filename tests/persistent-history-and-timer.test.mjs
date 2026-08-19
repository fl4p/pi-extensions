import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { formatDuration } from "../extensions/turn-timer.ts";

function runNode(script, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`child exited ${code}: ${stderr}`));
		});
	});
}

test("persistent history atomically merges concurrent private writes", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-history-test-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const moduleUrl = new URL(`../extensions/persistent-history.ts?test=${Date.now()}`, import.meta.url).href;
	const history = await import(moduleUrl);
	try {
		history.saveHistory(["first", "base"]);
		history.saveHistory(["second", "base"]);
		assert.deepEqual(history.loadHistory().slice(0, 3), ["second", "first", "base"]);

		const workerModuleUrl = new URL("../extensions/persistent-history.ts", import.meta.url).href;
		await Promise.all(
			Array.from({ length: 8 }, (_, index) => {
				const entry = `concurrent-${index}`;
				const script = `const m = await import(${JSON.stringify(workerModuleUrl)}); m.saveHistory([${JSON.stringify(entry)}]);`;
				return runNode(script, { ...process.env, HOME: home });
			}),
		);
		const saved = history.loadHistory();
		for (let index = 0; index < 8; index++) assert.ok(saved.includes(`concurrent-${index}`));
		assert.equal(statSync(history.HISTORY_FILE).mode & 0o777, 0o600);
		assert.ok(!readdirSync(dirname(history.HISTORY_FILE)).some((name) => name.endsWith(".tmp")));
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("turn timer rounds before splitting minutes and seconds", () => {
	assert.equal(formatDuration(42_300), "42.3s");
	assert.equal(formatDuration(59_600), "1m0s");
	assert.equal(formatDuration(119_600), "2m0s");
	assert.equal(formatDuration(125_100), "2m5s");
});
