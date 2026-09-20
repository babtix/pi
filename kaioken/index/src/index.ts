export { buildIndex } from "./build.ts";
export type { BuildOptions, BuildOutcome, BuildStats } from "./build.ts";
export { extractFile, docOf, isExported, signatureOf } from "./extract.ts";
export type { ExtractInput } from "./extract.ts";
export { initParser, isSupportedLanguage, loadGrammar, supportedLanguages } from "./grammars.ts";
export { SymbolOracle } from "./oracle.ts";
export type { SymbolLocation } from "./oracle.ts";
export { enclosingSymbol, readExcerpt, resolveExcerpt, resolveRange } from "./anchors.ts";
export type { Anchor, AnchorResolution } from "./anchors.ts";
export {
	INDEX_ARTIFACT,
	indexArtifactPath,
	readIndexArtifact,
	writeIndexArtifact,
} from "./artifact.ts";
export type { FileMap, IndexResult, SymbolKind, SymbolRecord } from "./types.ts";
