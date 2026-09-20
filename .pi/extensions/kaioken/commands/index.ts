import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Models, ThinkingLevel } from "@earendil-works/pi-ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildGraph } from "../../../../kaioken/graph/src/build.ts";
import { graphStats } from "../../../../kaioken/graph/src/render.ts";
import { readWikiTree, writeExportTree, writeGraph, type ExportManifest } from "../../../../kaioken/graph/src/artifact.ts";
import { createWorktree, ffMerge, slug, worktreePath } from "../../../../kaioken/gitops/src/worktree.ts";
import { buildIndex, readIndexArtifact, SymbolOracle, writeIndexArtifact } from "../../../../kaioken/index/src/index.ts";
import { checkDrift, gatherProvenance } from "../../../../kaioken/provenance/src/status.ts";
import { scan, writeScanArtifact } from "../../../../kaioken/scan/src/index.ts";
import { bm25Search } from "../../../../kaioken/search/src/search.ts";
import { serve, type RunningServer } from "../../../../kaioken/serve/src/server.ts";
import { loadSkills } from "../../../../kaioken/skills/src/index.ts";
import { runVerify } from "../../../../kaioken/verify/src/gate.ts";
import { PiAiClient } from "../../../../kaioken/modelport/src/piai.ts";
import type { ModelClient } from "../../../../kaioken/modelport/src/port.ts";
import {
	contextTokensFor,
	describeSpend,
	estimateSpend,
	estimateTokens,
	type SpendEstimate as TokenSpendEstimate,
} from "../../../../kaioken/modelport/src/spend.ts";
import { proposeModulePlan, validatePlan, writeModulePlan, type ModulePlan } from "../../../../kaioken/plan/src/index.ts";
import { generateCards, readCards, readModulePlan, writeCard } from "../../../../kaioken/plan/src/index.ts";
import {
	groundingDefects,
	planWiki,
	readBrief,
	readWikiPlan,
	runWiki,
	writeProvenance,
	writeVerification,
	writeWikiDocument,
	writeWikiIndex,
	writeWikiPlan,
} from "../../../../kaioken/wiki/src/index.ts";
import {
	depthFor,
	gatherSources,
	generateResearch,
	type WebFetchPort,
	type WebSearchPort,
	writeResearchDocument,
} from "../../../../kaioken/research/src/index.ts";
import { proposeSkills, writeSkill } from "../../../../kaioken/skillgen/src/index.ts";

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

/**
 * Spend gate backed by the active model's own cost registry.
 *
 * Prices are read from `ctx.model.cost` rather than hardcoded, so a price
 * change is a config change and the estimate cannot silently drift (Invariant 9).
 * When no model is resolvable the gate still estimates tokens but reports cost
 * as unknown rather than inventing a figure.
 */
export class DefaultSpendGate implements SpendGate {
	estimate(action: string, multiplier: number, contextSize?: number): SpendEstimate {
		const tokens = estimateTokens(multiplier, contextSize ?? contextTokensFor(action));
		// Cost is filled in by `confirm`, which is the only place a model is reachable.
		return {
			action,
			multiplier,
			estimatedInputTokens: tokens.input,
			estimatedOutputTokens: tokens.output,
			estimatedCostUsd: 0,
		};
	}

