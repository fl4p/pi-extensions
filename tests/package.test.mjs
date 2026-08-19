import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("every packaged extension imports successfully", async () => {
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(pkg.pi.extensions, [
		"./extensions/bash-background.ts",
		"./extensions/bash-duration.ts",
		"./extensions/google-search.ts",
		"./extensions/block-web-search.ts",
		"./extensions/persistent-history.ts",
		"./extensions/turn-timer.ts",
	]);
	for (const path of pkg.pi.extensions) {
		const module = await import(new URL(`../${path.slice(2)}`, import.meta.url));
		assert.equal(typeof module.default, "function", path);
	}
});
