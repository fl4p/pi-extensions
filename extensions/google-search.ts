import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

function getApiKey(): string | null {
	const env = process.env.SERPER_API_KEY;
	if (typeof env === "string" && env.trim().length > 0) return env.trim();
	if (!existsSync(CONFIG_PATH)) return null;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { serperApiKey?: unknown };
		return typeof raw.serperApiKey === "string" && raw.serperApiKey.trim().length > 0
			? raw.serperApiKey.trim()
			: null;
	} catch {
		return null;
	}
}

interface SerperResult {
	title: string;
	link: string;
	snippet?: string;
	position?: number;
}

interface SerperResponse {
	organic?: SerperResult[];
	knowledgeGraph?: { title?: string; description?: string; website?: string };
	answerBox?: { snippet?: string; title?: string };
	news?: SerperResult[];
	images?: SerperResult[];
	searchParameters?: { q?: string; gl?: string; hl?: string };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "google_search",
		label: "Google Search",
		description:
			"Search Google directly via Serper.dev and return raw organic results (titles, URLs, snippets). No model synthesis — just the blue links. Use for factual lookups, current data, or when you want Google's actual ranking. Prefer queries (plural) with 2-4 varied angles for broader coverage.",
		promptSnippet: "Search Google directly (Serper) — raw blue links, no synthesis",
		promptGuidelines: [
			"For web lookups, prefer google_search (raw Google results via Serper) as the default. Use web_search only when the user explicitly wants a synthesized answer or multi-source narrative.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query." })),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Multiple queries searched in sequence. Vary phrasing/scope across 2-4 queries for broader coverage.",
				}),
			),
			num: Type.Optional(
				Type.Number({ description: "Results per query (default 10, max 100).", minimum: 1, maximum: 100 }),
			),
			gl: Type.Optional(Type.String({ description: "Country code, e.g. 'us', 'de' (default us)." })),
			hl: Type.Optional(Type.String({ description: "Language code, e.g. 'en', 'de' (default en)." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const apiKey = getApiKey();
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Error: No Serper API key. Set SERPER_API_KEY env var or add `serperApiKey` to ~/.pi/web-search.json. Get a key at https://serper.dev",
						},
					],
					details: { error: "Missing Serper API key" },
				};
			}

			const queryList: string[] = Array.isArray(params.queries)
				? params.queries
				: params.query !== undefined
					? [params.query]
					: [];
			if (queryList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries'." }],
					details: { error: "No query provided" },
				};
			}

			const num = Math.min(Math.max(params.num ?? 10, 1), 100);
			const allResults: Array<{ query: string; results: SerperResult[]; error?: string }> = [];
			let totalResults = 0;

			for (let i = 0; i < queryList.length; i++) {
				const q = queryList[i];
				onUpdate?.({
					content: [{ type: "text", text: `Searching Google (${i + 1}/${queryList.length}): "${q}"` }],
					details: { phase: "searching", progress: i / queryList.length, currentQuery: q },
				});

				try {
					const res = await fetch("https://google.serper.dev/search", {
						method: "POST",
						headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
						body: JSON.stringify({
							q,
							num,
							...(params.gl ? { gl: params.gl } : {}),
							...(params.hl ? { hl: params.hl } : {}),
						}),
						signal: signal ?? AbortSignal.timeout(30000),
					});

					if (!res.ok) {
						const errText = await res.text().catch(() => "");
						allResults.push({
							query: q,
							results: [],
							error: `HTTP ${res.status}: ${errText.slice(0, 200)}`,
						});
						continue;
					}

					const data = (await res.json()) as SerperResponse;
					const organic = data.organic ?? [];
					allResults.push({ query: q, results: organic });
					totalResults += organic.length;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					allResults.push({ query: q, results: [], error: msg });
				}
			}

			let output = "";
			for (const { query, results, error } of allResults) {
				if (allResults.length > 1) output += `## Google Search: "${query}"\n\n`;
				if (error) {
					output += `Error: ${error}\n\n`;
				} else if (results.length === 0) {
					output += "No results found.\n\n";
				} else {
					for (const r of results) {
						output += `### ${r.title}\n${r.link}\n`;
						if (r.snippet) output += `${r.snippet}\n`;
						output += "\n";
					}
				}
			}

			return {
				content: [{ type: "text", text: output.trim() }],
				details: {
					queryCount: queryList.length,
					successfulQueries: allResults.filter((r) => !r.error).length,
					totalResults,
					provider: "google (serper)",
				},
			};
		},
		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: input.query !== undefined
					? [input.query]
					: [];
			const queryList = (rawQueryList.filter((q): q is string => typeof q === "string" && q.trim().length > 0));
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("google search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
				return new Text(theme.fg("toolTitle", theme.bold("google search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("google search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				provider?: string;
			};
			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}
			const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			const providerStr = details?.provider ? ` (provider: ${details.provider})` : "";
			return new Text(
				theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`) + theme.fg("muted", providerStr),
				0,
				0,
			);
		},
	});
}
