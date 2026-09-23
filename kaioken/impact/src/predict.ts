import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SymbolOracle, type IndexResult, readIndexArtifact } from "@kaioken/index";
import { readCardsSafe, readProvenanceIndex } from "@kaioken/provenance";
import { scan, type ScanResult } from "@kaioken/scan";
import { loadSkills } from "@kaioken/skills";

interface IndexReExport {
	name: string;
	importedName?: string;
	from: string;
}

type IndexFile = IndexResult["files"][number] & { reexports?: IndexReExport[] };

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
const SWEEP_CONCURRENCY = 24;

const GENERIC_NAMES: ReadonlySet<string> = new Set([
	"id",
	"ids",
	"name",
	"names",
	"status",
	"config",
	"configs",
	"error",
	"errors",
	"data",
	"info",
	"type",
	"types",
	"value",
	"values",
	"item",
	"items",
	"result",
	"results",
	"option",
	"options",
	"param",
	"params",
	"input",
	"inputs",
	"output",
	"outputs",
	"file",
	"files",
	"path",
	"paths",
	"title",
	"description",
	"content",
	"message",
	"messages",
	"code",
	"text",
	"util",
	"utils",
	"helper",
	"helpers",
	"index",
	"main",
	"app",
	"lib",
	"test",
	"spec",
	"default",
	"create",
	"update",
	"delete",
	"remove",
	"load",
	"save",
	"read",
	"write",
	"parse",
	"format",
	"handle",
	"process",
	"run",
	"start",
	"stop",
	"init",
	"build",
	"check",
	"fetch",
	"send",
	"request",
	"response",
	"client",
	"server",
	"service",
	"manager",
	"controller",
	"handler",
	"factory",
	"provider",
	"module",
	"component",
	"element",
	"node",
	"list",
	"map",
	"key",
	"keys",
	"props",
	"state",
	"store",
	"cache",
	"token",
	"auth",
	"user",
	"users",
	"settings",
	"version",
	"event",
	"events",
	"stream",
	"buffer",
	"queue",
	"worker",
	"model",
	"view",
	"router",
	"route",
	"plugin",
	"page",
	"form",
	"table",
]);

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

interface TextMatcher {
	name: string;
	generic: boolean;
	word: RegExp;
	importLine: RegExp;
	callSite: RegExp;
	typeUse: RegExp;
}

interface SweptFile {
	path: string;
	graphLinked: boolean;
	mentions: string[];
	strongCount: number;
}

async function sweep(
	input: PredictInput,
	names: ReadonlySet<string>,
	seeds: ReadonlySet<string>,
): Promise<{ dependents: Array<{ path: string; mentions: string[] }>; partial: boolean }> {
	if (names.size === 0) return { dependents: [], partial: false };

	const matchers: TextMatcher[] = [...names].map((name) => buildMatcher(name));

	const candidates = input.scan.files.filter(
		(file) => !seeds.has(file.path) && file.size <= MAX_FILE_BYTES && !file.binary,
	);

	const partial = candidates.length > MAX_FILES_SWEPT;
	const limited = candidates.slice(0, MAX_FILES_SWEPT);

	const knownPaths = new Set(input.scan.files.map((file) => file.path));
	const byPath = indexByPath(input.index);
	const seedList = seeds;

	const readouts = await mapWithConcurrency(limited, SWEEP_CONCURRENCY, async (file) => {
		try {
			const content = await readFile(join(input.root, file.path), "utf8");
			return { path: file.path, language: file.language, content };
		} catch {
			return null;
		}
	});

	const swept: SweptFile[] = [];
	for (const readout of readouts) {
		if (!readout) continue;
		const graphLinked = isGraphLinked(readout.path, readout.content, byPath, knownPaths, seedList);
		const code = codeOnly(readout.content);
		const mentions: string[] = [];
		let strongCount = 0;
		for (const matcher of matchers) {
			if (!matcher.word.test(readout.content)) continue;
			const strong = isStrongMatch(readout.content, matcher);
			if (matcher.generic) {
				if (!strong) continue;
				if (!matcher.word.test(code)) continue;
				mentions.push(matcher.name);
				strongCount++;
			} else {
				mentions.push(matcher.name);
				if (strong) strongCount++;
			}
		}
		if (mentions.length === 0) continue;
		mentions.sort();
		swept.push({ path: readout.path, graphLinked, mentions, strongCount });
	}

	swept.sort(
		(a, b) =>
			Number(b.graphLinked) - Number(a.graphLinked) ||
			b.strongCount - a.strongCount ||
			b.mentions.length - a.mentions.length ||
			a.path.localeCompare(b.path),
	);
	return {
		dependents: swept.map((entry) => ({ path: entry.path, mentions: entry.mentions })),
		partial,
	};
}

