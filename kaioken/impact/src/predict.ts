import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SymbolOracle, type IndexResult, readIndexArtifact } from "@kaioken/index";
import { readCardsSafe, readProvenanceIndex } from "@kaioken/provenance";
import { scan, type ScanResult } from "@kaioken/scan";
import { loadSkills } from "@kaioken/skills";

export interface ModelClient {
	complete(opts: { system?: string; prompt: string; purpose?: string; maxOutputTokens?: number }): Promise<string>;
}

function extractJson<T>(raw: string): T | null {
	try {
		const jsonMatch = /\{[\s\S]*\}/.exec(raw);
		return jsonMatch ? (JSON.parse(jsonMatch[0]) as T) : null;
	} catch {
		return null;
	}
}

export interface ImpactReport {
	description: string;
	symbols: Array<{ name: string; path: string; kind: string; exported: boolean }>;
	seeds: string[];
	dependents: Array<{ path: string; mentions: string[] }>;
	modules: Array<{ id: string; name: string; files: string[] }>;
	documents: Array<{ id: string; files: string[] }>;
	skills: Array<{ name: string; path: string }>;
	unknown: string[];
	partial: boolean;
}

export interface PredictInput {
	root: string;
	description: string;
	scan: ScanResult;
	index: IndexResult | null;
	client?: ModelClient;
	limit?: number;
}

const EMPTY_INDEX: IndexResult = {
	root: "",
	builtAt: "",
	fileCount: 0,
	symbolCount: 0,
	unparsedLanguages: {},
	files: [],
};

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_SWEPT = 8000;

export async function predictImpact(input: PredictInput): Promise<ImpactReport> {
	const oracle = new SymbolOracle(input.index ?? EMPTY_INDEX);
	const knownPaths = new Set(input.scan.files.map((file) => file.path));

	const proposed = await candidateNames(input);
	const symbols: ImpactReport["symbols"] = [];
	const unknown: string[] = [];
	const names = new Set<string>();

	for (const name of proposed.symbols) {
		const found = oracle.lookup(name);
		if (found.length === 0) {
			if (proposed.fromModel.has(name) || looksLikeIdentifier(name)) unknown.push(name);
			continue;
		}
		names.add(name);
		for (const location of found) {
			symbols.push({
				name,
				path: location.path,
				kind: location.symbol.kind,
				exported: location.symbol.exported,
			});
		}
	}

	const seeds = new Set<string>(symbols.map((symbol) => symbol.path));
	for (const path of proposed.files) {
		if (knownPaths.has(path)) seeds.add(path);
		else unknown.push(path);
	}

	const { dependents, partial } = await sweep(input, names, seeds);
	const limit = input.limit ?? 40;
	const affected = new Set([...seeds, ...dependents.map((entry) => entry.path)]);

	return {
		description: input.description,
		symbols,
		seeds: [...seeds].sort(),
		dependents: dependents.slice(0, limit),
		modules: await affectedModules(input.root, affected),
		documents: await affectedDocuments(input.root, affected),
		skills: await affectedSkills(input.root, affected),
		unknown: [...new Set(unknown)].sort(),
		partial,
	};
}

export async function predictImpactForSymbol(root: string, symbol: string): Promise<ImpactReport> {
	const scanResult = await scan(root);
	const indexResult = await readIndexArtifact(root);
	return predictImpact({
		root,
		description: symbol,
		scan: scanResult,
		index: indexResult,
	});
}

async function candidateNames(
	input: PredictInput,
): Promise<{ symbols: string[]; files: string[]; fromModel: Set<string> }> {
	const literal = {
		symbols: [...new Set(input.description.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])],
		files: [...new Set(input.description.match(/[\w./-]+\.[A-Za-z0-9]{1,8}/g) ?? [])].map((path) =>
			path.replace(/^\.\//, ""),
		),
	};
	if (!input.client) return { ...literal, fromModel: new Set<string>() };

	try {
		const raw = await input.client.complete({
			system: EXTRACT_SYSTEM,
			prompt: `Change described: ${input.description}`,
			purpose: "impact candidates",
			maxOutputTokens: 400,
		});
		const parsed = extractJson<{ symbols?: unknown; files?: unknown }>(raw);
		const symbols = stringsOf(parsed?.symbols);
		const files = stringsOf(parsed?.files);
		return {
			symbols: [...new Set([...symbols, ...literal.symbols])],
			files: [...new Set([...files, ...literal.files])],
			fromModel: new Set([...symbols, ...files]),
		};
	} catch {
		return { ...literal, fromModel: new Set<string>() };
	}
}

