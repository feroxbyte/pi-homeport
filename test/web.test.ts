import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToMarkdown } from "../extensions/web/html-markdown.ts";
import webExtension, { decodeEntities, filterByDomain, isPrivateAddress, parseSearchResults, resolveResultUrl, stripTags } from "../extensions/web/index.ts";

const SEARCH_PAGE = `
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsvelte.dev%2Fdocs%2Frunes&rut=x">Runes &amp; state</a>
<a class="result__snippet" href="x">Use <b>$state</b> for reactive values</a></div>
<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">An ad</a>
<a class="result__snippet" href="x">Buy now</a></div>
<div class="result"><a class="result__a" href="https://example.com/blog">A post</a></div>
`;

describe("web search results", () => {
	it("reads titles, targets and snippets, and skips ads", () => {
		const results = parseSearchResults(SEARCH_PAGE, 10);
		assert.deepEqual(results, [
			{ title: "Runes & state", url: "https://svelte.dev/docs/runes", snippet: "Use $state for reactive values" },
			{ title: "A post", url: "https://example.com/blog", snippet: "" },
		]);
	});

	it("stops at the limit", () => {
		assert.equal(parseSearchResults(SEARCH_PAGE, 1).length, 1);
	});

	it("resolves DuckDuckGo's redirect links and scheme-less links", () => {
		assert.equal(resolveResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.dev%2Fx%3Fy%3D1"), "https://a.dev/x?y=1");
		assert.equal(resolveResultUrl("//a.dev/x"), "https://a.dev/x");
		assert.equal(resolveResultUrl("https://a.dev/x"), "https://a.dev/x");
	});

	it("decodes entities and strips tags", () => {
		assert.equal(decodeEntities("a &amp; b &lt;c&gt;"), "a & b <c>");
		assert.equal(stripTags("<b>Hello</b>   <i>world</i>"), "Hello world");
	});

	it("filters by allowed or blocked domain, including subdomains", () => {
		const results = [
			{ title: "a", url: "https://svelte.dev/x", snippet: "" },
			{ title: "b", url: "https://kit.svelte.dev/y", snippet: "" },
			{ title: "c", url: "https://example.com/z", snippet: "" },
		];
		assert.deepEqual(filterByDomain(results, ["svelte.dev"], undefined).map((r) => r.title), ["a", "b"]);
		assert.deepEqual(filterByDomain(results, undefined, ["svelte.dev"]).map((r) => r.title), ["c"]);
		// Allowed wins when both are given, as in Claude Code
		assert.deepEqual(filterByDomain(results, ["example.com"], ["example.com"]).map((r) => r.title), ["c"]);
		assert.equal(filterByDomain(results, undefined, undefined).length, 3);
	});
});

describe("web fetch safety", () => {
	it("refuses loopback, private, link-local and embedded private addresses", () => {
		for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "[::1]"]) {
			assert.equal(isPrivateAddress(ip), true, ip);
		}
	});

	it("allows public addresses", () => {
		for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
	});

	it("fails closed on addresses it can't parse", () => {
		assert.equal(isPrivateAddress("not-an-ip"), true);
		assert.equal(isPrivateAddress("999.1.1.1"), true);
	});
});

describe("html to markdown", () => {
	it("keeps headings, links and lists, and drops scripts and styles", () => {
		const md = htmlToMarkdown(
			`<html><head><style>p{}</style></head><body><script>alert(1)</script><h1>Title</h1><p>See <a href="https://a.dev">the docs</a>.</p><ul><li>one</li><li>two</li></ul></body></html>`,
		);
		assert.match(md, /# Title/);
		assert.match(md, /\[the docs\]\(https:\/\/a\.dev\)/);
		assert.match(md, /- one/);
		assert.doesNotMatch(md, /alert|p\{\}/);
	});
});

describe("web tools", () => {
	const tools = new Map<string, any>();
	webExtension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as never);

	it("registers web_search and web_fetch", () => {
		assert.deepEqual([...tools.keys()].sort(), ["web_fetch", "web_search"]);
	});

	it("refuses a URL that isn't http or https without any request", async () => {
		const result = await tools.get("web_fetch").execute("id", { url: "file:///etc/passwd" }, undefined, undefined, {});
		assert.equal(result.content[0].text, "Only http(s) URLs are supported.");
	});

	it("refuses a private host before connecting", async () => {
		await assert.rejects(() => tools.get("web_fetch").execute("id", { url: "http://127.0.0.1:9/" }, undefined, undefined, {}), /private\/internal address/);
	});
});
