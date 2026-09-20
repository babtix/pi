import { resolveExcerpt, resolveRange, type SymbolOracle } from "@kaioken/index";
import { extractClaims, findPadding } from "./claims.ts";
import type { Claim, Defect, VerificationReport } from "./types.ts";

export interface VerifyInput {
	body: string;
	oracle: SymbolOracle;
	scope: readonly string[];
	readSource: (path: string) => Promise<string | null>;
	knownFiles: ReadonlySet<string>;
}

export async function verifyDocument(input: VerifyInput): Promise<VerificationReport> {
	const claims = extractClaims(input.body);
	const defects: Defect[] = [];
	let grounded = 0;

	const scopeText = await readScope(input);

	for (const claim of claims) {
		const defect = await checkClaim(claim, input, scopeText);
		if (defect) defects.push(defect);
		else grounded++;
	}

	for (const { phrase, line } of findPadding(input.body)) {
		defects.push({
			kind: "padding",
			claim: phrase,
			line,
			detail: `"${phrase}" would read identically for any codebase`,
		});
	}

	const { uncovered, coverage } = coverageOf(input.body, input.oracle, input.scope);
	for (const name of uncovered.slice(0, 25)) {
		defects.push({
			kind: "uncovered_export",
			claim: name,
			detail: "exported declaration in scope that the document never mentions",
		});
	}

	return { grounded, defects, uncovered, coverage };
}

async function checkClaim(
	claim: Claim,
	input: VerifyInput,
	scopeText: string,
): Promise<Defect | null> {
	switch (claim.kind) {
		case "file": {
			if (input.knownFiles.has(claim.text)) return null;
			const base = claim.text.slice(claim.text.lastIndexOf("/") + 1);
			for (const known of input.knownFiles) {
				if (known.endsWith(`/${base}`) || known === base) return null;
			}
			if (scopeText.includes(base)) return null;
			return {
				kind: "unknown_file",
				claim: claim.text,
				line: claim.line,
				detail: "the repository contains no such file",
			};
		}

		case "symbol": {
			if (namesAKnownFile(claim.text, input.knownFiles)) return null;

			for (const candidate of nameCandidates(claim.text)) {
				if (input.oracle.has(candidate)) return null;
			}
			if (appearsInSource(scopeText, claim.text)) return null;
			return {
				kind: "unknown_symbol",
				claim: claim.text,
				line: claim.line,
				detail: "appears nowhere in the source this document was written from",
			};
		}

		case "anchor": {
			const file = claim.file as string;
			if (!input.knownFiles.has(file)) {
				return {
					kind: "unknown_file",
					claim: claim.text,
					line: claim.line,
					detail: "the repository contains no such file",
				};
			}
			const resolved = resolveRange(
				input.oracle.file(file),
				claim.startLine ?? 1,
				claim.endLine ?? claim.startLine ?? 1,
			);
			if (resolved.resolved) return null;
			return {
				kind: "bad_anchor",
				claim: claim.text,
				line: claim.line,
				detail:
					resolved.reason === "file_not_indexed"
						? "the file has no declaration index, so the range cannot be confirmed"
						: "the file does not have those lines",
			};
		}

		case "excerpt": {
			const file = claim.file as string;
			if (!input.knownFiles.has(file)) {
				return {
					kind: "unknown_file",
					claim: file,
					line: claim.line,
					detail: "the excerpt is attributed to a file the repository does not contain",
				};
			}
			const source = await input.readSource(file);
			if (source === null) {
				return {
					kind: "unknown_file",
					claim: file,
					line: claim.line,
					detail: "the attributed file could not be read",
				};
			}
			const resolved = resolveExcerpt(input.oracle.file(file), source, claim.text);
			if (resolved.resolved) return null;

			if (resolved.reason === "file_not_indexed") {
				if (containsExcerpt(source, claim.text)) return null;
				return {
					kind: "excerpt_not_found",
					claim: firstLine(claim.text),
					line: claim.line,
					detail: "the attributed file does not contain that text",
				};
			}

			return {
				kind: resolved.reason === "excerpt_ambiguous" ? "excerpt_ambiguous" : "excerpt_not_found",
				claim: firstLine(claim.text),
				line: claim.line,
				detail:
					resolved.reason === "excerpt_ambiguous"
						? `the excerpt appears in ${resolved.matchCount} places, so the citation is not specific`
						: "the attributed file does not contain that text",
			};
		}
	}
}

export function coverageOf(
	body: string,
	oracle: SymbolOracle,
	scope: readonly string[],
): { uncovered: string[]; coverage: number } {
	const exported = new Set<string>();
	for (const path of scope) {
		for (const location of oracle.exported(path)) exported.add(location.symbol.name);
	}

	if (exported.size === 0) return { uncovered: [], coverage: 1 };

	const uncovered = [...exported].filter((name) => !mentions(body, name)).sort();
	return {
		uncovered,
		coverage: (exported.size - uncovered.length) / exported.size,
	};
}

async function readScope(input: VerifyInput): Promise<string> {
	const parts: string[] = [];
	for (const path of input.scope) {
		const source = await input.readSource(path);
		if (source !== null) parts.push(source);
	}
	return parts.join("\n");
}

function namesAKnownFile(text: string, knownFiles: ReadonlySet<string>): boolean {
	if (knownFiles.has(text)) return true;
	if (text.includes("/")) return false;
	for (const known of knownFiles) {
		if (known === text || known.endsWith(`/${text}`)) return true;
	}
	return false;
}

function containsExcerpt(source: string, excerpt: string): boolean {
	const fold = (text: string) =>
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.join("\n");

	const needle = fold(excerpt);
	return needle !== "" && fold(source).includes(needle);
}

function appearsInSource(source: string, name: string): boolean {
	for (const candidate of nameCandidates(name)) {
		if (mentions(source, candidate)) return true;
	}
	const lowered = source.toLowerCase();
	for (const candidate of nameCandidates(name)) {
		if (mentions(lowered, candidate.toLowerCase())) return true;
	}
	return false;
}

function mentions(body: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(body);
}

function nameCandidates(written: string): string[] {
	const out = [written];
	const dot = written.lastIndexOf(".");
	if (dot > 0 && dot < written.length - 1) out.push(written.slice(dot + 1));
	return out;
}

function firstLine(text: string): string {
	const newline = text.indexOf("\n");
	const line = newline === -1 ? text : text.slice(0, newline);
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function summariseDefects(defects: readonly Defect[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const defect of defects) out[defect.kind] = (out[defect.kind] ?? 0) + 1;
	return out;
}

export function groundingDefects(defects: readonly Defect[]): Defect[] {
	return defects.filter(
		(d) =>
			d.kind === "unknown_file" ||
			d.kind === "unknown_symbol" ||
			d.kind === "bad_anchor" ||
			d.kind === "excerpt_not_found" ||
			d.kind === "excerpt_ambiguous",
	);
}
