import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("every extension file is packaged, and every packaged extension imports", async () => {
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	const onDisk = (await readdir(new URL("../extensions", import.meta.url)))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => `./extensions/${name}`);
	// Derive the expected set from the directory so a new extension cannot be
	// silently omitted from the package listing (or vice versa).
	assert.deepEqual([...pkg.pi.extensions].sort(), onDisk.sort());
	for (const path of pkg.pi.extensions) {
		const module = await import(new URL(`../${path.slice(2)}`, import.meta.url));
		assert.equal(typeof module.default, "function", path);
	}
});
