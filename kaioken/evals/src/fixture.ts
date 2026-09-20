/**
 * The evaluation fixture: a small, self-contained repository.
 *
 * Every eval runs against this rather than a live codebase so the numbers are
 * reproducible and the suite stays offline (Invariant 10). It is deliberately
 * small enough to reason about by hand — an eval whose expected result nobody
 * can state is not measuring anything.
 */
import { buildIndex, type IndexResult } from "@kaioken/index";
import { scan, type ScanResult } from "@kaioken/scan";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture {
	root: string;
	scan: ScanResult;
	index: IndexResult;
	sources: Record<string, string>;
	knownFiles: Set<string>;
	dispose(): Promise<void>;
}

const SOURCE_A = [
	"export interface AlphaOptions {",
	"\tmaxReadBytes: number;",
	"}",
	"",
	"/** Walk the index and return ranked hits. */",
	"export function alphaSearch(query: string): string[] {",
	"\treturn [query];",
	"}",
	"",
	"export class Engine {",
	"\trun(): void {}",
	"}",
	"",
].join("\n");

const SOURCE_B = ['import { alphaSearch } from "./a.ts";', "", 'export const hits = alphaSearch("x");', ""].join("\n");

/**
 * Build the fixture on disk, then index it.
 *
 * `alphaSearch` is declared in `a.ts` and imported by `b.ts`, which is what
 * makes the blast-radius probe assertable: the dependent set is knowable by
 * hand, so a probe that misses it is a real failure.
 */
export async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "kaioken-eval-"));
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), SOURCE_A, "utf8");
	await writeFile(join(root, "src", "b.ts"), SOURCE_B, "utf8");
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name: "kaioken-eval-fixture", version: "1.0.0", type: "module" }, null, 2),
		"utf8",
	);

	const scanResult = await scan(root);
	const outcome = await buildIndex(scanResult);

	return {
		root,
		scan: scanResult,
		index: outcome.index,
		sources: { "src/a.ts": SOURCE_A, "src/b.ts": SOURCE_B },
		knownFiles: new Set(scanResult.files.filter((f) => !f.binary).map((f) => f.path)),
		dispose: () => rm(root, { recursive: true, force: true }),
	};
}

/** The fixture's sources as a lookup function, for verifier inputs. */
export function readerFor(fixture: Fixture): (path: string) => Promise<string | null> {
	return async (path: string) => fixture.sources[path] ?? null;
}