function buildMatcher(name: string): TextMatcher {
	const escaped = escapeRegex(name);
	const word = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
	return {
		name,
		generic: isGenericName(name),
		word,
		importLine: new RegExp(`(^|\\n)[^\\n]*\\b(?:import|export|require)\\b[^\\n]*${
			`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`
		}`),
		callSite: new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])\\s*\\(`),
		typeUse: new RegExp(
			`(?:[:<|,]\\s*|extends\\s+|implements\\s+|\\bas\\s+|\\bnew\\s+)(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`,
		),
	};
}

function isGenericName(name: string): boolean {
	if (name.length <= 4) return true;
	return GENERIC_NAMES.has(name.toLowerCase());
}

function isStrongMatch(content: string, matcher: TextMatcher): boolean {
	return matcher.importLine.test(content) || matcher.callSite.test(content) || matcher.typeUse.test(content);
}

function codeOnly(content: string): string {
	let out = "";
	let i = 0;
	let lineStart = true;
	while (i < content.length) {
		const char = content[i] as string;
		const next = (content[i + 1] ?? "") as string;
		if (char === "/" && next === "/") {
			while (i < content.length && content[i] !== "\n") i++;
			continue;
		}
		if (char === "/" && next === "*") {
			i += 2;
			while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
				if (content[i] === "\n") {
					out += "\n";
					lineStart = true;
				}
				i++;
			}
			i += 2;
			out += " ";
			continue;
		}
		if (char === "#" && lineStart) {
			while (i < content.length && content[i] !== "\n") i++;
			continue;
		}
		if (char === "#" && next === " " && !isWordChar(content[i - 1] ?? "\n")) {
			while (i < content.length && content[i] !== "\n") i++;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			out += " ";
			i++;
			while (i < content.length) {
				const inner = content[i] as string;
				if (inner === "\\") {
					i += 2;
					continue;
				}
				if (inner === "\n" && quote !== "`") break;
				if (inner === quote) {
					i++;
					break;
				}
				if (inner === "\n") out += "\n";
				i++;
			}
			out += " ";
			lineStart = false;
			continue;
		}
		out += char;
		lineStart = char === "\n";
		i++;
	}
	return out;
}

function isWordChar(char: string): boolean {
	return /[A-Za-z0-9_$]/.test(char);
}

function indexByPath(index: IndexResult | null): Map<string, IndexFile> {
	const byPath = new Map<string, IndexFile>();
	if (!index) return byPath;
	for (const file of index.files) byPath.set(file.path, file as IndexFile);
	return byPath;
}

function isGraphLinked(
	path: string,
	content: string,
	byPath: ReadonlyMap<string, IndexFile>,
	knownPaths: ReadonlySet<string>,
	seeds: ReadonlySet<string>,
): boolean {
	if (seeds.size === 0) return false;
	for (const spec of extractImportSpecifiers(content)) {
		const target = resolveImportSpec(path, spec, knownPaths);
		if (target && seeds.has(target)) return true;
	}
	const record = byPath.get(path);
	if (record?.reexports) {
		for (const re of record.reexports) {
			const target = resolveImportSpec(path, re.from, knownPaths);
			if (target && seeds.has(target)) return true;
		}
	}
	return false;
}

