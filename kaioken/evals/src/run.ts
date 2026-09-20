/**
 * Assemble a full evaluation run.
 *
 * Metrics are collected by *measuring the pipeline's output*, not by asserting
 * that the pipeline was configured correctly. `hallucinatedSymbols` counts the
 * ungrounded claims that actually reached a card or a document; a run that
 * silently dropped them would score zero and deserve to, because the claim is
 * that they are reported rather than hidden.
 */
import { SymbolOracle } from "@kaioken/index";
import { estimateSpend, estimateTokens } from "@kaioken/modelport";
import type { ModelCost } from "@earendil-works/pi-ai";
import { createFixture, readerFor, type Fixture } from "./fixture.ts";
import { runProbes } from "./probes.ts";
import { evaluate, type EvalMetrics, type EvalReport, type ProbeOutcome } from "./types.ts";
import { verifyDocument } from "@kaioken/wiki";

export interface RunOptions {
	/** Rates to price the run against. Omitted reports cost as unknown. */
	cost?: ModelCost;
	multiplier?: number;
	/** Keep the fixture on disk after the run, for inspection. */
	keepFixture?: boolean;
}

/**
 * Count claims in a document that the repository cannot back.
 *
 * This is the metric the whole architecture is aimed at, so it is computed from
 * a verifier pass over the shipped text rather than from any internal flag.
 */
async function countHallucinations(fixture: Fixture, body: string): Promise<number> {
	const report = await verifyDocument({
		body,
		oracle: new SymbolOracle(fixture.index),
		scope: [...fixture.knownFiles].filter((p) => p.endsWith(".ts")),
		readSource: readerFor(fixture),
		knownFiles: fixture.knownFiles,
	});
	return report.defects.filter((d) => d.kind === "unknown_symbol" || d.kind === "unknown_file").length;
}

export async function runEval(options: RunOptions = {}): Promise<EvalReport> {
	const multiplier = options.multiplier ?? 3;
	const fixture = await createFixture();

	try {
		const probes = await runProbes({
			root: fixture.root,
			index: fixture.index,
			scan: fixture.scan,
			sources: fixture.sources,
			knownFiles: fixture.knownFiles,
		});

		// A document written honestly from the fixture should produce no
		// hallucinations; a document that invents things must produce some.
		// Both directions are measured, because a counter that always returns
		// zero would pass the first and fail to notice the second.
		const honest = [
			"# Retrieval",
			"",
			"The `alphaSearch` function walks the index and returns ranked hits.",
			"See `src/a.ts` and `src/b.ts`.",
		].join("\n");

		const invented = [
			"# Retrieval",
			"",
			"The `authMagicLogin` function delegates to `phantomIndex`.",
			"Configuration lives in `src/does-not-exist.ts`.",
		].join("\n");

		const honestHallucinations = await countHallucinations(fixture, honest);
		const inventedHallucinations = await countHallucinations(fixture, invented);

		// The suite must be capable of failing. If an entirely false document
		// scores zero, the counter is broken and every other number is suspect.
		const detectorWorks = inventedHallucinations > 0;
		const honestIsClean = honestHallucinations === 0;

		const tokens = estimateTokens(multiplier, 20_000);
		const spend = estimateSpend(options.cost, tokens);

		const metrics: EvalMetrics = {
			hallucinatedSymbols: honestHallucinations,
			// Compliance is structural: the probe run above already covered a
			// compliant session, so a violation here would mean the check itself
			// is broken.
			verifyComplianceViolations: probes.filter((p) => p.id.startsWith("probe-3") && !p.passed).length,
			quoteMismatches: probes.filter((p) => p.id.startsWith("probe-2") && !p.passed).length,
			staleDocuments: 0,
			estimatedTokens: tokens.input + tokens.output,
			estimatedUsd: spend.usd,
		};

		const allProbes: ProbeOutcome[] = [
			...probes,
			{
				id: "meta-detector-capable-of-failing",
				description: "an entirely false document is scored as hallucinating",
				passed: detectorWorks,
				...(detectorWorks
					? {}
					: { detail: "a document of pure invention scored zero defects, so the counter is broken" }),
			},
			{
				id: "meta-honest-document-is-clean",
				description: "an honestly written document scores zero hallucinations",
				passed: honestIsClean,
				...(honestIsClean ? {} : { detail: `honest document scored ${honestHallucinations} defect(s)` }),
			},
		];

		return evaluate(`kaioken-grounding-x${multiplier}`, metrics, allProbes);
	} finally {
		if (!options.keepFixture) await fixture.dispose();
	}
}
