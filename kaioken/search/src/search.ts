import { SearchIndex, type SearchHit } from "./index-store.ts";

export async function bm25Search(root: string, query: string, limit = 8): Promise<string> {
	try {
		const searchIndex = await SearchIndex.open(root);
		const hits: SearchHit[] = await searchIndex.search({ text: query, limit });
		if (hits.length === 0) return `No matches found for "${query}".`;
		return JSON.stringify(
			hits.map((h) => ({
				score: Math.round(h.score * 1000) / 1000,
				kind: h.kind,
				path: h.path,
				heading: h.heading,
				snippet: h.snippet,
			})),
			null,
			2,
		);
	} catch {
		return `No search index available or search error for "${query}".`;
	}
}
