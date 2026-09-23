/**
 * Provenance is machinery, not metadata.
 *
 * A record that only described where a document came from would be decoration.
 * A record a program can act on is what makes three other things possible at
 * all: incremental update, an honest answer to "how stale is this?", and — in a
 * later phase — predicting which documents a proposed change would obsolete.
 *
 * These types live in their own package precisely because every knowledge
 * tenant needs them. A wiki chapter and a knowledge card age the same way.
 */

import type { FileRecord } from "@kaioken/scan";

/** One source a derived artifact was written from, pinned to its content. */
export interface ProvenanceSource {
	path: string;
	/**
	 * Content hash at generation time. Comparing this against the current scan
	 * is the whole invalidation mechanism — no git required, and no scanning of
	 * prose for file paths and hoping the model wrote a tidy list.
	 */
	hash: string;
	/**
	 * Optional symbol this documentation binds to within `path`. Present only
	 * for symbol-aware bindings; absence means whole-file binding.
	 */
	symbol?: string;
	/** Optional 1-based line range within `path` for line-range bindings. */
	startLine?: number;
	/** Optional 1-based inclusive end line for line-range bindings. */
	endLine?: number;
	/**
	 * Content hash of the bound symbol or line range at generation time.
	 * When present alongside `symbol` or `startLine`/`endLine`, staleness can
	 * compare just that range (given current range hashes) instead of the
	 * whole file. Absence means whole-file binding.
	 */
	rangeHash?: string;
}

/** What one derived artifact was written from. */
export interface Provenance {
	/** Identifier of the artifact: wiki-relative path, or card module id. */
	document: string;
	chapterId?: string;
	sectionId?: string;
	generatedAt: string;
	sources: ProvenanceSource[];
}

export interface ProvenanceIndex {
	version: 1;
	generatedAt: string;
	documents: Provenance[];
}

/** How a derived artifact stands relative to the repository as it is now. */
export type Freshness =
	| "current"
	/** At least one source changed since generation. */
	| "stale"
	/** Every source it was written from is gone. */
	| "orphaned"
	/** The artifact records no sources, so nothing can be said about it. */
	| "unknown";

export interface DocumentStatus {
	document: string;
	freshness: Freshness;
	/** Sources whose content hash no longer matches. */
	changed: string[];
	/** Sources the repository no longer contains. */
	deleted: string[];
	/** Sources still exactly as they were. */
	unchanged: string[];
	generatedAt: string;
}

/** Options for staleness computation. All fields optional; defaults preserve whole-file behavior. */
export interface StalenessOptions {
	/**
	 * Return false to exclude a file from `undocumentedFiles`. Applied after
	 * the built-in non-source exclusions (tests, lockfiles, dotfiles,
	 * scripts/, config files).
	 */
	undocumentedFilter?: (file: FileRecord) => boolean;
	/**
	 * Current range hashes keyed by binding key (`path#symbol` or
	 * `path:start-end`; see `bindingKeyFor`). When provided, sources with a
	 * `rangeHash` binding are judged against it; otherwise they fall back to
	 * whole-file comparison.
	 */
	symbolHashes?: ReadonlyMap<string, string>;
}

/** Options for inverse invalidation lookup. */
export interface InvalidationOptions {
	/**
	 * Binding keys (`path#symbol`, `path:start-end`) whose ranges changed.
	 * When provided, symbol-bound sources match against this set instead of
	 * the file path, so edits outside the bound range do not invalidate.
	 * When absent, every source matches by file path (whole-file default).
	 */
	changedSymbols?: Iterable<string>;
}

/** One source that moved, for a targeted regeneration diff. */
export interface ChangedSource {
	path: string;
	was: string;
	now: string | null;
	symbol?: string;
	startLine?: number;
	endLine?: number;
}

export interface StalenessReport {
	/** Artifacts that have moved past the state they describe. */
	stale: DocumentStatus[];
	current: DocumentStatus[];
	orphaned: DocumentStatus[];
	/** Every document, in the order given. */
	documents: DocumentStatus[];

	/** Distinct source files that changed under at least one document. */
	changedFiles: string[];
	/** Distinct source files that were deleted under at least one document. */
	deletedFiles: string[];
	/**
	 * Files the scan contains that no document was written from. Not a defect —
	 * documentation is selective — but it is the honest denominator for "how
	 * much of this repository is described at all?".
	 */
	undocumentedFiles: string[];

	/** 0..1. The share of documents that still match their sources. */
	freshness: number;
	/** True when nothing is stale or orphaned. */
	ok: boolean;
}
