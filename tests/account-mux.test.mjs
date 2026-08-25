import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findProfiles, performAddKey, performSave, performSwitch } from "../extensions/account-mux.ts";

const dir = mkdtempSync(join(tmpdir(), "account-mux-"));
process.env.PI_CODING_AGENT_DIR = dir;
test.after(() => rmSync(dir, { recursive: true, force: true }));

// Expired tokens keep credentialLooksLive() false, so no identity-check network calls run.
const credA = { type: "oauth", access: "A1", refresh: "RA1", expires: 1000 };
const credB = { type: "oauth", access: "B1", refresh: "RB1", expires: 1000 };

const authPath = join(dir, "auth.json");
const storePath = join(dir, "auth-profiles.json");
const readAuth = () => JSON.parse(readFileSync(authPath, "utf-8"));
const readStore = () => JSON.parse(readFileSync(storePath, "utf-8"));

function seed() {
	writeFileSync(authPath, JSON.stringify({ anthropic: credA, openai: { type: "api_key", key: "K" } }));
	writeFileSync(
		storePath,
		JSON.stringify({
			anthropic: {
				active: "alpha",
				profiles: {
					alpha: { email: "a@example.com", credential: credA, savedAt: 1 },
					beta: { email: "b@example.com", credential: credB, savedAt: 1 },
				},
			},
		}),
	);
}

test("switch swaps the anthropic credential and preserves other providers", async () => {
	seed();
	await performSwitch("beta");
	assert.deepEqual(readAuth().anthropic, credB);
	assert.equal(readStore().anthropic.active, "beta");
	assert.equal(readAuth().openai.key, "K");
	assert.ok(!existsSync(`${authPath}.lock`));
});

test("rotated tokens are synced back into the profile they belong to", async () => {
	seed();
	await performSwitch("beta");
	const rotated = { type: "oauth", access: "B2", refresh: "RB2", expires: 2000 };
	const auth = readAuth();
	auth.anthropic = rotated;
	writeFileSync(authPath, JSON.stringify(auth));

	await performSwitch("alpha");
	assert.deepEqual(readAuth().anthropic, credA);
	assert.deepEqual(readStore().anthropic.profiles.beta.credential, rotated);
});

test("a stale auth.json.lock is reclaimed", async () => {
	seed();
	mkdirSync(`${authPath}.lock`);
	const old = new Date(Date.now() - 60_000);
	utimesSync(`${authPath}.lock`, old, old);

	await performSwitch("beta");
	assert.deepEqual(readAuth().anthropic, credB);
	assert.ok(!existsSync(`${authPath}.lock`));
});

test("switching to an unknown profile throws and leaves auth.json untouched", async () => {
	seed();
	await assert.rejects(() => performSwitch("nope"), /No profile "nope"/);
	assert.deepEqual(readAuth().anthropic, credA);
	assert.equal(readStore().anthropic.active, "alpha");
});

test("save snapshots the current credential and marks it active", async () => {
	seed();
	const auth = readAuth();
	auth.anthropic = { type: "oauth", access: "C1", refresh: "RC1", expires: 1000 };
	writeFileSync(authPath, JSON.stringify(auth));

	const profile = await performSave("gamma");
	assert.equal(profile.credential.access, "C1");
	const store = readStore().anthropic;
	assert.equal(store.active, "gamma");
	assert.deepEqual(store.profiles.gamma.credential, auth.anthropic);
	assert.deepEqual(store.profiles.alpha.credential, credA);
});

test("save rejects invalid profile names", async () => {
	seed();
	await assert.rejects(() => performSave("bad name"), /Invalid profile name/);
});

test("performAddKey stores an api_key profile without touching auth.json", async () => {
	seed();
	const prof = await performAddKey("workapi", "sk-ant-api03-XYZW1234");
	assert.equal(prof.credential.type, "api_key");
	assert.equal(readStore().anthropic.profiles.workapi.credential.key, "sk-ant-api03-XYZW1234");
	// active unchanged and auth.json untouched until an explicit switch
	assert.equal(readStore().anthropic.active, "alpha");
	assert.deepEqual(readAuth().anthropic, credA);
});

test("switching to an api_key profile swaps auth.json and preserves other providers", async () => {
	seed();
	await performAddKey("workapi", "sk-ant-api03-XYZW1234");
	await performSwitch("workapi");
	assert.equal(readAuth().anthropic.type, "api_key");
	assert.equal(readAuth().anthropic.key, "sk-ant-api03-XYZW1234");
	assert.equal(readAuth().openai.key, "K");
	assert.equal(readStore().anthropic.active, "workapi");
	assert.ok(!existsSync(`${authPath}.lock`));
});

test("performAddKey rejects short keys and bad names", async () => {
	seed();
	await assert.rejects(() => performAddKey("bad", "sk-short"), /too short/i);
	await assert.rejects(() => performAddKey("bad name", "sk-ant-x"), /Invalid profile name/);
});

test("performAddKey and switch work for a non-anthropic provider", async () => {
	seed();
	const prof = await performAddKey("codex", "sk-proj-1234567890abcdef", "openai");
	assert.equal(prof.credential.type, "api_key");
	assert.equal(readStore().openai.profiles.codex.credential.key, "sk-proj-1234567890abcdef");
	// anthropic active unchanged, auth.json anthropic untouched
	assert.equal(readStore().anthropic.active, "alpha");
	assert.deepEqual(readAuth().anthropic, credA);

	await performSwitch("codex", "openai");
	assert.equal(readAuth().openai.type, "api_key");
	assert.equal(readAuth().openai.key, "sk-proj-1234567890abcdef");
	assert.deepEqual(readAuth().anthropic, credA);
	assert.equal(readStore().openai.active, "codex");
});

test("findProfiles locates a name across providers", async () => {
	seed();
	await performAddKey("shared", "sk-proj-1234567890abcdef", "openai");
	await performAddKey("shared", "sk-ant-api03-XYZW1234");
	const matches = findProfiles("shared");
	assert.equal(matches.length, 2);
	assert.ok(matches.some((m) => m.provider === "anthropic"));
	assert.ok(matches.some((m) => m.provider === "openai"));
});

test("a foreign credential with a known owner is synced into that profile, not the active one", async () => {
	seed();
	// live-looking rotated credential belonging to beta, written by a stale session while alpha is active
	const rotatedB = { type: "oauth", access: "B9", refresh: "RB9", expires: Date.now() + 3_600_000 };
	const auth = readAuth();
	auth.anthropic = rotatedB;
	writeFileSync(authPath, JSON.stringify(auth));

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ account: { email: "b@example.com", uuid: "u-b" } }), { status: 200 });
	try {
		const { warning } = await performSwitch("beta");
		assert.match(warning, /synced it into profile "beta"/);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.deepEqual(readAuth().anthropic, rotatedB);
	assert.deepEqual(readStore().anthropic.profiles.beta.credential, rotatedB);
	assert.deepEqual(readStore().anthropic.profiles.alpha.credential, credA);
});