	async confirm(ctx: ExtensionContext, action: string, multiplier: number): Promise<boolean> {
		const tokens = estimateTokens(multiplier, contextTokensFor(action));
		const model = ctx.model;
		const spend: TokenSpendEstimate = estimateSpend(model?.cost, tokens);
		const label = model ? `${model.provider}/${model.id}` : "no active model";
		const promptText = describeSpend(action, multiplier, spend, label);

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

/**
 * Build the model client for the active session.
 *
 * Returns null when no model is bound, so every generative stage can fall back
 * to a deterministic path instead of failing: an offline user still gets a
 * usable plan, just a mechanical one.
 */
export function clientFor(ctx: ExtensionContext): ModelClient | null {
	const model = ctx.model;
	if (!model) return null;
	// The bridge owns the transport; the core only ever sees the port.
	const models = (ctx as unknown as { models?: Models }).models;
	if (!models) return null;
	// `ctx.thinkingLevel` is typed by the agent package, which spells the level
	// union slightly differently from pi-ai ("off" is a model-level concept).
	// They are the same values at runtime, so this narrows rather than casts.
	const reasoning = ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ctx.thinkingLevel : undefined;
	return new PiAiClient(models, {
		provider: String(model.provider),
		model: model.id,
		...(reasoning ? { reasoning: reasoning as ThinkingLevel } : {}),
	});
}

/** The deterministic plan, used when no model is reachable. */
async function mechanicalPlan(root: string, multiplier: number): Promise<ModulePlan> {
	const scanResult = await scan(root);

	const groups = new Map<string, string[]>();
	for (const file of scanResult.files) {
		const parts = file.path.split(/[\\/]/);
		const top = parts.length > 1 ? parts[0] : "root";
		const list = groups.get(top as string);
		if (list) list.push(file.path);
		else groups.set(top as string, [file.path]);
	}

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		multiplier,
		modules: [...groups.entries()].map(([id, files]) => ({
			id: id as string,
			name: `${(id as string).toUpperCase()} Module`,
			purpose: "Grouped by top-level directory (no model available).",
			files: (files as string[]).sort(),
		})),
	};
}

export interface PlanRun {
	moduleTree: string[];
	/** Path the checkpoint was written to. */
	planPath: string;
	/** True when the model proposed the plan, false for the mechanical fallback. */
	generated: boolean;
	defects: string[];
}

/**
 * Propose a module plan and stop at the checkpoint.
 *
 * The stop is the point: `plan` is the cheap moment to correct a decomposition,
 * so it writes an editable YAML file and returns without generating anything
 * downstream. Every later stage reads that file back.
 */
export async function runPlan(
	root: string,
	multiplier: number,
	client?: ModelClient | null,
): Promise<PlanRun> {
	const scanResult = await scan(root);
	const index = await readIndexArtifact(root).catch(() => null);

	let plan: ModulePlan;
	let generated = false;
	const defects: string[] = [];

	if (client) {
		const result = await proposeModulePlan(scanResult, index, client, { multiplier });
		plan = result.plan;
		generated = true;
		for (const defect of result.validation.defects) {
			defects.push(`[${defect.severity}] ${defect.message}`);
		}
	} else {
		plan = await mechanicalPlan(root, multiplier);
		const validation = validatePlan(plan, scanResult);
		for (const defect of validation.defects) {
			defects.push(`[${defect.severity}] ${defect.message}`);
		}
	}

	const planPath = await writeModulePlan(root, plan);

	const outline = [
		`module plan (${generated ? "model" : "mechanical"}) — ${plan.modules.length} module(s):`,
		...plan.modules.map((m) => `  - ${m.id} (${m.files.length} file${m.files.length === 1 ? "" : "s"})`),
		"",
		`Checkpoint written: ${planPath}`,
		"Edit it, then run /kaio-cards to continue.",
	];

	return { moduleTree: outline, planPath, generated, defects };
}

/**
 * Web access, as two ports the bridge owns.
 *
 * The research core never opens a socket; it is handed these. That keeps the
 * pipeline offline-testable and means an unconfigured environment fails with a
 * sentence rather than a stack trace.
 */
export interface WebPorts {
	search: WebSearchPort;
	fetch: WebFetchPort;
}

export const NO_WEB_PORTS: WebPorts = {
	search: {
		async search() {
			throw new Error("no web search provider configured");
		},
	},
	fetch: {
		async fetch() {
			throw new Error("no web fetch provider configured");
		},
	},
};

export function registerCommands(
	pi: ExtensionAPI,
	root?: () => string,
	spendGate: SpendGate = new DefaultSpendGate(),
	web: WebPorts = NO_WEB_PORTS,
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

	// 1. /kaio-scan
	off("kaio-scan", "Deterministic repo inventory + risk flags", async (_a, r) => {
		const scanResult = await scan(r);
		await writeScanArtifact(r, scanResult);
		// `risk` is a list of risk classes per file, not a graded object. Reading
		// it as `risk.level` silently produced "0 high risk flags" on every
		// repository, including ones full of private keys.
		const risky = scanResult.files.filter((f) => f.risk.length > 0);
		const byClass = new Map<string, number>();
		for (const file of risky) {
			for (const risk of file.risk) byClass.set(risk, (byClass.get(risk) ?? 0) + 1);
		}
		const breakdown = [...byClass.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([risk, n]) => `${n} ${risk}`)
			.join(", ");
		const indexResult = await buildIndex(scanResult);
		await writeIndexArtifact(r, indexResult.index);
		return `Scan complete: ${scanResult.fileCount} files (${Math.round(scanResult.totalBytes / 1024)} KB), ${indexResult.index.symbolCount} symbols indexed.${breakdown ? ` Risk flags: ${breakdown}.` : " No risk flags."}`;
	});

	// 2. /kaio-symbols
	off("kaio-symbols", "Lookup symbol declaration in AST oracle", async (args, r) => {
		if (!args.trim()) return "Usage: /kaio-symbols <symbolName>";
		const index = await readIndexArtifact(r);
		const oracle = new SymbolOracle(index ?? { root: r, builtAt: "", fileCount: 0, symbolCount: 0, unparsedLanguages: {}, files: [] });
		const hits = oracle.lookup(args.trim());
		return hits.length
			? JSON.stringify(hits, null, 2)
			: `NEGATIVE GUARANTEE: no symbol matching "${args.trim()}" is declared.`;
	});

	// 3. /kaio-search
	off("kaio-search", "BM25+RRF lexical and structural search", async (args, r) => {
		if (!args.trim()) return "Usage: /kaio-search <query>";
		return await bm25Search(r, args.trim(), 8);
	});

	// 4. /kaio-status
	pi.registerCommand("kaio-status", {
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

	// 5. /kaio-verify
	pi.registerCommand("kaio-verify", {
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

	// 6. /kaio-graph
	off("kaio-graph", "Build and inspect knowledge dependency graph", async (_a, r) => {
		const records = await gatherProvenance(r);
		const graph = buildGraph({ provenance: records });
		await writeGraph(r, graph);
		const stats = graphStats(graph);
		return `Knowledge Graph: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.coveredFiles} covered files. Saved to .kaioken/graph.json.`;
	});

	// 7. /kaio-serve
	pi.registerCommand("kaio-serve", {
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

	// 8. /kaio-export
	off("kaio-export", "Export static standalone documentation bundle", async (_a, r) => {
		const wikiFiles = await readWikiTree(join(r, ".kaioken", "wiki")).catch(() => []);
		const cards = await readCards(r).catch(() => []);
		const skills = await loadSkills(r).catch(() => ({ skills: [], problems: [] }));
		// The manifest records what the bundle contains, by count and by origin.
		// `files` was never a field of ExportManifest, so the written manifest
		// lacked the counts a consumer needs to know what it is looking at.
		const manifest: ExportManifest = {
			version: 1,
			generatedAt: new Date().toISOString(),
			repository: r,
			counts: {
				cards: cards.length,
				wikiDocuments: wikiFiles.length,
				skills: skills.skills.length,
			},
		};
		const bundleDir = join(r, ".kaioken", "export");
		const written = await writeExportTree(bundleDir, wikiFiles, manifest);
		return `Exported ${written.length} asset(s) to .kaioken/export/ (${manifest.counts.wikiDocuments} wiki document(s), ${manifest.counts.cards} card(s), ${manifest.counts.skills} skill(s)).`;
	});

	// 9. /kaio-delegate
	pi.registerCommand("kaio-delegate", {
		description: "Isolate task in a git worktree",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const taskSlug = slug(args || "task");
			try {
				const wt = await createWorktree(r, taskSlug);
				// The model is named from the session rather than hard-coded.
				// The old text told the user to run `--model
				// antigravity/gemini-3.8-flash-high`, a provider that is not
				// configured here — so following the instruction failed.
				const model = ctx.model ? `--model ${ctx.model.provider}/${ctx.model.id}` : "";
				ctx.ui?.notify?.(
					`worktree: ${wt}\nrun: cd ${wt} && pi ${model}\nmerge: /kaio-merge ${taskSlug}`.replace(/ +$/m, ""),
					"info",
				);
			} catch (e: any) {
				ctx.ui?.notify?.(`Failed to delegate worktree: ${e.message}`, "error");
			}
		},
	});

	// 10. /kaio-merge
	pi.registerCommand("kaio-merge", {
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

	// 11. /kaio-plan <×N>
	pi.registerCommand("kaio-plan", {
		description: "Propose modules.yaml (checkpoint, then stop)",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "plan", m))) return;

			const out = await runPlan(r, m, clientFor(ctx));
			const note = out.generated
				? "modules.yaml written by the model"
				: "modules.yaml written mechanically (no model bound)";
			ctx.ui?.notify?.(`${note} — REVIEW, then /kaio-cards ${args || `×${m}`}`, "info");
			ctx.ui?.setWidget?.("kaioken", out.moduleTree.slice(0, 12));
		},
	});

	// 12. /kaio-cards <×N>
	pi.registerCommand("kaio-cards", {
		description: "Generate knowledge cards from modules.yaml",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "cards", m))) return;

			const plan = await readModulePlan(r);
			if (!plan) {
				ctx.ui?.notify?.("No module plan found. Run /kaio-plan first.", "info");
				return;
			}

			const client = clientFor(ctx);
			if (!client) {
				ctx.ui?.notify?.("No model bound; cards need one. Configure a model, then retry.", "info");
				return;
			}

			const scanResult = await scan(r);
			const index = await readIndexArtifact(r).catch(() => null);
			const knownFiles = new Map(scanResult.files.map((f) => [f.path, f.hash]));

			const results = await generateCards(plan, index, client, {
				multiplier: m,
				knownFiles,
				onProgress: (id, done, total) => ctx.ui?.setStatus?.("kaioken", `cards ${done + 1}/${total}: ${id}`),
			});

			for (const result of results) await writeCard(r, result.card);

			const ungrounded = results.reduce((n, x) => n + x.card.verification.ungrounded.length, 0);
			ctx.ui?.setStatus?.("kaioken", "grounded");
			ctx.ui?.notify?.(
				`Wrote ${results.length} card(s) to .kaioken/cards. ${ungrounded} ungrounded claim(s) reported in each card's verification.`,
				"info",
			);
			ctx.ui?.setWidget?.(
				"kaioken",
				results.slice(0, 12).map((x) => `card ${x.card.moduleId}: ${x.card.verification.grounded} grounded`),
			);
		},
	});

