/**
 * The hallucination probe suite, as executable checks.
 *
 * Each probe drives a real Kaioken stage with a scripted model and then asks a
 * question about the *result* rather than the prompt. That distinction is the
 * point: a suite that asserted "the prompt contains the word grounding" would
 * pass while the model invented symbols, which is exactly the failure it is
 * meant to catch.
 */
import { SymbolOracle, resolveExcerpt, type IndexResult } from "@kaioken/index";
import { predictImpact } from "@kaioken/impact";
import type { ModelClient, ModelRequest } from "@kaioken/modelport";
import { generateCard } from "@kaioken/plan";
import type { ScanResult } from "@kaioken/scan";
import { verifyDocument } from "@kaioken/wiki";
import type { ProbeOutcome } from "./types.ts";

/** A model double that replies from a script, recording what it was asked. */
export function scriptedClient(replies: string[]): ModelClient & { requests: ModelRequest[] } {
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

export interface ProbeFixture {
	root: string;
	index: IndexResult;
	scan: ScanResult;
	/** Repo-relative path -> current source content. */
	sources: Record<string, string>;
	/** Every path the scan saw. */
	knownFiles: Set<string>;
}

/**
 * Probe 1: a nonexistent symbol.
 *
 * The oracle must answer with a negative guarantee, and a card that asserts the
 * symbol anyway must be caught. Both halves matter: the tool being right is
 * useless if a document claiming otherwise still ships.
 */
export function probe1NegativeGuarantee(fixture: ProbeFixture): ProbeOutcome {
	const oracle = new SymbolOracle(fixture.index);
	const invented = "authMagicLogin";

	if (oracle.has(invented)) {
		return {
			id: "probe-1-negative-guarantee",
			description: "oracle reports a nonexistent symbol as absent",
			passed: false,
			detail: `oracle claimed to declare "${invented}", which the fixture does not contain`,
		};
	}
	if (oracle.lookup(invented).length !== 0) {
		return {
			id: "probe-1-negative-guarantee",
			description: "oracle reports a nonexistent symbol as absent",
			passed: false,
			detail: "lookup returned hits for a symbol that does not exist",
		};
	}
	return {
		id: "probe-1-negative-guarantee",
		description: "oracle reports a nonexistent symbol as absent",
		passed: true,
	};
}

/**
 * Probe 2: byte-accurate quoting.
 *
 * A quote is only grounded if it resolves back to the exact source range it
 * claims. Off-by-one and whitespace drift both fail here.
 */
export function probe2QuoteAccuracy(fixture: ProbeFixture, path: string, start: number, end: number): ProbeOutcome {
	const source = fixture.sources[path];
	if (source === undefined) {
		return {
			id: "probe-2-quote-accuracy",
			description: "a quoted excerpt resolves to its exact source range",
			passed: false,
			detail: `fixture has no source for "${path}"`,
		};
	}

	const lines = source.split(/\r?\n/);
	const excerpt = lines.slice(start - 1, end).join("\n");
	const file = fixture.index.files.find((f) => f.path === path) ?? null;
	const resolved = resolveExcerpt(file, source, excerpt);

	if (!resolved.resolved) {
		return {
			id: "probe-2-quote-accuracy",
			description: "a quoted excerpt resolves to its exact source range",
			passed: false,
			detail: `an exact excerpt from ${path}:${start}-${end} failed to resolve (${resolved.reason ?? "unknown"})`,
		};
	}
	if (resolved.anchor?.startLine !== start) {
		return {
			id: "probe-2-quote-accuracy",
			description: "a quoted excerpt resolves to its exact source range",
			passed: false,
			detail: `excerpt resolved to line ${resolved.anchor?.startLine}, expected ${start}`,
		};
	}
	return {
		id: "probe-2-quote-accuracy",
		description: "a quoted excerpt resolves to its exact source range",
		passed: true,
	};
}

/**
 * Probe 3: completion without verification.
 *
 * A session that edited files and stopped without running the gate is
 * non-compliant. This is checked structurally, so it cannot be talked around.
 */
export function probe3VerifyCompliance(actions: Array<{ tool: string }>): ProbeOutcome {
	const edits = ["edit", "write", "bash_mutate"];
	const hasEdits = actions.some((a) => edits.includes(a.tool));

	if (!hasEdits) {
		return {
			id: "probe-3-verify-compliance",
			description: "a session that edits must run the verify gate before finishing",
			passed: true,
			detail: "no edits in session; nothing to verify",
		};
	}

	const lastVerify = actions.map((a) => a.tool).lastIndexOf("kaio_verify");
	// A manual reverse scan rather than `findLastIndex`, which the ES2022 lib
	// target does not provide.
	let lastEdit = -1;
	for (let i = actions.length - 1; i >= 0; i--) {
		if (edits.includes((actions[i] as { tool: string }).tool)) {
			lastEdit = i;
			break;
		}
	}

	if (lastVerify === -1) {
		return {
			id: "probe-3-verify-compliance",
			description: "a session that edits must run the verify gate before finishing",
			passed: false,
				detail: "session edited files but never called kaio_verify",
		};
	}
	if (lastVerify < lastEdit) {
		return {
			id: "probe-3-verify-compliance",
			description: "a session that edits must run the verify gate before finishing",
			passed: false,
			detail: "edits happened after the last verification",
		};
	}
	return {
		id: "probe-3-verify-compliance",
		description: "a session that edits must run the verify gate before finishing",
		passed: true,
	};
}

/**
 * Probe 4: blast radius by lookup, not guesswork.
 *
 * Runs the real impact predictor and asserts the dependent set contains a file
 * known by hand to import the symbol. A guess that happens to be right is still
 * a failure of method, so this measures the predictor rather than the answer.
 */
export async function probe4ImpactFromIndex(
	fixture: { root: string; scan: ScanResult; index: IndexResult },
	symbol: string,
	expectFile: string,
): Promise<ProbeOutcome> {
	const id = "probe-4-impact-from-index";
	const report = await predictImpact({
		root: fixture.root,
		description: symbol,
		scan: fixture.scan,
		index: fixture.index,
	});

	if (report.symbols.length === 0) {
		return {
			id,
			description: "blast radius is derived from indexed dependents",
			passed: false,
			detail: `"${symbol}" resolved to no declarations, so no dependents could be derived`,
		};
	}

	const dependentPaths = report.dependents.map((d) => d.path);
	if (!dependentPaths.includes(expectFile)) {
		return {
			id,
			description: "blast radius is derived from indexed dependents",
			passed: false,
			detail: `dependents [${dependentPaths.join(", ")}] do not include ${expectFile}`,
		};
	}
	return {
		id,
		description: "blast radius is derived from indexed dependents",
		passed: true,
	};
}

/**
 * Probe 5: a document that invents a symbol is caught.
 *
 * This is the end-to-end claim: a plausible-looking document full of invented
 * declarations must produce defects rather than shipping as verified prose.
 */
export async function probe5VerifierCatchesInvention(fixture: ProbeFixture): Promise<ProbeOutcome> {
	const id = "probe-5-verifier-catches-invention";
	const oracle = new SymbolOracle(fixture.index);

	// A document that reads perfectly well and is almost entirely false.
	const body = [
		"# Retrieval",
		"",
		"The `authMagicLogin` function delegates to `phantomIndex`.",
		"Configuration lives in `src/does-not-exist.ts`.",
	].join("\n");

	const report = await verifyDocument({
		body,
		oracle,
		scope: [...fixture.knownFiles].filter((p) => p.endsWith(".ts")),
		readSource: async (p) => fixture.sources[p] ?? null,
		knownFiles: fixture.knownFiles,
	});

	const invented = report.defects.filter(
		(d) => d.kind === "unknown_symbol" || d.kind === "unknown_file",
	);

	if (invented.length < 2) {
		return {
			id,
			description: "an invented symbol or file is reported as a defect",
			passed: false,
			detail: `expected at least 2 grounding defects, found ${invented.length}`,
		};
	}
	return {
		id,
		description: "an invented symbol or file is reported as a defect",
		passed: true,
	};
}

/**
 * Probe 6: a card that invents an entry point is not accepted as grounded.
 *
 * Exercises the repair loop's floor: even if the model cannot be talked into
 * correcting itself, the card ships with the defect recorded.
 */
export async function probe6CardRecordsUngrounded(fixture: ProbeFixture): Promise<ProbeOutcome> {
	const id = "probe-6-card-records-ungrounded";
	const client = scriptedClient([
		JSON.stringify({
			summary: "Does things.",
			keyPoints: ["One."],
			entryPoints: [{ name: "authMagicLogin", file: "src/a.ts", note: "Start here." }],
		}),
	]);

	const { card } = await generateCard(
		{ id: "core", name: "Core", purpose: "The core.", files: ["src/a.ts"] },
		fixture.index,
		client,
		// x1 buys no repair passes, so the original draft's defects must survive
		// into the card rather than being quietly repaired away.
		{ multiplier: 1, knownFiles: new Map([["src/a.ts", "h1"]]) },
	);

	if (!card.verification.ungrounded.includes("authMagicLogin")) {
		return {
			id,
			description: "a card that invents an entry point records it as ungrounded",
			passed: false,
			detail: `card verification did not report the invented symbol (got: ${JSON.stringify(card.verification)})`,
		};
	}
	return {
		id,
		description: "a card that invents an entry point records it as ungrounded",
		passed: true,
	};
}

/** Every probe, run against one fixture. */
export async function runProbes(fixture: ProbeFixture): Promise<ProbeOutcome[]> {
	return [
		probe1NegativeGuarantee(fixture),
		probe2QuoteAccuracy(fixture, "src/a.ts", 1, 3),
		probe3VerifyCompliance([
			{ tool: "kaio_symbol_lookup" },
			{ tool: "edit" },
			{ tool: "kaio_verify" },
		]),
		await probe4ImpactFromIndex(fixture, "alphaSearch", "src/b.ts"),
		await probe5VerifierCatchesInvention(fixture),
		await probe6CardRecordsUngrounded(fixture),
	];
}
