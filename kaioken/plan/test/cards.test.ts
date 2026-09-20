import { describe, expect, it } from "vitest";
import { SymbolOracle, type IndexResult } from "@kaioken/index";
import type { ModelClient, ModelRequest } from "@kaioken/modelport";
import { buildCardPrompt, generateCard, generateCards, verifyCard } from "../src/cards.ts";
import type { Module, ModulePlan } from "../src/types.ts";
import type { ModuleEvidence } from "../src/evidence.ts";

function scriptedClient(replies: string[]): ModelClient & { requests: ModelRequest[] } {
	const requests: ModelRequest[] = [];
	let index = 0;
	return {
		requests,
		async complete(request: ModelRequest): Promise<string> {
			requests.push(request);
			const reply = replies[Math.min(index, replies.length - 1)] ?? "{}";
			index++;
			return reply;
		},
	};
}

function indexOf(
	files: Array<{ path: string; symbols?: Array<{ name: string; exported?: boolean; parent?: string }> }>,
): IndexResult {
	return {
		root: "/repo",
		builtAt: "",
		fileCount: files.length,
		symbolCount: files.reduce((n, f) => n + (f.symbols?.length ?? 0), 0),
		unparsedLanguages: {},
		files: files.map((f) => ({
			path: f.path,
			language: "typescript",
			lineCount: 10,
			hash: `hash-${f.path}`,
			symbols: (f.symbols ?? []).map((s) => ({
				name: s.name,
				kind: "function",
				exported: s.exported ?? true,
				parent: s.parent,
				signature: `${s.name}(): void`,
				startLine: 1,
				endLine: 2,
			})),
			imports: [],
		})),
	} as unknown as IndexResult;
}

const module: Module = { id: "core", name: "Core", purpose: "The core.", files: ["src/a.ts"] };

const evidence: ModuleEvidence = {
	files: [{ path: "src/a.ts", language: "typescript", lineCount: 10, declarations: ["+ alpha — alpha(): void"] }],
	missing: [],
	totalSymbols: 1,
	exportedSymbols: ["alpha"],
};

function draft(summary: string, entryPoints: Array<{ name: string; file: string }>) {
	return JSON.stringify({ summary, keyPoints: ["k"], entryPoints: entryPoints.map((e) => ({ ...e, note: "n" })) });
}

describe("cards: verification", () => {
	const oracle = new SymbolOracle(indexOf([{ path: "src/a.ts", symbols: [{ name: "alpha" }] }]));

	it("grounds an entry point that this module really declares", () => {
		const result = verifyCard(
			{ summary: "s", keyPoints: [], entryPoints: [{ name: "alpha", file: "src/a.ts", note: "" }] },
			module,
			evidence,
			oracle,
		);
		expect(result.grounded).toBe(1);
		expect(result.ungrounded).toEqual([]);
	});

	it("flags an entry point the repository does not declare", () => {
		const result = verifyCard(
			{ summary: "s", keyPoints: [], entryPoints: [{ name: "authMagicLogin", file: "src/a.ts", note: "" }] },
			module,
			evidence,
			oracle,
		);
		expect(result.ungrounded).toContain("authMagicLogin");
	});

	it("accepts a dotted method reference by its last segment", () => {
		const withMethod = new SymbolOracle(
			indexOf([{ path: "src/a.ts", symbols: [{ name: "run", parent: "Engine" }] }]),
		);
		const result = verifyCard(
			{ summary: "s", keyPoints: [], entryPoints: [{ name: "Engine.run", file: "src/a.ts", note: "" }] },
			module,
			{ ...evidence, exportedSymbols: ["run"] },
			withMethod,
		);
		expect(result.grounded).toBe(1);
	});

	it("flags a file outside the module's scope", () => {
		const result = verifyCard(
			{ summary: "s", keyPoints: [], entryPoints: [{ name: "alpha", file: "src/elsewhere.ts", note: "" }] },
			module,
			evidence,
			oracle,
		);
		expect(result.unknownFiles).toContain("src/elsewhere.ts");
	});

	it("reports exported declarations the card never mentions", () => {
		const result = verifyCard(
			{ summary: "s", keyPoints: [], entryPoints: [{ name: "beta", file: "src/a.ts", note: "" }] },
			module,
			evidence,
			oracle,
		);
		expect(result.uncovered).toContain("alpha");
	});

	it("reports files the plan invented as unknown", () => {
		const result = verifyCard(
			{ summary: "s", keyPoints: [], entryPoints: [] },
			module,
			{ ...evidence, missing: ["ghost.ts"] },
			oracle,
		);
		expect(result.unknownFiles).toContain("ghost.ts");
	});

	it("does not credit a symbol that exists only outside this module", () => {
		const elsewhere = new SymbolOracle(indexOf([{ path: "src/other.ts", symbols: [{ name: "alpha" }] }]));
		const result = verifyCard(
			{ summary: "s", keyPoints: [], entryPoints: [{ name: "alpha", file: "src/a.ts", note: "" }] },
			module,
			evidence,
			elsewhere,
		);
		expect(result.ungrounded).toContain("alpha");
	});
});

