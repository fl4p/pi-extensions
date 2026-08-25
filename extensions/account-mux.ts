/**
 * Account multiplexer for pi's auth.json providers.
 *
 * Named credential profiles live in ~/.pi/agent/auth-profiles.json, keyed by
 * provider. A switch swaps that provider's entry in ~/.pi/agent/auth.json. Pi
 * re-reads auth.json when its file revision changes, so a switch takes effect
 * immediately, even in a running session.
 *
 * Commands (provider defaults to "anthropic"):
 *	 /account												picker (all profiles, all providers)
 *	 /account <name> [provider]			switch directly (searches all providers if omitted)
 *	 /account add <name> [provider]	 prompt for an API key, store + switch
 *	 /account save <name> [provider]	snapshot current auth.json credential
 *	 /account remove <name> [provider]
 *	 /account list [provider]
 *	 /account whoami [provider]				ask the API who the current anthropic token belongs to
 *
 * The oauth-rotation sync-back and the foreign-clobber watcher are
 * anthropic-specific; api_key profiles for other providers need neither.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, rmdirSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER = "anthropic";
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const MIN_KEY_LEN = 16;

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

// Identity check is anthropic OAuth only.
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

function keyPrefix(cred: Credential): string {
	if (cred.type === "api_key" && typeof cred.key === "string") return `…${cred.key.slice(-4)}`;
	return "";
}

// Other pi processes started under a different account can write their cached
// credential back over auth.json (observed live: a stale session restored the
// previous account's token twice). Suppress reactions to our own writes.
let selfWriteUntil = 0;

export async function performSwitch(name: string, provider = PROVIDER): Promise<{ profile: Profile; warning?: string }> {
	const store = readStore();
	const ps = store[provider];
	const target = ps?.profiles?.[name];
	if (!ps || !target) {
		throw new Error(`No profile "${name}" for ${provider}. Save one with /account save ${name} ${provider}.`);
	}
	let warning: string | undefined;

	selfWriteUntil = Date.now() + 2000;
	await withAuthLock(async () => {
		const auth = readJson(authPath()) ?? {};
		const current = auth[provider] as Credential | undefined;

		// Tokens rotate on refresh: write the (possibly rotated) live credential
		// back into the profile it belongs to before overwriting auth.json.
		const activeProfile = ps.active ? ps.profiles[ps.active] : undefined;
		if (current && activeProfile && JSON.stringify(activeProfile.credential) !== JSON.stringify(current)) {
			let owner: Profile | undefined = activeProfile;
			if (provider === PROVIDER && credentialLooksLive(current) && activeProfile.email) {
				const id = await whois(String(current.access));
				if (id?.email && id.email !== activeProfile.email) {
					// Foreign credential (stale session write-back or external /login):
					// never corrupt the active profile, but keep it if we know its owner.
					const entry = Object.entries(ps.profiles).find(([, p]) => p.email === id.email);
					owner = entry?.[1];
					warning = entry
						? `auth.json held a credential for ${id.email} — synced it into profile "${entry[0]}" instead of "${ps.active}".`
						: `auth.json held a credential for ${id.email} (no matching profile) — discarded. ` +
							`Use /account save ${name} ${provider} to keep such logins.`;
				}
			}
			if (owner) {
				owner.credential = current;
				owner.savedAt = Date.now();
			}
		}

		auth[provider] = target.credential;
		writeJson(authPath(), auth);
	});

	ps.active = name;
	writeJson(storePath(), store);
	return { profile: target, warning };
}

export async function performSave(name: string, provider = PROVIDER): Promise<Profile> {
	if (!NAME_RE.test(name)) throw new Error(`Invalid profile name "${name}" (use letters, digits, . _ -)`);
	const auth = readJson(authPath()) ?? {};
	const current = auth[provider] as Credential | undefined;
	if (!current) throw new Error(`No ${provider} credential in auth.json to save.`);

	const store = readStore();
	const ps = (store[provider] ??= { profiles: {} });
	const prof: Profile = { ...ps.profiles[name], credential: current, savedAt: Date.now() };
	if (provider === PROVIDER && credentialLooksLive(current)) {
		const id = await whois(String(current.access));
		if (id?.email) prof.email = id.email;
	}
	ps.profiles[name] = prof;
	ps.active = name;
	writeJson(storePath(), store);
	return prof;
}

export async function performAddKey(name: string, key: string, provider = PROVIDER): Promise<Profile> {
	if (!NAME_RE.test(name)) throw new Error(`Invalid profile name "${name}" (use letters, digits, . _ -)`);
	const trimmed = (key ?? "").trim();
	if (trimmed.length < MIN_KEY_LEN) throw new Error(`Key too short (min ${MIN_KEY_LEN} chars).`);
	const store = readStore();
	const ps = (store[provider] ??= { profiles: {} });
	const prof: Profile = { credential: { type: "api_key", key: trimmed }, savedAt: Date.now() };
	ps.profiles[name] = prof;
	writeJson(storePath(), store);
	return prof;
}

export function findProfiles(name: string): Array<{ provider: string; profile: Profile }> {
	const store = readStore();
	const out: Array<{ provider: string; profile: Profile }> = [];
	for (const [provider, ps] of Object.entries(store)) {
		if (ps.profiles[name]) out.push({ provider, profile: ps.profiles[name] });
	}
	return out;
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

	const SUBCOMMANDS = ["add", "save", "remove", "list", "whoami"];

	pi.registerCommand("account", {
		description: `Switch auth.json providers (multiplexer): /account [name|add <name> [provider]|save <name> [provider]|remove <name> [provider]|list [provider]|whoami [provider]]`,
		getArgumentCompletions: (prefix: string) => {
			const words = prefix.split(/\s+/);
			const store = readStore();
			const allNames = new Set<string>();
			for (const ps of Object.values(store)) for (const n of Object.keys(ps.profiles)) allNames.add(n);
			const names = [...allNames];
			let candidates: string[];
			if (words.length <= 1) {
				candidates = [...names, ...SUBCOMMANDS].filter((c) => c.startsWith(words[0] ?? ""));
			} else if (words[0] === "remove" || words[0] === "add" || words[0] === "save") {
				candidates = names.filter((n) => n.startsWith(words[1])).map((n) => `${words[0]} ${n}`);
			} else {
				return null;
			}
			const items = candidates.map((c) => ({ value: c, label: c }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const store = readStore();

			const describe = (name: string, provider: string) => {
				const p = store[provider]?.profiles?.[name];
				const parts = provider === PROVIDER ? [name] : [`${provider}/${name}`];
				if (name === store[provider]?.active) parts.push("(active)");
				if (p?.email) parts.push(`— ${p.email}`);
				else if (p && p.credential.type === "api_key") parts.push(`— API key ${keyPrefix(p.credential)}`);
				return parts.join(" ");
			};

			const doSwitch = async (name: string, provider?: string) => {
				try {
					let prov = provider;
					if (!prov) {
						const matches = findProfiles(name);
						if (matches.length === 0) throw new Error(`No profile "${name}". Try /account list.`);
						if (matches.length > 1)
							throw new Error(
								`Profile "${name}" exists for multiple providers: ${matches.map((m) => m.provider).join(", ")}. ` +
									`Use /account ${name} <provider>.`,
							);
						prov = matches[0].provider;
					}
					const { profile, warning } = await performSwitch(name, prov);
					if (warning) ctx.ui.notify(warning, "warning");
					const tag = profile.email ?? (profile.credential.type === "api_key" ? `API key ${keyPrefix(profile.credential)}` : "");
					ctx.ui.notify(`${prov} → ${name}${tag ? ` (${tag})` : ""}`, "info");
					updateStatus(ctx);
				} catch (e: any) {
					ctx.ui.notify(e.message ?? String(e), "error");
				}
			};

			switch (argv[0]) {
				case undefined: {
					const entries: Array<{ name: string; provider: string }> = [];
					for (const [provider, ps] of Object.entries(store)) {
						for (const name of Object.keys(ps.profiles)) entries.push({ name, provider });
					}
					if (entries.length === 0) {
						ctx.ui.notify("No profiles yet. Save one with /account save <name> or /account add <name>.", "info");
						return;
					}
					if (!ctx.hasUI) return;
					const labels = entries.map((e) => describe(e.name, e.provider));
					const choice = await ctx.ui.select(`Switch account:`, labels);
					if (choice === undefined) return;
					const picked = entries[labels.indexOf(choice)];
					await doSwitch(picked.name, picked.provider);
					return;
				}
				case "list": {
					const provider = argv[1];
					const lines: string[] = [];
					for (const [prov, ps] of Object.entries(store)) {
						if (provider && prov !== provider) continue;
						for (const name of Object.keys(ps.profiles)) lines.push(describe(name, prov));
					}
					ctx.ui.notify(lines.length ? lines.join("\n") : "No profiles saved.", "info");
					return;
				}
				case "whoami": {
					const provider = argv[1] ?? PROVIDER;
					const current = (readJson(authPath()) ?? {})[provider] as Credential | undefined;
					if (!current) return ctx.ui.notify(`No ${provider} credential in auth.json.`, "error");
					if (current.type !== "oauth")
						return ctx.ui.notify(`Current ${provider} credential is an API key ${keyPrefix(current)}.`, "info");
					if (provider !== PROVIDER)
						return ctx.ui.notify(`whoami is implemented for the ${PROVIDER} provider only.`, "warning");
					const id = await whois(String(current.access));
					ctx.ui.notify(id?.email ? `${id.email}` : "Could not identify token (expired or offline).", "info");
					return;
				}
				case "save": {
					if (!argv[1]) return ctx.ui.notify("Usage: /account save <name> [provider]", "error");
					const provider = argv[2] ?? PROVIDER;
					try {
						const prof = await performSave(argv[1], provider);
						ctx.ui.notify(`Saved "${argv[1]}"${prof.email ? ` (${prof.email})` : ""} and marked it active.`, "info");
						updateStatus(ctx);
					} catch (e: any) {
						ctx.ui.notify(e.message ?? String(e), "error");
					}
					return;
				}
				case "add": {
					if (!argv[1]) return ctx.ui.notify("Usage: /account add <name> [provider]", "error");
					const provider = argv[2] ?? PROVIDER;
					if (!ctx.hasUI) return;
					const key = (await ctx.ui.input(`Paste API key for "${argv[1]}" (${provider}):`, "sk-..."))?.trim();
					if (!key) return ctx.ui.notify("Cancelled.", "info");
					try {
						await performAddKey(argv[1], key, provider);
					} catch (e: any) {
						return ctx.ui.notify(e.message ?? String(e), "error");
					}
					try {
						const { profile } = await performSwitch(argv[1], provider);
						const tag = profile.email ?? (profile.credential.type === "api_key" ? `API key ${keyPrefix(profile.credential)}` : "");
						ctx.ui.notify(`${provider} → ${argv[1]}${tag ? ` (${tag})` : ""}`, "info");
						updateStatus(ctx);
					} catch (e: any) {
						ctx.ui.notify(
							`Saved "${argv[1]}" but couldn't switch: ${e.message ?? e}. ` +
								"(auth.json frozen? run: chflags nouchg ~/.pi/agent/auth.json)",
							"warning",
						);
					}
					return;
				}
				case "remove": {
					const name = argv[1];
					const provider = argv[2];
					if (!name) return ctx.ui.notify(`No profile "${name ?? ""}".`, "error");
					const matches = provider ? (store[provider]?.profiles?.[name] ? [{ provider }] : []) : findProfiles(name);
					if (matches.length === 0) return ctx.ui.notify(`No profile "${name}".`, "error");
					if (matches.length > 1)
						return ctx.ui.notify(
							`Profile "${name}" exists for multiple providers: ${matches.map((m) => m.provider).join(", ")}. ` +
								`Use /account remove ${name} <provider>.`,
							"error",
						);
					const prov = matches[0].provider;
					if (ctx.hasUI && !(await ctx.ui.confirm("Remove profile", `Delete stored credential "${name}" (${prov})?`))) return;
					const full = readStore();
					delete full[prov].profiles[name];
					if (full[prov].active === name) full[prov].active = undefined;
					writeJson(storePath(), full);
					ctx.ui.notify(`Removed "${name}" from ${prov}.`, "info");
					updateStatus(ctx);
					return;
				}
				default: {
					// /account <name> [provider]
					return doSwitch(argv[0], argv[1]);
				}
			}
		},
	});
}
