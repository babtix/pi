export type ClaimKind = "file" | "symbol" | "anchor" | "excerpt";

export interface Claim {
	kind: ClaimKind;
	text: string;
	line: number;
	file?: string;
	startLine?: number;
	endLine?: number;
}

export interface Defect {
	kind:
		| "unknown_file"
		| "unknown_symbol"
		| "bad_anchor"
		| "excerpt_not_found"
		| "excerpt_ambiguous"
		| "uncovered_export"
		| "padding";
	claim: string;
	line?: number;
	detail: string;
}

export interface VerificationReport {
	grounded: number;
	defects: Defect[];
	uncovered: string[];
	coverage: number;
}
