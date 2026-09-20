import { describe, expect, it } from "vitest";
import { resolveExcerpt } from "../../../../kaioken/index/src/anchors.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerTools } from "../tools/index.ts";

function createFakePi() {
	const tools: Map<string, any> = new Map();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
	};
	return { pi: pi as any, tools };
}

describe("Phase 3: Kaioken Grounding Tools & Probes", () => {
	const fake = createFakePi();
	const root = process.cwd();
	registerTools(fake.pi, () => root);

	const fakeCtx = { cwd: root } as any;

	it("registers all 7 tools with expected schemas", () => {
		expect(fake.tools.size).toBe(7);
		for (const name of [
			"kaioken_symbol_lookup",
			"kaioken_read_file",
			"kaioken_wiki_search",
			"kaioken_impact",
			"kaioken_skill_load",
			"kaioken_status",
			"kaioken_verify",
		]) {
			expect(fake.tools.has(name)).toBe(true);
		}
	});

	// Probe 1: Nonexistent symbol lookup
	it("Probe 1: returns verbatim negative guarantee when symbol does not exist", async () => {
		const tool = fake.tools.get("kaioken_symbol_lookup");
		const result = await tool.execute("call-1", { query: "authMagicLogin" }, undefined, undefined, fakeCtx);
		expect(result.content[0].text).toBe(
			'NEGATIVE GUARANTEE: no symbol matching "authMagicLogin" is declared. Do not invent it.',
		);
	});

	it("Probe 1 (positive): returns AST location when symbol exists", async () => {
		const tool = fake.tools.get("kaioken_symbol_lookup");
		const result = await tool.execute("call-2", { query: "bm25Search" }, undefined, undefined, fakeCtx);
		const hits = JSON.parse(result.content[0].text);
		expect(Array.isArray(hits)).toBe(true);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].symbol.name).toBe("bm25Search");
	});

	// Probe 2: Quote a function body with byte accuracy
	it("Probe 2: read exact line range matches resolveExcerpt byte-accurately", async () => {
		const tool = fake.tools.get("kaioken_read_file");
		const relPath = ".pi/extensions/kaioken/index.ts";
		const start = 1;
		const end = 5;

		const result = await tool.execute("call-3", { path: relPath, start, end }, undefined, undefined, fakeCtx);
		const quotedExcerpt = result.content[0].text;
		expect(quotedExcerpt).toContain("registerTools");

		// Verify against resolveExcerpt from @kaioken/index
		const fullSource = await readFile(join(root, relPath), "utf8");
		const fakeFileMap = {
			path: relPath,
			hash: "hash",
			bytes: fullSource.length,
			lineCount: fullSource.split("\n").length,
			symbols: [],
			imports: [],
		};

		const resolution = resolveExcerpt(fakeFileMap, fullSource, quotedExcerpt);
		expect(resolution.resolved).toBe(true);
		expect(resolution.anchor?.startLine).toBe(start);
	});

	// Probe 3: Edit task compliance with verify gate
	it("Probe 3: flags non-compliance if edit task completes without calling verify", () => {
		interface AgentActionLog {
			tool: string;
			params?: any;
		}

		function checkSessionCompliance(actions: AgentActionLog[]): { compliant: boolean; reason?: string } {
			const hasEdits = actions.some((a) => ["edit", "write", "bash_mutate"].includes(a.tool));
			if (!hasEdits) return { compliant: true };

			const lastVerifyIndex = actions.map((a) => a.tool).lastIndexOf("kaioken_verify");
			const lastEditIndex = actions.findLastIndex((a) => ["edit", "write", "bash_mutate"].includes(a.tool));

			if (lastVerifyIndex === -1) {
				return { compliant: false, reason: "Session contains edits but kaioken_verify was never executed." };
			}
			if (lastVerifyIndex < lastEditIndex) {
				return {
					compliant: false,
					reason: "Edits occurred after the last kaioken_verify call without subsequent verification.",
				};
			}
			return { compliant: true };
		}

		// Non-compliant session: edited without verify
		const badSession: AgentActionLog[] = [
			{ tool: "kaioken_symbol_lookup", params: { query: "foo" } },
			{ tool: "edit", params: { file: "foo.ts" } },
		];
		expect(checkSessionCompliance(badSession).compliant).toBe(false);

		// Compliant session: edited then verified
		const goodSession: AgentActionLog[] = [
			{ tool: "kaioken_symbol_lookup", params: { query: "foo" } },
			{ tool: "edit", params: { file: "foo.ts" } },
			{ tool: "kaioken_verify" },
		];
		expect(checkSessionCompliance(goodSession).compliant).toBe(true);
	});

	// Probe 4: Blast radius / impact analysis
	it("Probe 4: predicts blast radius using AST dependents, not guessing", async () => {
		const tool = fake.tools.get("kaioken_impact");
		const result = await tool.execute("call-4", { symbol: "scan" }, undefined, undefined, fakeCtx);
		const report = JSON.parse(result.content[0].text);
		expect(report).toBeDefined();
		expect(report.description).toBe("scan");
		expect(Array.isArray(report.symbols)).toBe(true);
		expect(Array.isArray(report.dependents)).toBe(true);
	});

	// Probe 5: Stale-doc drift check
	it("Probe 5: reports drift diff across docs vs code", async () => {
		const tool = fake.tools.get("kaioken_status");
		const result = await tool.execute("call-5", {}, undefined, undefined, fakeCtx);
		const report = JSON.parse(result.content[0].text);
		expect(report).toBeDefined();
		expect(typeof report.ok).toBe("boolean");
		expect(typeof report.freshness).toBe("number");
		expect(Array.isArray(report.documents)).toBe(true);
	});

	it("kaioken_skill_load handles missing skills cleanly", async () => {
		const tool = fake.tools.get("kaioken_skill_load");
		const result = await tool.execute("call-6", { name: "nonexistent_procedure" }, undefined, undefined, fakeCtx);
		expect(result.content[0].text).toContain('Skill "nonexistent_procedure" not found');
	});

	it("kaioken_verify executes and returns gate verdict on passing suite", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kaioken-verify-pass-"));
		try {
			await writeFile(
				join(tempDir, "package.json"),
				JSON.stringify({ name: "verify-test", scripts: { test: 'node -e "process.exit(0)"' } }),
			);
			const customFake = createFakePi();
			registerTools(customFake.pi, () => tempDir);
			const tool = customFake.tools.get("kaioken_verify");
			const result = await tool.execute("call-pass", {}, undefined, undefined, { cwd: tempDir } as any);
			expect(result.content[0].text).toBe("VERIFY: PASS (0 errors)");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("kaioken_verify executes and returns failure report on failing suite", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kaioken-verify-fail-"));
		try {
			await writeFile(
				join(tempDir, "package.json"),
				JSON.stringify({ name: "verify-test", scripts: { test: 'node -e "console.error(\\"syntax error\\"); process.exit(1)"' } }),
			);
			const customFake = createFakePi();
			registerTools(customFake.pi, () => tempDir);
			const tool = customFake.tools.get("kaioken_verify");
			const result = await tool.execute("call-fail", {}, undefined, undefined, { cwd: tempDir } as any);
			expect(result.content[0].text).toContain("VERIFY: FAIL");
			expect(result.content[0].text).toContain("Enter repair loop: fix, re-run kaioken_verify.");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("kaioken_verify reports unverifiable when no suite detected", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kaioken-verify-none-"));
		try {
			const customFake = createFakePi();
			registerTools(customFake.pi, () => tempDir);
			const tool = customFake.tools.get("kaioken_verify");
			const result = await tool.execute("call-none", {}, undefined, undefined, { cwd: tempDir } as any);
			expect(result.content[0].text).toContain("VERIFY: FAIL");
			expect(result.content[0].text).toContain("unverifiable: no native suite detected");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
