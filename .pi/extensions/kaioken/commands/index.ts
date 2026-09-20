import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildGraph } from "../../../../kaioken/graph/src/build.ts";
import { graphStats } from "../../../../kaioken/graph/src/render.ts";
import { readWikiTree, writeExportTree, writeGraph } from "../../../../kaioken/graph/src/artifact.ts";
import { createWorktree, ffMerge, slug, worktreePath } from "../../../../kaioken/gitops/src/worktree.ts";
import { buildIndex, readIndexArtifact, SymbolOracle, writeIndexArtifact } from "../../../../kaioken/index/src/index.ts";
import { checkDrift, gatherProvenance } from "../../../../kaioken/provenance/src/status.ts";
import { scan, writeScanArtifact } from "../../../../kaioken/scan/src/index.ts";
import { bm25Search } from "../../../../kaioken/search/src/search.ts";
import { serve, type RunningServer } from "../../../../kaioken/serve/src/server.ts";
import { runVerify } from "../../../../kaioken/verify/src/gate.ts";

export interface SpendEstimate {
	action: string;
	multiplier: number;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	estimatedCostUsd: number;
}

export interface SpendGate {
	estimate(action: string, multiplier: number, contextSize?: number): SpendEstimate;
	confirm(ctx: ExtensionContext, action: string, multiplier: number): Promise<boolean>;
}

export function parseMult(args?: string): number {
	if (!args) return 3;
	const m = args.match(/(?:×|x)?(\d+)/i);
	if (!m) return 3;
	const n = parseInt(m[1], 10);
	return Math.max(1, Math.min(10, n));
}

export class DefaultSpendGate implements SpendGate {
	estimate(action: string, multiplier: number, contextSize = 25_000): SpendEstimate {
		const baseInput = contextSize * (multiplier / 3);
		const baseOutput = 4_000 * (multiplier / 3);
		// Gemini 3.8 Flash (high) pricing: $0.15/1M in, $0.60/1M out
		const cost = (baseInput / 1_000_000) * 0.15 + (baseOutput / 1_000_000) * 0.60;
		return {
			action,
			multiplier,
			estimatedInputTokens: Math.round(baseInput),
			estimatedOutputTokens: Math.round(baseOutput),
			estimatedCostUsd: Math.round(cost * 10_000) / 10_000,
		};
	}

	async confirm(ctx: ExtensionContext, action: string, multiplier: number): Promise<boolean> {
		const est = this.estimate(action, multiplier);
		const promptText =
			`Kaioken Spend Confirmation: /kaioken-${action} (×${multiplier})\n` +
			`Est tokens: ~${est.estimatedInputTokens.toLocaleString()} in / ~${est.estimatedOutputTokens.toLocaleString()} out\n` +
			`Est cost: ~$${est.estimatedCostUsd.toFixed(4)} USD (Gemini 3.8 Flash high)\n` +
			`Proceed?`;

		if (ctx.hasUI && ctx.ui?.confirm) {
			const ok = await ctx.ui.confirm("Spend Confirmation", promptText);
			if (!ok) {
				ctx.ui.notify?.("Cancelled spend.", "info");
				return false;
			}
			return true;
		}
		return true;
	}
}

function resolveRoot(rootFn?: () => string, ctx?: ExtensionContext): string {
	if (ctx?.cwd) return ctx.cwd;
	if (rootFn) return rootFn();
	return process.cwd();
}

let activeServer: RunningServer | null = null;

export async function runPlan(root: string, multiplier: number): Promise<{ moduleTree: string[] }> {
	const scanResult = await scan(root);
	const modulesDir = join(root, ".kaioken");
	await mkdir(modulesDir, { recursive: true });

	// Group files by top-level directory
	const groups: Record<string, string[]> = {};
	for (const file of scanResult.files) {
		const parts = file.path.split(/[\\/]/);
		const top = parts[0] || "root";
		(groups[top] ??= []).push(file.path);
	}

	const moduleEntries = Object.entries(groups).map(([id, files]) => ({
		id,
		title: `${id.toUpperCase()} Module`,
		files: files.slice(0, 50),
	}));

	const modulesYaml = [
		"# kaioken modules.yaml checkpoint",
		`version: 1`,
		`multiplier: ${multiplier}`,
		`generatedAt: "${new Date().toISOString()}"`,
		`modules:`,
		...moduleEntries.flatMap((m) => [
			`  - id: ${m.id}`,
			`    title: "${m.title}"`,
			`    files:`,
			...m.files.map((f) => `      - ${f}`),
		]),
	].join("\n");

	await writeFile(join(modulesDir, "modules.yaml"), modulesYaml, "utf8");

	const outline = [
		"modules.yaml outline:",
		...moduleEntries.map((m) => `  - ${m.id} (${m.files.length} file${m.files.length === 1 ? "" : "s"})`),
	];

	return { moduleTree: outline };
}

