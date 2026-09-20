#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildIndex, readIndexArtifact, SymbolOracle, writeIndexArtifact } from "./index/src/index.ts";
import { checkDrift } from "./provenance/src/index.ts";
import { KAIOKEN_DIR, scan, writeScanArtifact } from "./scan/src/index.ts";
import { bm25Search } from "./search/src/index.ts";
import { predictImpactForSymbol } from "./impact/src/index.ts";
import { runVerify } from "./verify/src/index.ts";

const [cmd, ...rest] = process.argv.slice(2);
const rootIndex = rest.indexOf("--root");
const root = rootIndex !== -1 && rest[rootIndex + 1] ? rest[rootIndex + 1] : process.cwd();

async function main() {
	switch (cmd) {
		case "scan": {
			const scanResult = await scan(root);
			await writeScanArtifact(root, scanResult);

			const previous = await readIndexArtifact(root);
			const { index, stats } = await buildIndex(scanResult, { previous });
			await writeIndexArtifact(root, index);

			const risks: Record<string, string[]> = {};
			for (const file of scanResult.files) {
				for (const risk of file.risk) {
					(risks[risk] ??= []).push(file.path);
				}
			}
			const riskPath = join(root, KAIOKEN_DIR, "risk.json");
			await mkdir(join(root, KAIOKEN_DIR), { recursive: true });
			await writeFile(riskPath, `${JSON.stringify(risks, null, 2)}\n`, "utf8");

			console.log(
				JSON.stringify(
					{
						root,
						scan: {
							fileCount: scanResult.fileCount,
							totalBytes: scanResult.totalBytes,
							riskCount: Object.keys(risks).length,
						},
						index: {
							fileCount: index.fileCount,
							symbolCount: index.symbolCount,
							stats,
						},
					},
					null,
					2,
				),
			);
			break;
		}
		case "symbols": {
			const query = rest.find((arg) => arg !== "--root" && arg !== root) ?? "";
			const index = (await readIndexArtifact(root)) ?? {
				root,
				builtAt: "",
				fileCount: 0,
				symbolCount: 0,
				unparsedLanguages: {},
				files: [],
			};
			const oracle = new SymbolOracle(index);
			const hits = oracle.lookup(query);
			console.log(JSON.stringify(hits, null, 2));
			break;
		}
		case "status": {
			const report = await checkDrift(root);
			console.log(JSON.stringify(report, null, 2));
			break;
		}
		case "search": {
			const query = rest.find((arg) => arg !== "--root" && arg !== root) ?? "";
			const results = await bm25Search(root, query);
			console.log(results);
			break;
		}
		case "impact": {
			const symbol = rest.find((arg) => arg !== "--root" && arg !== root) ?? "";
			const report = await predictImpactForSymbol(root, symbol);
			console.log(JSON.stringify(report, null, 2));
			break;
		}
		case "verify": {
			const result = await runVerify(root);
			if (result.pass) {
				console.log(`VERIFY: PASS\n${result.summary}`);
				process.exit(0);
			} else {
				console.error(`VERIFY: FAIL\n${result.summary}`);
				process.exit(1);
			}
			break;
		}
		default: {
			console.error("Usage: node kaioken/bin.ts <scan|symbols|status|search|impact|verify> [--root <path>]");
			process.exit(2);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
