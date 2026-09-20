import type { Claim } from "./types.ts";

/**
 * Pull every checkable claim out of a generated document.
 *
 * The generation prompt asks the model not to invent files, symbols or
 * excerpts. A request is not a guarantee — so this pass extracts what the
 * document actually claims, and the verifier checks each one. Nothing here
 * consults the repository; it only reads the prose.
 */

/** `path/to/file.ext` or `path/to/file.ext:12` or `:12-40`, inside backticks. */
const CODE_SPAN = /`([^`\n]+)`/g;

/** A path-looking token: at least one slash or a known-ish extension. */
const PATH_LIKE = /^[A-Za-z0-9._\-/]+\.[A-Za-z0-9]{1,10}$/;
const ANCHOR = /^([A-Za-z0-9._\-/]+\.[A-Za-z0-9]{1,10}):(\d+)(?:-(\d+))?$/;

/** An identifier a document would write for a declaration. */
const SYMBOL_LIKE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/**
 * Words that make a code span prose rather than a claim: a document may write
 * `true` or `null` without asserting the repository declares them.
 */
const NOT_SYMBOLS = new Set([
	"true",
	"false",
	"null",
	"nil",
	"none",
	"undefined",
	"string",
	"number",
	"boolean",
	"int",
	"bool",
	"void",
	"any",
	"object",
	"array",
	"error",
	"this",
	"self",
	"new",
	"return",
	"import",
	"export",
	"const",
	"let",
	"var",
	"if",
	"else",
	"for",
	"while",
	"async",
	"await",
	"json",
	"yaml",
	"http",
	"https",
	"npm",
	"git",
	"ok",
	"n",
	"x",
	"y",
]);

export function extractClaims(body: string): Claim[] {
	const claims: Claim[] = [];
	const lines = body.split(/\r?\n/);

	let inFence = false;
	let fenceInfo = "";
	let fenceStart = 0;
	let fenceBuffer: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const lineNumber = i + 1;

		const fence = /^\s*(?:```|~~~)(.*)$/.exec(line);
		if (fence) {
			if (inFence) {
				const excerpt = fenceBuffer.join("\n");
				const attribution = parseFenceInfo(fenceInfo);
				// Only a fence that names a source file is a quotation. An
				// illustrative snippet claims nothing and must not be checked.
				if (attribution && excerpt.trim()) {
					claims.push({
						kind: "excerpt",
						text: excerpt,
						line: fenceStart,
						file: attribution.file,
						...(attribution.startLine !== undefined ? { startLine: attribution.startLine } : {}),
						...(attribution.endLine !== undefined ? { endLine: attribution.endLine } : {}),
					});
				}
				inFence = false;
				fenceBuffer = [];
			} else {
				inFence = true;
				fenceInfo = (fence[1] ?? "").trim();
				fenceStart = lineNumber;
			}
			continue;
		}

		if (inFence) {
			fenceBuffer.push(line);
			continue;
		}

		for (const span of codeSpans(line)) {
			const claim = classify(span, lineNumber);
			if (claim) claims.push(claim);
		}
	}

	return dedupe(claims);
}

function codeSpans(line: string): string[] {
	const out: string[] = [];
	CODE_SPAN.lastIndex = 0;
	for (let m = CODE_SPAN.exec(line); m; m = CODE_SPAN.exec(line)) {
		const inner = (m[1] ?? "").trim();
		if (inner) out.push(inner);
	}
	return out;
}

function classify(span: string, line: number): Claim | null {
	const anchor = ANCHOR.exec(span);
	if (anchor) {
		const start = Number.parseInt(anchor[2] as string, 10);
		const end = anchor[3] ? Number.parseInt(anchor[3], 10) : start;
		return {
			kind: "anchor",
			text: span,
			line,
			file: anchor[1] as string,
			startLine: start,
			endLine: end,
		};
	}

	if (PATH_LIKE.test(span) && span.includes("/")) {
		return { kind: "file", text: span, line };
	}

	// A call written as `doThing()` still claims `doThing` exists.
	const call = /^([A-Za-z_$][A-Za-z0-9_$.]*)\(\s*\)?$/.exec(span);
	const candidate = call ? (call[1] as string) : span;

	if (
		SYMBOL_LIKE.test(candidate) &&
		!NOT_SYMBOLS.has(candidate.toLowerCase()) &&
		candidate.length > 2 &&
		// A bare lowercase word is almost always prose; a declaration reference
		// carries a case boundary, a dot, or an underscore.
		/[A-Z_.]/.test(candidate)
	) {
		return { kind: "symbol", text: candidate, line };
	}

	return null;
}

/**
 * A fence info string that attributes the excerpt: ```ts path/to/file.ts:10-20
 * Anything else is an illustration, not a quotation.
 */
function parseFenceInfo(info: string): { file: string; startLine?: number; endLine?: number } | null {
	for (const token of info.split(/\s+/).filter(Boolean)) {
		const anchor = ANCHOR.exec(token);
		if (anchor) {
			const start = Number.parseInt(anchor[2] as string, 10);
			return {
				file: anchor[1] as string,
				startLine: start,
				endLine: anchor[3] ? Number.parseInt(anchor[3], 10) : start,
			};
		}
		// No slash required here, unlike an inline code span. A fence info
		// string is an explicit attribution slot, so `deploy.sh` or
		// `package.json` in it is a file and nothing else — and requiring a
		// slash meant every quotation from a root-level file was silently
		// skipped rather than verified. A bare language tag (`ts`, `sh`) has no
		// dot and so cannot match.
		if (PATH_LIKE.test(token)) return { file: token };
	}
	return null;
}

function dedupe(claims: Claim[]): Claim[] {
	const seen = new Set<string>();
	const out: Claim[] = [];
	for (const claim of claims) {
		const key = `${claim.kind}:${claim.file ?? ""}:${claim.text}:${claim.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(claim);
	}
	return out;
}

/**
 * Phrases that would read identically for any codebase.
 *
 * Padding is a defect on equal footing with error: an accurate sentence that
 * says nothing still costs the reader the time spent reading it, and a document
 * full of them is worse than a short one.
 */
const PADDING_PHRASES = [
	"it is important to note",
	"it is worth noting",
	"it should be noted",
	"in conclusion",
	"in summary",
	"as we can see",
	"as mentioned above",
	"as mentioned earlier",
	"this module provides",
	"this function is responsible for",
	"this class is responsible for",
	"this file contains",
	"provides functionality for",
	"a wide range of",
	"various features",
	"and much more",
	"etc.",
	"robust and scalable",
	"best practices",
	"plays a crucial role",
	"plays a vital role",
	"it is essential to",
	"one of the most important",
	"the heart of the",
	"at its core",
	"simply put",
	"needless to say",
	"when it comes to",
	"a variety of",
	"the following features",
];

/** Find padding phrases with their line numbers. */
export function findPadding(body: string): Array<{ phrase: string; line: number }> {
	const out: Array<{ phrase: string; line: number }> = [];
	const lines = body.split(/\r?\n/);
	let inFence = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;

		// Quoted source may legitimately contain any phrase at all.
		if (/^\s*(?:```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const lowered = line.toLowerCase();
		for (const phrase of PADDING_PHRASES) {
			if (lowered.includes(phrase)) out.push({ phrase, line: i + 1 });
		}
	}

	return out;
}
