/**
 * ctx-slim — shrink context-mode's tool schemas in every provider request.
 *
 * context-mode 1.0.169 registers 11 tools whose descriptions are written like
 * docs pages: philosophy, WHEN / WHEN NOT / RETURNS sections, worked examples,
 * ranking-pipeline internals, env-var tuning knobs. Measured 2026-10-23 with the
 * Qwen3.5 tokenizer on a captured pi 0.84.3 request: 7,305 tokens, 39% of all
 * tool schemas and a quarter of a "hi" request. Every token is paid on each cold
 * prefill on the local models.
 *
 * Two changes, both in `before_provider_request`:
 *
 * - Maintenance tools are removed from the payload: ctx_doctor, ctx_stats (both
 *   remain as the /ctx-doctor and /ctx-stats commands), ctx_upgrade (`pi update`
 *   does that), ctx_insight (opens a hosted dashboard) and ctx_purge
 *   (destructive; the model has no business calling it unasked). A call to one of
 *   them anyway is blocked in `tool_call`, since pi still has them registered.
 * - The remaining tools get short descriptions. Parameter schemas keep their
 *   types, enums, defaults and required lists; only description strings change.
 *
 * Drift guard: a tool is rewritten only when its parameter names are exactly the
 * set this table was written for. A context-mode release that adds, renames or
 * drops a parameter leaves that tool's original schema in place, so a short
 * description never omits a parameter it does not know about.
 *
 * Why the payload and not the bundle: `pi update` overwrites
 * ~/.pi/agent/npm/node_modules/context-mode wholesale (see ctx-exec-timeout).
 * The rewrite is deterministic, so the request prefix stays stable and prompt
 * caches keep working.
 *
 * CTX_SLIM=off disables it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CTX_SLIM_ENV = "CTX_SLIM";

export const DROPPED_TOOLS: ReadonlySet<string> = new Set([
	"ctx_doctor",
	"ctx_stats",
	"ctx_upgrade",
	"ctx_insight",
	"ctx_purge",
]);

type Slim = { description: string; params: Readonly<Record<string, string>> };

const TIMEOUT = "Max execution time in ms.";
const INTENT =
	"What you are looking for. If the output exceeds ~5 KB it is indexed and only matching section titles and previews come back (drill in with ctx_search).";
const LANGUAGE = "Runtime language.";

export const SLIM_TOOLS: Readonly<Record<string, Slim>> = {
	ctx_execute: {
		description:
			"Run code in a sandboxed subprocess; only what it prints enters the conversation. Use it to derive an answer from large or unpredictable output (repo-wide greps, log scans, API listings, test runs) and print only the result. Not for edits, navigation, or short output you want verbatim.",
		params: {
			language: LANGUAGE,
			code: "Source code. Print a summary (console.log, print, echo, fmt.Println, IO.puts, Console.WriteLine).",
			timeout: TIMEOUT,
			background: "Keep the process running after the timeout (servers, daemons) and return partial output. Do not add self-close timers.",
			cwd: "Working directory for shell code. Other languages run in a sandbox temp directory.",
			intent: INTENT,
		},
	},
	ctx_execute_file: {
		description:
			"Load a file into the FILE_CONTENT variable and run code over it; only what the code prints enters the conversation. Use it to learn something about a large or structured file (counts, matches, parsed fields). To edit a file, or to read a small one in full, use read.",
		params: {
			path: "Absolute path, or relative to the project root.",
			language: LANGUAGE,
			code: "Code that processes FILE_CONTENT (file_content in Elixir) and prints a summary.",
			timeout: TIMEOUT,
			intent: INTENT,
		},
	},
	ctx_batch_execute: {
		description:
			"Run several shell commands in one call. All output is indexed; the sections matching `queries` come back inline, so no follow-up search is needed. Use for 3+ related commands (gh lookups, git log/diff/blame, multi-file reads).",
		params: {
			commands: "Commands to run; each output is indexed under its label.",
			queries: "Questions to answer from the indexed output. Put all of them here.",
			timeout:
				"Max ms. With concurrency 1 it is one budget shared by all commands, and commands after a timeout are skipped; with concurrency > 1 it applies per command.",
			concurrency:
				"Commands run in parallel, 1-8. Use 4-8 for I/O-bound work (network, gh, git reads); keep 1 for builds, tests and anything stateful.",
			cwd: "Working directory for all commands.",
			query_scope: "`batch`: search only this batch's output. `global`: the whole index.",
		},
	},
	ctx_search: {
		description:
			"Search the knowledge base: content stored by ctx_index, ctx_fetch_and_index and ctx_batch_execute, plus auto-captured session events (decisions, errors, plans, user prompts). Batch all questions into one call, 2-4 specific technical terms each.",
		params: {
			queries: "Search queries; batch all questions in one call.",
			limit: "Results per query.",
			source: "Restrict to one source label (partial match), e.g. a ctx_index label or `decision`, `error`, `plan`.",
			contentType: "Only code or only prose.",
			sort: "`relevance`: ranked, current session only. `timeline`: chronological across sessions and auto-memory.",
		},
	},
	ctx_index: {
		description:
			"Store docs in the searchable knowledge base (split by headings, code blocks kept whole) for later ctx_search; nothing is echoed back. For docs, API references and READMEs you will query again; for logs and test output use ctx_execute_file instead.",
		params: {
			content: "Text or markdown to index. Give this or path.",
			path: "File or directory to index (content never enters the conversation). Directories are walked recursively.",
			source: "Label to search it by later.",
			include: "Directory only: glob patterns to include.",
			exclude: "Directory only: glob patterns to exclude, on top of node_modules, .git, build dirs and venvs.",
			maxDepth: "Directory only: max recursion depth (default 5).",
			maxFiles: "Directory only: max files (default 200).",
			extensions: "Directory only: file extensions to index (default: common text, doc and code types).",
			respectGitignore: "Directory only: apply the nearest .gitignore (default true).",
			followSymlinks: "Directory only: follow directory symlinks (default false).",
		},
	},
	ctx_fetch_and_index: {
		description:
			"Fetch URLs (plain HTTP, no JavaScript rendering), convert to markdown, index, and return a short preview per source; query the rest with ctx_search. Fetches are cached for 24 h.",
		params: {
			url: "Single URL.",
			source: "Label for the single `url`.",
			requests: "Batch form: [{url, source?}], results in input order.",
			concurrency: "Parallel fetches for `requests`, 1-8.",
			force: "Bypass the cache.",
			ttl: "Cache freshness window in ms for this call; 0 bypasses the cache.",
		},
	},
};

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON-schema object of a function declaration, whichever key the provider uses. */
function schemaKey(decl: Json): string | undefined {
	for (const key of ["parameters", "input_schema", "parametersJsonSchema"]) if (isObj(decl[key])) return key;
	return undefined;
}