const EXTRACT_SYSTEM = `You turn a described code change into the identifiers it is about.

Given a plain-English description of a refactor or change, list the declaration names
(functions, types, classes, constants) and file paths it most likely concerns.

Guess names in the style the description implies; a name that does not exist will be
discarded by the caller, so propose the plausible spellings rather than hedging.

Return ONLY JSON: {"symbols":["..."],"files":["..."]}`;

function looksLikeIdentifier(name: string): boolean {
	if (name.includes("_")) return true;
	return /[a-z][A-Z]/.test(name) || /^[A-Z][a-z0-9]*[A-Z]/.test(name);
}

function stringsOf(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
		: [];
}

async function sweep(
	input: PredictInput,
	names: ReadonlySet<string>,
	seeds: ReadonlySet<string>,
): Promise<{ dependents: Array<{ path: string; mentions: string[] }>; partial: boolean }> {
	if (names.size === 0) return { dependents: [], partial: false };

	const matchers = [...names].map((name) => ({
		name,
		pattern: new RegExp(`(?<![A-Za-z0-9_$])${escapeRegex(name)}(?![A-Za-z0-9_$])`),
	}));

	const candidates = input.scan.files.filter(
		(file) =>
			!seeds.has(file.path) &&
			file.size <= MAX_FILE_BYTES &&
			!file.binary,
	);

	const dependents: Array<{ path: string; mentions: string[] }> = [];
	let swept = 0;
	let partial = false;

	for (const file of candidates) {
		if (swept >= MAX_FILES_SWEPT) {
			partial = true;
			break;
		}
		swept++;

		let content: string;
		try {
			content = await readFile(join(input.root, file.path), "utf8");
		} catch {
			continue;
		}

		const hits: string[] = [];
		for (const matcher of matchers) {
			if (matcher.pattern.test(content)) hits.push(matcher.name);
		}
		if (hits.length > 0) {
			dependents.push({ path: file.path, mentions: hits.sort() });
		}
	}

	dependents.sort((a, b) => b.mentions.length - a.mentions.length || a.path.localeCompare(b.path));
	return { dependents, partial };
}

async function affectedModules(
	root: string,
	affected: ReadonlySet<string>,
): Promise<ImpactReport["modules"]> {
	const out: ImpactReport["modules"] = [];
	const cards = await readCardsSafe(root);
	for (const card of cards) {
		const files = card.sources.map((source: { path: string }) => source.path).filter((path: string) => affected.has(path));
		if (files.length > 0) out.push({ id: card.document.replace(/^card:/, ""), name: card.document, files: files.sort() });
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function affectedDocuments(
	root: string,
	affected: ReadonlySet<string>,
): Promise<ImpactReport["documents"]> {
	const provenance = await readProvenanceIndex(root);
	const out: ImpactReport["documents"] = [];
	for (const record of provenance ?? []) {
		const files = record.sources.map((source: { path: string }) => source.path).filter((path: string) => affected.has(path));
		if (files.length > 0) out.push({ id: record.document, files: files.sort() });
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function affectedSkills(
	root: string,
	affected: ReadonlySet<string>,
): Promise<ImpactReport["skills"]> {
	const { skills } = await loadSkills(root);
	const out: ImpactReport["skills"] = [];
	for (const skill of skills) {
		const mentions = [...affected].some((path) => skill.content.includes(path));
		if (mentions) out.push({ name: skill.name, path: skill.path });
	}
	return out;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