export function registerCommands(
	pi: ExtensionAPI,
	root?: () => string,
	spendGate: SpendGate = new DefaultSpendGate(),
) {
	const off = (name: string, desc: string, fn: (args: string, r: string) => Promise<string>) =>
		pi.registerCommand(name, {
			description: desc,
			handler: async (args, ctx) => {
				const r = resolveRoot(root, ctx);
				const out = await fn(args || "", r);
				ctx.ui?.notify?.(out, "info");
			},
		});

	// 1. /kaioken-scan
	off("kaioken-scan", "Deterministic repo inventory + risk flags", async (_a, r) => {
		const scanResult = await scan(r);
		await writeScanArtifact(r, scanResult);
		const highRiskCount = scanResult.files.filter((f) => f.risk.level === "high").length;
		const indexResult = await buildIndex(scanResult);
		await writeIndexArtifact(r, indexResult.index);
		return `Scan complete: ${scanResult.fileCount} files (${Math.round(scanResult.totalBytes / 1024)} KB), ${highRiskCount} high risk flags, ${indexResult.index.symbolCount} symbols indexed.`;
	});

	// 2. /kaioken-symbols
	off("kaioken-symbols", "Lookup symbol declaration in AST oracle", async (args, r) => {
		if (!args.trim()) return "Usage: /kaioken-symbols <symbolName>";
		const index = await readIndexArtifact(r);
		const oracle = new SymbolOracle(index ?? { root: r, builtAt: "", fileCount: 0, symbolCount: 0, unparsedLanguages: {}, files: [] });
		const hits = oracle.lookup(args.trim());
		return hits.length
			? JSON.stringify(hits, null, 2)
			: `NEGATIVE GUARANTEE: no symbol matching "${args.trim()}" is declared.`;
	});

	// 3. /kaioken-search
	off("kaioken-search", "BM25+RRF lexical and structural search", async (args, r) => {
		if (!args.trim()) return "Usage: /kaioken-search <query>";
		return await bm25Search(r, args.trim(), 8);
	});

	// 4. /kaioken-status
	pi.registerCommand("kaioken-status", {
		description: "0-token staleness drift report",
		handler: async (_args, ctx) => {
			const r = resolveRoot(root, ctx);
			const report = await checkDrift(r);
			const summary = `DRIFT REPORT: freshness ${Math.round(report.freshness * 100)}%, ${report.stale.length} stale doc(s), ${report.undocumentedFiles.length} undocumented file(s)`;
			ctx.ui?.notify?.(summary, "info");
			if (report.stale.length > 0) {
				ctx.ui?.setStatus?.("kaioken", `${report.stale.length} stale docs`);
				ctx.ui?.setWidget?.("kaioken", [
					"Kaioken Drift:",
					...report.stale.slice(0, 10).map((d) => `  - ${d.document} (${d.changed.length} changed)`),
				]);
			}
		},
	});

	// 5. /kaioken-verify
	pi.registerCommand("kaioken-verify", {
		description: "Run native build+test gate",
		handler: async (_args, ctx) => {
			const r = resolveRoot(root, ctx);
			const outcome = await runVerify(r);
			if (outcome.pass) {
				ctx.ui?.setStatus?.("kaioken", "verified ✓");
				ctx.ui?.notify?.("VERIFY: PASS (0 errors)", "info");
			} else {
				ctx.ui?.setStatus?.("kaioken", "UNVERIFIED CHANGES");
				ctx.ui?.notify?.(`VERIFY: FAIL\n${outcome.summary}`, "error");
				ctx.ui?.setWidget?.("kaioken", [
					"Verify Failure:",
					...outcome.summary.split("\n").slice(-10),
				]);
			}
		},
	});

	// 6. /kaioken-graph
	off("kaioken-graph", "Build and inspect knowledge dependency graph", async (_a, r) => {
		const records = await gatherProvenance(r);
		const graph = buildGraph({ provenance: records });
		await writeGraph(r, graph);
		const stats = graphStats(graph);
		return `Knowledge Graph: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.coveredFiles} covered files. Saved to .kaioken/graph.json.`;
	});

	// 7. /kaioken-serve
	pi.registerCommand("kaioken-serve", {
		description: "Start offline documentation preview server",
		handler: async (_args, ctx) => {
			const r = resolveRoot(root, ctx);
			if (activeServer) {
				return ctx.ui?.notify?.(`Offline server already active at http://localhost:${activeServer.port}`, "info");
			}
			try {
				activeServer = await serve({ root: r, port: 4173 });
				ctx.ui?.notify?.(`Offline preview server active at http://localhost:${activeServer.port}`, "info");
			} catch (e: any) {
				ctx.ui?.notify?.(`Failed to start preview server: ${e.message}`, "error");
			}
		},
	});

	// 8. /kaioken-export
	off("kaioken-export", "Export static standalone documentation bundle", async (_a, r) => {
		const wikiFiles = await readWikiTree(join(r, ".kaioken", "wiki")).catch(() => []);
		const manifest = {
			version: 1 as const,
			exportedAt: new Date().toISOString(),
			files: wikiFiles.map((f) => f.path),
		};
		const bundleDir = join(r, ".kaioken", "export");
		const written = await writeExportTree(bundleDir, wikiFiles, manifest);
		return `Exported ${written.length} standalone assets to .kaioken/export/`;
	});

	// 9. /kaioken-delegate
	pi.registerCommand("kaioken-delegate", {
		description: "Isolate task in a git worktree",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const taskSlug = slug(args || "task");
			try {
				const wt = await createWorktree(r, taskSlug);
				ctx.ui?.notify?.(
					`worktree: ${wt}\nrun: cd ${wt} && pi --model antigravity/gemini-3.8-flash-high\nmerge: /kaioken-merge ${taskSlug}`,
					"info",
				);
			} catch (e: any) {
				ctx.ui?.notify?.(`Failed to delegate worktree: ${e.message}`, "error");
			}
		},
	});

	// 10. /kaioken-merge
	pi.registerCommand("kaioken-merge", {
		description: "Verify worktree then ff-merge",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const taskSlug = slug(args || "task");
			const wt = worktreePath(r, taskSlug);
			const verification = await runVerify(wt);
			if (!verification.pass) {
				return ctx.ui?.notify?.(`VERIFY FAIL in ${wt} — not merging\n${verification.summary}`, "error");
			}
			const res = await ffMerge(r, taskSlug);
			if (!res.success) {
				return ctx.ui?.notify?.(`Merge failed: ${res.message}`, "error");
			}
			ctx.ui?.notify?.(`merged ${taskSlug} ✓`, "info");
		},
	});

	// 11. /kaioken-plan <×N>
	pi.registerCommand("kaioken-plan", {
		description: "Propose modules.yaml (checkpoint, then stop)",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "plan", m))) return;

			const out = await runPlan(r, m);
			ctx.ui?.notify?.(`modules.yaml written — REVIEW, then /kaioken-cards ${args || `×${m}`}`, "info");
			ctx.ui?.setWidget?.("kaioken", out.moduleTree.slice(0, 12));
		},
	});

	// 12. /kaioken-cards <×N>
	pi.registerCommand("kaioken-cards", {
		description: "Generate knowledge cards from modules.yaml",
		handler: async (args, ctx) => {
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "cards", m))) return;
			ctx.ui?.notify?.(`Cards generation confirmed (×${m}). Ready for pipeline execution.`, "info");
		},
	});

	// 13. /kaioken-wiki [--plan] <×N>
	pi.registerCommand("kaioken-wiki", {
		description: "Cascade wiki chapters generation",
		handler: async (args, ctx) => {
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "wiki", m))) return;
			ctx.ui?.notify?.(`Wiki generation confirmed (×${m}). Ready for cascade execution.`, "info");
		},
	});

	// 14. /kaioken-update [--dry] <×N>
	pi.registerCommand("kaioken-update", {
		description: "Update stale documents from provenance diff",
		handler: async (args, ctx) => {
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "update", m))) return;
			ctx.ui?.notify?.(`Incremental update confirmed (×${m}). Ready for update execution.`, "info");
		},
	});

	// 15. /kaioken-research <topic> <×N>
	pi.registerCommand("kaioken-research", {
		description: "Grounded deep research report on topic",
		handler: async (args, ctx) => {
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "research", m))) return;
			ctx.ui?.notify?.(`Research dossier generation confirmed (×${m}).`, "info");
		},
	});
}