function extractImportSpecifiers(content: string): string[] {
	const specs: string[] = [];
	const push = (spec: string): void => {
		const trimmed = spec.trim();
		if (trimmed) specs.push(trimmed);
	};
	let match: RegExpExecArray | null;
	const fromRe = /(?:import|export)\s+(?:type\s+)?[^\n;]*?\sfrom\s*['"]([^'"]+)['"]/g;
	while ((match = fromRe.exec(content)) !== null) push(match[1] as string);
	const sideEffectRe = /import\s*['"]([^'"]+)['"]/g;
	while ((match = sideEffectRe.exec(content)) !== null) push(match[1] as string);
	const dynamicRe = /(?:import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]\s*\)/g;
	while ((match = dynamicRe.exec(content)) !== null) push(match[1] as string);
	const pyFromRe = /^\s*from\s+([.\w]+)\s+import\b/gm;
	while ((match = pyFromRe.exec(content)) !== null) push(match[1] as string);
	const pyImportRe = /^\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/gm;
	while ((match = pyImportRe.exec(content)) !== null) {
		const group = match[1] as string;
		for (const part of group.split(",")) {
			const head = part.split(/\s+as\s+/)[0]?.trim() ?? "";
			if (/^[.\w]+$/.test(head)) push(head);
		}
	}
	return specs;
}

function resolveImportSpec(
	importer: string,
	spec: string,
	known: ReadonlySet<string>,
): string | null {
	const trimmed = spec.trim();
	if (!trimmed || trimmed.startsWith("node:") || trimmed.startsWith("http:") || trimmed.startsWith("https:")) {
		return null;
	}
	if (/^[\w.]+$/.test(trimmed) && trimmed.includes(".") && !trimmed.includes("/")) {
		const pyResolved = resolvePythonModule(importer, trimmed, known);
		if (pyResolved) return pyResolved;
	}
	if (trimmed.startsWith(".")) {
		const dir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
		const raw = dir ? `${dir}/${trimmed}` : trimmed;
		return tryResolveBase(normalizePosix(raw), known);
	}
	const stripped = trimmed.replace(/^@\//, "").replace(/^~\//, "").replace(/^\//, "");
	const direct = tryResolveBase(normalizePosix(stripped), known);
	if (direct) return direct;
	if (/^[A-Za-z0-9_./-]+$/.test(stripped) && stripped.includes("/")) {
		const suffix = `/${stripped}`;
		for (const path of known) {
			if (path === stripped || path.endsWith(suffix)) return path;
			if (path.endsWith(`${suffix}.ts`) || path.endsWith(`${suffix}.tsx`)) return path;
			if (path.endsWith(`${suffix}.js`) || path.endsWith(`${suffix}.py`)) return path;
		}
	}
	return null;
}

function resolvePythonModule(importer: string, spec: string, known: ReadonlySet<string>): string | null {
	const leadingMatch = /^\.+/.exec(spec);
	const leading = leadingMatch ? (leadingMatch[0] as string).length : 0;
	const rest = leading > 0 ? spec.slice(leading) : spec;
	const dir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
	if (leading > 0) {
		const parts = dir ? dir.split("/") : [];
		const up = leading - 1;
		const baseParts = parts.slice(0, Math.max(0, parts.length - up));
		const restParts = rest ? rest.split(".").filter((part) => part.length > 0) : [];
		const base = [...baseParts, ...restParts].join("/");
		return tryResolveBase(base, known) ?? tryPythonCandidates(base, known);
	}
	const dotted = spec.split(".").join("/");
	return tryResolveBase(dotted, known) ?? tryPythonCandidates(dotted, known);
}

function tryPythonCandidates(base: string, known: ReadonlySet<string>): string | null {
	const candidates = [`${base}.py`, `${base}/__init__.py`];
	for (const candidate of candidates) {
		if (known.has(candidate)) return candidate;
	}
	return null;
}

function tryResolveBase(base: string, known: ReadonlySet<string>): string | null {
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		`${base}.py`,
		`${base}.go`,
		`${base}.rs`,
		`${base}/index.ts`,
		`${base}/index.tsx`,
		`${base}/index.js`,
		`${base}/index.jsx`,
		`${base}/__init__.py`,
	];
	for (const candidate of candidates) {
		if (known.has(candidate)) return candidate;
	}
	return null;
}

function normalizePosix(raw: string): string {
	const parts: string[] = [];
	for (const seg of raw.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return parts.join("/");
}

async function mapWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.min(Math.max(1, limit), items.length);
	const workers: Array<Promise<void>> = [];
	for (let w = 0; w < workerCount; w++) {
		workers.push(
			(async (): Promise<void> => {
				while (true) {
					const current = next;
					next += 1;
					if (current >= items.length) return;
					const item = items[current] as T;
					out[current] = await fn(item, current);
				}
			})(),
		);
	}
	await Promise.all(workers);
	return out;
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