/** Slimmed copy of one declaration, or the original when it is unknown or has drifted. */
export function slimDeclaration(decl: Json): Json {
	const name = decl.name;
	if (typeof name !== "string") return decl;
	const slim = SLIM_TOOLS[name];
	if (!slim) return decl;
	const key = schemaKey(decl);
	if (!key) return decl;
	const schema = decl[key] as Json;
	const props = isObj(schema.properties) ? schema.properties : {};
	const have = Object.keys(props).sort().join(",");
	const want = Object.keys(slim.params).sort().join(",");
	if (have !== want) return decl;
	const properties: Json = {};
	for (const [prop, def] of Object.entries(props)) {
		properties[prop] = isObj(def) ? { ...def, description: slim.params[prop] } : def;
	}
	return { ...decl, description: slim.description, [key]: { ...schema, properties } };
}

const declName = (entry: Json): unknown => (isObj(entry.function) ? entry.function.name : entry.name);

/**
 * Pure. Handles the tool-list shapes pi's providers build: OpenAI chat
 * (`{type, function: {...}}`), OpenAI responses and Anthropic (flat
 * `{name, description, parameters | input_schema}`), and Google
 * (`{functionDeclarations: [...]}`). Anything else passes through unchanged.
 */
export function slimTools(tools: readonly unknown[]): unknown[] {
	const out: unknown[] = [];
	for (const entry of tools) {
		if (!isObj(entry)) {
			out.push(entry);
			continue;
		}
		if (Array.isArray(entry.functionDeclarations)) {
			const decls = entry.functionDeclarations.filter((d) => !(isObj(d) && DROPPED_TOOLS.has(d.name as string)));
			out.push({ ...entry, functionDeclarations: decls.map((d) => (isObj(d) ? slimDeclaration(d) : d)) });
			continue;
		}
		if (DROPPED_TOOLS.has(declName(entry) as string)) continue;
		if (isObj(entry.function)) out.push({ ...entry, function: slimDeclaration(entry.function) });
		else out.push(slimDeclaration(entry));
	}
	return out;
}

/** Pure. Returns the payload itself when there is nothing to change. */
export function slimPayload(payload: unknown): unknown {
	if (!isObj(payload) || !Array.isArray(payload.tools)) return payload;
	return { ...payload, tools: slimTools(payload.tools) };
}

export function ctxSlimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env[CTX_SLIM_ENV]?.trim().toLowerCase();
	return !(v === "off" || v === "0" || v === "false");
}

export default function ctxSlim(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		if (!ctxSlimEnabled()) return undefined;
		const slimmed = slimPayload(event.payload);
		return slimmed === event.payload ? undefined : slimmed;
	});

	pi.on("tool_call", (event) => {
		if (!ctxSlimEnabled() || !DROPPED_TOOLS.has(event.toolName)) return undefined;
		return {
			block: true,
			reason: `${event.toolName} is not offered to the model (ctx-slim extension). Ask the user to run it, e.g. /ctx-stats or /ctx-doctor.`,
		};
	});
}