describe("cards: generation", () => {
	const index = indexOf([{ path: "src/a.ts", symbols: [{ name: "alpha" }] }]);

	it("produces a card with grounded provenance hashes", async () => {
		const client = scriptedClient([draft("Does alpha.", [{ name: "alpha", file: "src/a.ts" }])]);
		const { card } = await generateCard(module, index, client, {
			knownFiles: new Map([["src/a.ts", "abc123"]]),
		});

		expect(card.moduleId).toBe("core");
		expect(card.summary).toBe("Does alpha.");
		expect(card.sources).toEqual([{ path: "src/a.ts", hash: "abc123" }]);
		expect(card.verification.grounded).toBe(1);
	});

	it("records provenance for the files bundled, not the files the model mentioned", async () => {
		const client = scriptedClient([draft("s", [])]);
		const { card } = await generateCard(module, index, client, {
			knownFiles: new Map([["src/a.ts", "h1"]]),
		});
		expect(card.sources.map((s) => s.path)).toEqual(["src/a.ts"]);
	});

	it("does not run a repair pass when the first draft is already grounded", async () => {
		const client = scriptedClient([draft("s", [{ name: "alpha", file: "src/a.ts" }])]);
		await generateCard(module, index, client, { multiplier: 10 });
		expect(client.requests).toHaveLength(1);
	});

	it("repairs an ungrounded draft at a high multiplier", async () => {
		const client = scriptedClient([
			draft("s", [{ name: "ghost", file: "src/a.ts" }]),
			draft("s", [{ name: "alpha", file: "src/a.ts" }]),
		]);
		const { card } = await generateCard(module, index, client, { multiplier: 10 });

		expect(client.requests.length).toBeGreaterThan(1);
		expect(card.verification.ungrounded).toEqual([]);
	});

	it("rejects a revision that made grounding worse", async () => {
		const client = scriptedClient([
			draft("s", [{ name: "alpha", file: "src/a.ts" }]),
			// Worse: two invented names. Must not be accepted.
			draft("s", [
				{ name: "ghost1", file: "src/a.ts" },
				{ name: "ghost2", file: "src/a.ts" },
			]),
		]);
		const { card } = await generateCard(module, index, client, { multiplier: 10 });
		expect(card.verification.ungrounded).toEqual([]);
	});

	it("keeps the better draft when a repair pass fails to parse", async () => {
		const client = scriptedClient([draft("s", [{ name: "ghost", file: "src/a.ts" }]), "not json at all"]);
		const { card } = await generateCard(module, index, client, { multiplier: 10 });
		expect(card.verification.ungrounded).toContain("ghost");
	});

	it("sends declarations, not source bodies", async () => {
		const client = scriptedClient([draft("s", [])]);
		await generateCard(module, index, client);
		expect(client.requests[0]?.prompt).toContain("alpha(): void");
	});

	it("includes the stated purpose in the prompt", async () => {
		const client = scriptedClient([draft("s", [])]);
		await generateCard(module, index, client);
		expect(client.requests[0]?.prompt).toContain("The core.");
	});
});

describe("cards: batch generation", () => {
	const index = indexOf([{ path: "src/a.ts", symbols: [{ name: "alpha" }] }]);
	const plan: ModulePlan = {
		version: 1,
		generatedAt: "",
		multiplier: 1,
		modules: [
			{ id: "core", name: "Core", purpose: "p", files: ["src/a.ts"] },
			{ id: "ghost", name: "Ghost", purpose: "p", files: [] },
		],
	};

	it("generates a card per module that owns files", async () => {
		const client = scriptedClient([draft("s", [])]);
		const results = await generateCards(plan, index, client);
		expect(results.map((r) => r.card.moduleId)).toEqual(["core"]);
	});

	it("honours an explicit module filter", async () => {
		const client = scriptedClient([draft("s", [])]);
		const results = await generateCards(plan, index, client, { only: ["nonexistent"] });
		expect(results).toHaveLength(0);
	});

	it("reports progress", async () => {
		const client = scriptedClient([draft("s", [])]);
		const seen: string[] = [];
		await generateCards(plan, index, client, { onProgress: (id) => seen.push(id) });
		expect(seen).toEqual(["core"]);
	});
});

describe("cards: prompt shape", () => {
	it("tells the model how many key points to write", () => {
		const prompt = buildCardPrompt(module, evidence, { multiplier: 1, keyPoints: 4 } as never);
		expect(prompt).toContain("Write 4 key points");
	});

	it("marks a file with no declarations explicitly", () => {
		const prompt = buildCardPrompt(
			module,
			{ ...evidence, files: [{ path: "README.md", language: "", lineCount: 0, declarations: [] }] },
			{ multiplier: 1, keyPoints: 3 } as never,
		);
		expect(prompt).toContain("(no declarations indexed)");
	});
});
