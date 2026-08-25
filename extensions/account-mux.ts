/**
 * Account multiplexer for the anthropic provider.
 *
 * Keeps named credential profiles in ~/.pi/agent/auth-profiles.json and swaps
 * the `anthropic` entry of auth.json between them. Pi re-reads auth.json when
 * its file revision changes, so a switch takes effect immediately, even in a
 * running session.
 *
 * Commands:
 *	 /account							 picker (select profile to switch to)
 *	 /account <name>			 switch directly
 *	 /account save <name>	 snapshot current auth.json credential as a profile
 *	 /account remove <name>
 *	 /account list
 *	 /account whoami			 ask the API who the current token belongs to
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, rmdirSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER = "anthropic";
const NAME_RE = /^[A-Za-z0-9._-]+$/;

type Credential = Record<string, unknown> & { type: string };
interface Profile {
	email?: string;
	credential: Credential;
	savedAt: number;
}
interface ProviderProfiles {
	active?: string;
	profiles: Record<string, Profile>;
}
type Store = Record<string, ProviderProfiles>;

function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	return env && env.length > 0 ? env : join(homedir(), ".pi", "agent");
}
const authPath = () => join(agentDir(), "auth.json");
const storePath = () => join(agentDir(), "auth-profiles.json");

function readJson(path: string): Record<string, any> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e: any) {
		if (e.code === "ENOENT") return undefined;
		throw e;
	}
}

function writeJson(path: string, data: unknown): void {
	writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
}

function readStore(): Store {
	return (readJson(storePath()) as Store | undefined) ?? {};
}

// Cooperates with pi's proper-lockfile locking (mkdir-based `auth.json.lock`).
async function withAuthLock<T>(fn: () => Promise<T> | T): Promise<T> {
	const lockPath = authPath() + ".lock";
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			mkdirSync(lockPath);
			break;
		} catch (e: any) {
			if (e.code !== "EEXIST") throw e;
			try {
				// proper-lockfile treats locks older than its stale window (30s) as dead
				if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
					rmdirSync(lockPath);
					continue;
				}
			} catch {}
			if (Date.now() > deadline) throw new Error("auth.json is locked by another process");
			await new Promise((r) => setTimeout(r, 25));
		}
	}
	try {
		return await fn();
	} finally {
		try {
			rmdirSync(lockPath);
		} catch {}
	}
}

async function whois(access: string, timeoutMs = 3000): Promise<{ email?: string; uuid?: string } | undefined> {
	try {
		const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
			headers: { Authorization: `Bearer ${access}`, "anthropic-beta": "oauth-2025-04-20" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return undefined;
		const d: any = await res.json();
		return { email: d?.account?.email, uuid: d?.account?.uuid };
	} catch {
		return undefined;
	}
}

function credentialLooksLive(cred: Credential): boolean {
	return cred.type === "oauth" && typeof cred.expires === "number" && cred.expires > Date.now() + 5000;
}

// Other pi processes started under a different account can write their cached
// credential back over auth.json (observed live: a stale session restored the
// previous account's token twice). Suppress reactions to our own writes.
let selfWriteUntil = 0;

export async function performSwitch(name: string): Promise<{ profile: Profile; warning?: string }> {
	const store = readStore();
	const ps = store[PROVIDER];
	const target = ps?.profiles?.[name];
	if (!ps || !target) {
		throw new Error(`No profile "${name}" for ${PROVIDER}. Save one with /account save <name>.`);
	}
	let warning: string | undefined;

	selfWriteUntil = Date.now() + 2000;
	await withAuthLock(async () => {
		const auth = readJson(authPath()) ?? {};
		const current = auth[PROVIDER] as Credential | undefined;

		// Tokens rotate on refresh: write the (possibly rotated) live credential
		// back into the profile it belongs to before overwriting auth.json.
		const activeProfile = ps.active ? ps.profiles[ps.active] : undefined;
		if (current && activeProfile && JSON.stringify(activeProfile.credential) !== JSON.stringify(current)) {
			let owner: Profile | undefined = activeProfile;
			if (credentialLooksLive(current) && activeProfile.email) {
				const id = await whois(String(current.access));
				if (id?.email && id.email !== activeProfile.email) {
					// Foreign credential (stale session write-back or external /login):
					// never corrupt the active profile, but keep it if we know its owner.
					const entry = Object.entries(ps.profiles).find(([, p]) => p.email === id.email);
					owner = entry?.[1];
					warning = entry
						? `auth.json held a credential for ${id.email} — synced it into profile "${entry[0]}" instead of "${ps.active}".`
						: `auth.json held a credential for ${id.email} (no matching profile) — discarded. ` +
							`Use /account save <name> to keep such logins.`;
				}
			}
			if (owner) {
				owner.credential = current;
				owner.savedAt = Date.now();
			}
		}

		auth[PROVIDER] = target.credential;
		writeJson(authPath(), auth);
	});

	ps.active = name;
	writeJson(storePath(), store);
	return { profile: target, warning };
}

export async function performSave(name: string): Promise<Profile> {
	if (!NAME_RE.test(name)) throw new Error(`Invalid profile name "${name}" (use letters, digits, . _ -)`);
	const auth = readJson(authPath()) ?? {};
	const current = auth[PROVIDER] as Credential | undefined;
	if (!current) throw new Error(`No ${PROVIDER} credential in auth.json to save.`);

	const store = readStore();
	const ps = (store[PROVIDER] ??= { profiles: {} });
	const prof: Profile = { ...ps.profiles[name], credential: current, savedAt: Date.now() };
	if (credentialLooksLive(current)) {
		const id = await whois(String(current.access));
		if (id?.email) prof.email = id.email;
	}
	ps.profiles[name] = prof;
	ps.active = name;
	writeJson(storePath(), store);
	return prof;
}

type UiLike = {
	setStatus(key: string, text: string | undefined): void;
	notify(text: string, level?: "info" | "warning" | "error"): void;
};

export default function (pi: ExtensionAPI) {
	const updateStatus = (ctx: { ui: UiLike }) => {
		const ps = readStore()[PROVIDER];
		ctx.ui.setStatus("account", ps?.active ? `⇄ ${ps.active}` : undefined);
	};

	let watcher: FSWatcher | undefined;
	let ui: UiLike | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let lastWhois = 0;
	const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
	const lastNotified = new Map<string, number>();

	const onAuthChange = async () => {
		if (Date.now() < selfWriteUntil) return;
		const ps = readStore()[PROVIDER];
		const active = ps?.active ? ps.profiles[ps.active] : undefined;
		if (!active) return;
		const current = (readJson(authPath()) ?? {})[PROVIDER] as Credential | undefined;
		if (!current || JSON.stringify(current) === JSON.stringify(active.credential)) {
			ui?.setStatus("account", `⇄ ${ps.active}`);
			return;
		}
		if (!credentialLooksLive(current) || Date.now() - lastWhois < 15_000) return;
		lastWhois = Date.now();
		const id = await whois(String(current.access));
		if (!id?.email) return;
		if (id.email === active.email) {
			// pi rotated the active account's tokens: keep the profile in sync
			const store = readStore();
			const prof = store[PROVIDER]?.profiles?.[ps.active!];
			if (prof) {
				prof.credential = current;
				prof.savedAt = Date.now();
				writeJson(storePath(), store);
			}
		} else {
			// Keep a foreign-but-known credential fresh in its own profile so a
			// later re-assert does not strand a rotated refresh token.
			const store = readStore();
			const entry = Object.entries(store[PROVIDER]?.profiles ?? {}).find(([, p]) => p.email === id.email);
			if (entry) {
				entry[1].credential = current;
				entry[1].savedAt = Date.now();
				writeJson(storePath(), store);
			}
			ui?.setStatus("account", `⇄ ${ps.active} ⚠ ${id.email}`);
			const last = lastNotified.get(id.email) ?? 0;
			if (Date.now() - last >= NOTIFY_COOLDOWN_MS) {
				lastNotified.set(id.email, Date.now());
				ui?.notify(
					`Another process overwrote auth.json with ${id.email} (active profile: ${ps.active}). ` +
						`Run /account ${ps.active} to re-assert, or restart old pi sessions. ` +
						`(Repeats suppressed for 10 min; footer shows live state.)`,
					"warning",
				);
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
		ui = ctx.ui;
		if (!watcher) {
			try {
				watcher = watch(authPath(), () => {
					clearTimeout(debounce);
					debounce = setTimeout(() => void onAuthChange().catch(() => {}), 400);
				});
			} catch {}
		}
	});

	pi.on("session_shutdown", async () => {
		clearTimeout(debounce);
		watcher?.close();
		watcher = undefined;
		ui = undefined;
	});

	pi.registerCommand("account", {
		description: `Switch ${PROVIDER} account (multiplexer): /account [name|save <name>|remove <name>|list|whoami]`,
		getArgumentCompletions: (prefix: string) => {
			const words = prefix.split(/\s+/);
			const store = readStore()[PROVIDER];
			const names = Object.keys(store?.profiles ?? {});
			let candidates: string[];
			if (words.length <= 1) {
				candidates = [...names, "save", "remove", "list", "whoami"].filter((c) => c.startsWith(words[0] ?? ""));
			} else if (words[0] === "remove") {
				candidates = names.filter((n) => n.startsWith(words[1])).map((n) => `remove ${n}`);
			} else {
				return null;
			}
			const items = candidates.map((c) => ({ value: c, label: c }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const store = readStore()[PROVIDER];
			const profiles = store?.profiles ?? {};

			const describe = (name: string) => {
				const p = profiles[name];
				const parts = [name];
				if (name === store?.active) parts.push("(active)");
				if (p?.email) parts.push(`— ${p.email}`);
				return parts.join(" ");
			};

			const doSwitch = async (name: string) => {
				try {
					const { profile, warning } = await performSwitch(name);
					if (warning) ctx.ui.notify(warning, "warning");
					ctx.ui.notify(`${PROVIDER} → ${name}${profile.email ? ` (${profile.email})` : ""}`, "info");
					updateStatus(ctx);
				} catch (e: any) {
					ctx.ui.notify(e.message ?? String(e), "error");
				}
			};

			switch (argv[0]) {
				case undefined: {
					const names = Object.keys(profiles);
					if (names.length === 0) {
						ctx.ui.notify("No profiles yet. Save the current login with /account save <name>.", "info");
						return;
					}
					if (!ctx.hasUI) return;
					const labels = names.map(describe);
					const choice = await ctx.ui.select(`Switch ${PROVIDER} account:`, labels);
					if (choice === undefined) return;
					await doSwitch(names[labels.indexOf(choice)]);
					return;
				}
				case "list": {
					const names = Object.keys(profiles);
					ctx.ui.notify(names.length ? names.map(describe).join("\n") : "No profiles saved.", "info");
					return;
				}
				case "whoami": {
					const current = (readJson(authPath()) ?? {})[PROVIDER] as Credential | undefined;
					if (!current) return ctx.ui.notify(`No ${PROVIDER} credential in auth.json.`, "error");
					if (current.type !== "oauth") return ctx.ui.notify(`Current ${PROVIDER} credential is an API key.`, "info");
					const id = await whois(String(current.access));
					ctx.ui.notify(id?.email ? `${id.email}` : "Could not identify token (expired or offline).", "info");
					return;
				}
				case "save": {
					if (!argv[1]) return ctx.ui.notify("Usage: /account save <name>", "error");
					try {
						const prof = await performSave(argv[1]);
						ctx.ui.notify(`Saved "${argv[1]}"${prof.email ? ` (${prof.email})` : ""} and marked it active.`, "info");
						updateStatus(ctx);
					} catch (e: any) {
						ctx.ui.notify(e.message ?? String(e), "error");
					}
					return;
				}
				case "remove": {
					const name = argv[1];
					if (!name || !profiles[name]) return ctx.ui.notify(`No profile "${name ?? ""}".`, "error");
					if (ctx.hasUI && !(await ctx.ui.confirm("Remove profile", `Delete stored credential "${name}"?`))) return;
					const full = readStore();
					delete full[PROVIDER].profiles[name];
					if (full[PROVIDER].active === name) full[PROVIDER].active = undefined;
					writeJson(storePath(), full);
					ctx.ui.notify(`Removed "${name}".`, "info");
					updateStatus(ctx);
					return;
				}
				default: {
					if (profiles[argv[0]]) return doSwitch(argv[0]);
					ctx.ui.notify(`Unknown profile or subcommand "${argv[0]}". Try /account list.`, "error");
				}
			}
		},
	});
}
