import assert from "node:assert/strict";
import test from "node:test";
import googleSearchExtension, { hasGoogleRedirects, isGoogleRedirectUrl } from "../extensions/google-search.ts";

function createTool() {
	let tool;
	googleSearchExtension({
		registerTool(value) {
			tool = value;
		},
	});
	return tool;
}

function abortableFetch(_url, options) {
	return new Promise((resolve, reject) => {
		const abort = () => reject(options.signal.reason ?? new Error("aborted"));
		if (options.signal.aborted) abort();
		else options.signal.addEventListener("abort", abort, { once: true });
	});
}

const theme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
};

test("google_search bounds its request schema and renders", () => {
	const tool = createTool();
	assert.equal(tool.parameters.properties.queries.maxItems, 4);
	assert.equal(tool.parameters.properties.queries.items.minLength, 1);
	assert.equal(tool.parameters.properties.num.type, "integer");
	assert.doesNotThrow(() => tool.renderCall({ query: "pi extensions" }, theme));
	assert.doesNotThrow(() =>
		tool.renderResult(
			{ content: [], details: { queryCount: 1, successfulQueries: 1, totalResults: 2, provider: "test" } },
			{},
			theme,
		),
	);
});

test("google_search rejects excessive, blank, and fractional inputs before fetch", async () => {
	const tool = createTool();
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		throw new Error("unexpected fetch");
	};
	process.env.SERPER_API_KEY = "test";
	try {
		for (const params of [
			{ queries: ["a", "b", "c", "d", "e"] },
			{ queries: [" "] },
			{ query: "valid", num: 1.5 },
		]) {
			const result = await tool.execute("invalid", params);
			assert.ok(result.details.error);
		}
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("google_search composes its request deadline with Pi's signal", async () => {
	const tool = createTool();
	const originalFetch = globalThis.fetch;
	const originalTimeout = AbortSignal.timeout;
	globalThis.fetch = abortableFetch;
	AbortSignal.timeout = () => originalTimeout.call(AbortSignal, 20);
	process.env.SERPER_API_KEY = "test";
	try {
		const caller = new AbortController();
		const started = Date.now();
		const result = await tool.execute("timeout", { query: "deadline" }, caller.signal);
		assert.ok(Date.now() - started < 1000);
		assert.equal(result.details.successfulQueries, 0);
		assert.match(result.content[0].text, /Error:/);
	} finally {
		AbortSignal.timeout = originalTimeout;
		globalThis.fetch = originalFetch;
	}
});

test("google_search propagates caller cancellation and stops subsequent queries", async () => {
	const tool = createTool();
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (...args) => {
		calls++;
		return abortableFetch(...args);
	};
	process.env.SERPER_API_KEY = "test";
	const caller = new AbortController();
	setTimeout(() => caller.abort(new Error("cancelled by caller")), 20);
	try {
		await assert.rejects(
			tool.execute("cancel", { queries: ["first", "second"] }, caller.signal),
			/cancelled by caller/,
		);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("hasGoogleRedirects detects redirect urls across sections", () => {
	assert.equal(isGoogleRedirectUrl("https://example.com"), false);
	assert.equal(isGoogleRedirectUrl("https://www.google.com/goto?url=CAES..."), true);
	assert.equal(isGoogleRedirectUrl("https://www.google.com/url?q=https://example.com"), true);

	assert.equal(hasGoogleRedirects({ organic: [{ title: "T", link: "https://example.com" }] }), false);
	assert.equal(
		hasGoogleRedirects({ organic: [{ title: "T", link: "https://www.google.com/goto?url=xyz" }] }),
		true,
	);
	assert.equal(
		hasGoogleRedirects({ news: [{ title: "N", link: "https://www.google.com/goto?url=xyz" }] }),
		true,
	);
	assert.equal(
		hasGoogleRedirects({ images: [{ title: "I", link: "https://www.google.com/goto?url=xyz" }] }),
		true,
	);
	assert.equal(
		hasGoogleRedirects({ knowledgeGraph: { website: "https://www.google.com/goto?url=xyz" } }),
		true,
	);
});

test("google_search resolves google.com/goto links when present", async () => {
	const tool = createTool();
	const originalFetch = globalThis.fetch;
	const calledUrls = [];
	globalThis.fetch = async (url, opts) => {
		calledUrls.push(url);
		if (url === "https://google.serper.dev/search") {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					organic: [
						{ title: "Direct", link: "https://example.com" },
						{ title: "Redirected", link: "https://www.google.com/goto?url=CAES" },
					],
				}),
			};
		}
		if (url === "https://google.serper.dev/resolve") {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					organic: [
						{ title: "Direct", link: "https://example.com" },
						{ title: "Redirected", link: "https://resolved.example.com" },
					],
				}),
			};
		}
		throw new Error(`Unexpected url: ${url}`);
	};
	process.env.SERPER_API_KEY = "test";
	try {
		const result = await tool.execute("resolve-test", { query: "test query" });
		assert.deepEqual(calledUrls, ["https://google.serper.dev/search", "https://google.serper.dev/resolve"]);
		assert.match(result.content[0].text, /https:\/\/resolved\.example\.com/);
		assert.doesNotMatch(result.content[0].text, /google\.com\/goto/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("google_search skips /resolve when no redirect urls or resolve: false", async () => {
	const tool = createTool();
	const originalFetch = globalThis.fetch;
	let calledUrls = [];
	globalThis.fetch = async (url) => {
		calledUrls.push(url);
		return {
			ok: true,
			status: 200,
			json: async () => ({
				organic: [
					{ title: "Direct 1", link: "https://example.com/1" },
					{ title: "Direct 2", link: "https://example.com/2" },
				],
			}),
		};
	};
	process.env.SERPER_API_KEY = "test";
	try {
		// Case 1: All direct links
		await tool.execute("skip-test-1", { query: "direct only" });
		assert.deepEqual(calledUrls, ["https://google.serper.dev/search"]);

		// Case 2: Redirect links present but resolve: false
		calledUrls = [];
		globalThis.fetch = async (url) => {
			calledUrls.push(url);
			return {
				ok: true,
				status: 200,
				json: async () => ({
					organic: [
						{ title: "Direct", link: "https://example.com" },
						{ title: "Redirect", link: "https://www.google.com/goto?url=CAES" },
					],
				}),
			};
		};
		const result = await tool.execute("skip-test-2", { query: "opt out", resolve: false });
		assert.deepEqual(calledUrls, ["https://google.serper.dev/search"]);
		assert.match(result.content[0].text, /google\.com\/goto/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