	// 13. /kaio-wiki [--plan] <×N>
	pi.registerCommand("kaio-wiki", {
		description: "Cascade wiki chapters generation",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "wiki", m))) return;

			const client = clientFor(ctx);
			if (!client) {
				ctx.ui?.notify?.("No model bound; the wiki cascade needs one.", "info");
				return;
			}

			const scanResult = await scan(r);
			const index = await readIndexArtifact(r).catch(() => null);

			// `--plan` is the checkpoint: outline only, then stop.
			if (/--plan/.test(args)) {
				const { plan } = await planWiki({ scan: scanResult, index, client, multiplier: m });
				const path = await writeWikiPlan(r, plan);
				ctx.ui?.notify?.(`Wrote ${plan.chapters.length} chapter(s) to ${path} — edit, then rerun without --plan.`, "info");
				ctx.ui?.setWidget?.("kaioken", plan.chapters.slice(0, 12).map((c) => `chapter ${c.id}: ${c.title}`));
				return;
			}

			const plan = await readWikiPlan(r);
			if (!plan) {
				ctx.ui?.notify?.("No wiki plan found. Run /kaio-wiki --plan first.", "info");
				return;
			}

			const brief = (await readBrief(r)) ?? undefined;
			const out = await runWiki({
				root: r,
				plan,
				scan: scanResult,
				index,
				client,
				multiplier: m,
				...(brief ? { brief } : {}),
				onDocument: async (doc) => {
					await writeWikiDocument(r, doc);
				},
				onProgress: (label, done, total) => ctx.ui?.setStatus?.("kaioken", `wiki ${done}/${total}: ${label}`),
			});

			// Persist the resolved sections so a rerun reuses the same ids.
			await writeWikiPlan(r, out.plan);
			await writeProvenance(
				r,
				out.documents.map((d) => d.provenance),
			);
			await writeWikiIndex(r, out.plan);

			// Record what the verifier concluded, so a reader can check the
			// grounding claim rather than take it on trust. Until this existed
			// the defects were computed, printed once, and dropped — leaving
			// the serve site with nothing to badge.
			await writeVerification(r, {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "offline",
				multiplier: m,
				documents: out.documents.map((d) => ({
					document: d.path,
					grounded: d.verification.grounded,
					uncovered: d.verification.uncovered,
					coverage: d.verification.coverage,
					defects: d.verification.defects,
				})),
			});

			const defects = out.documents.reduce((n, d) => n + groundingDefects(d.verification.defects).length, 0);
			ctx.ui?.setStatus?.("kaioken", "grounded");
			ctx.ui?.notify?.(
				`Wrote ${out.documents.length} document(s); ${defects} ungrounded claim(s) reported${out.failures.length ? `, ${out.failures.length} failure(s)` : ""}.`,
				"info",
			);
		},
	});

	// 14. /kaio-update [--dry] <×N>
	pi.registerCommand("kaio-update", {
		description: "Update stale documents from provenance diff",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "update", m))) return;

			const drift = await checkDrift(r);
			const stale = drift.documents.filter((d) => d.freshness !== "current");

			if (stale.length === 0) {
				ctx.ui?.notify?.("Nothing is stale. No spend, no regeneration.", "info");
				return;
			}

			if (/--dry/.test(args)) {
				ctx.ui?.notify?.(
					`${stale.length} stale document(s): ${stale.slice(0, 8).map((d) => d.document).join(", ")}`,
					"info",
				);
				return;
			}

			const client = clientFor(ctx);
			if (!client) {
				ctx.ui?.notify?.("No model bound; updating needs one.", "info");
				return;
			}

			// Regenerate only the stale documents, by path, reusing the plan.
			const plan = await readWikiPlan(r);
			if (!plan) {
				ctx.ui?.notify?.("No wiki plan found; nothing to update.", "info");
				return;
			}

			const scanResult = await scan(r);
			const index = await readIndexArtifact(r).catch(() => null);
			const brief = (await readBrief(r)) ?? undefined;

			const out = await runWiki({
				root: r,
				plan,
				scan: scanResult,
				index,
				client,
				multiplier: m,
				onlyDocuments: stale.map((d) => d.document),
				...(brief ? { brief } : {}),
				onDocument: async (doc) => {
					await writeWikiDocument(r, doc);
				},
			});

			await writeProvenance(
				r,
				out.documents.map((d) => d.provenance),
			);
			ctx.ui?.notify?.(`Regenerated ${out.documents.length} of ${stale.length} stale document(s).`, "info");
		},
	});

	// 15. /kaio-research <topic> <×N>
	pi.registerCommand("kaio-research", {
		description: "Grounded deep research report on topic",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const m = parseMult(args);
			const topic = args.replace(/--?\w+/g, "").replace(/[×x]\d+/i, "").trim();

			if (!topic) {
				ctx.ui?.notify?.("Usage: /kaio-research <topic> <×N>", "info");
				return;
			}

			if (!(await spendGate.confirm(ctx, "research", m))) return;

			const client = clientFor(ctx);
			if (!client) {
				ctx.ui?.notify?.("No model bound; research needs one.", "info");
				return;
			}

			// The network is injected here and nowhere else, so the research core
			// itself stays transport-free and offline-testable (Invariant 10).
			const depth = depthFor(m);
			const gathered = await gatherSources({
				question: topic,
				depth,
				search: web.search,
				fetch: web.fetch,
			});

			const fetched = gathered.sources.filter((s) => s.fetched).length;
			if (fetched === 0) {
				ctx.ui?.notify?.(
					`No page could be fetched for "${topic}". Nothing to research, and writing without sources would be fiction.`,
					"info",
				);
				return;
			}

			const { document } = await generateResearch({ question: topic, gathered, depth, client });
			const path = await writeResearchDocument(r, document);

			ctx.ui?.notify?.(
				`${document.verification.grounded}/${document.verification.cited} citation(s) grounded, ` +
					`${document.verification.defects.length} defect(s). Written to ${path}.`,
				"info",
			);
		},
	});

	// 16. /kaio-skills <×N>
	pi.registerCommand("kaio-skills", {
		description: "Propose and write task procedures into .kaioken/skills",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const m = parseMult(args);
			if (!(await spendGate.confirm(ctx, "skillgen", m))) return;

			const client = clientFor(ctx);
			if (!client) {
				ctx.ui?.notify?.("No model bound; skill generation needs one.", "info");
				return;
			}

			const scanResult = await scan(r);
			const index = await readIndexArtifact(r).catch(() => null);
			const plan = await readWikiPlan(r);

			const proposals = await proposeSkills({
				scan: scanResult,
				index,
				client,
				...(plan ? { chapters: plan.chapters.map((c) => c.title) } : {}),
			});

			if (proposals.length === 0) {
				ctx.ui?.notify?.("The model proposed no skills for this repository.", "info");
				return;
			}

			const written: string[] = [];
			let ungrounded = 0;
			for (const proposal of proposals) {
				try {
					const result = await writeSkill({ root: r, proposal, scan: scanResult, index, client });
					written.push(result.name);
					ungrounded += result.ungrounded.length;
				} catch (error) {
					ctx.ui?.notify?.(`Skipped ${proposal.name}: ${(error as Error).message}`, "info");
				}
			}

			ctx.ui?.notify?.(
				`Wrote ${written.length} skill(s): ${written.join(", ")}.` +
					(ungrounded ? ` ${ungrounded} ungrounded path(s) reported.` : ""),
				"info",
			);
		},
	});
}
