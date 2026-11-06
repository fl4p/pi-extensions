import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Direct imports resolve dependencies beside the source. Pi's loader resolves
// beside the installed symlink, so test that installation path too.
test("Claude provider loads through an external symlink without repository dependencies", async () => {
	const { loadExtensions } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
	const directory = await mkdtemp(join(tmpdir(), "pi-extension-install-"));
	const fixture = fileURLToPath(new URL(`./.loader-regression-${process.pid}.ts`, import.meta.url));
	try {
		// Calibration: reproduce the exact dependency error that the old direct
		// import test missed. The fixture resolves normally beside the source.
		await writeFile(fixture, 'import { parse } from "partial-json"; export default function () { parse("{}"); }');
		const broken = join(directory, "broken.ts");
		await symlink(fixture, broken);
		const calibration = await loadExtensions([broken], directory);
		assert.equal(calibration.extensions.length, 0);
		assert.equal(calibration.errors.length, 1);
		assert.match(calibration.errors[0].error, /Cannot find module 'partial-json'/);

		const installed = join(directory, "claude-code.ts");
		await symlink(fileURLToPath(new URL("../extensions/claude-code.ts", import.meta.url)), installed);
		const result = await loadExtensions([installed], directory);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
	} finally {
		await rm(fixture, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
});
