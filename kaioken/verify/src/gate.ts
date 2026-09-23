import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { KAIOKEN_DIR } from "@kaioken/scan";

const runExec = promisify(execFile);

export interface GateCommand {
	id: string;
	label: string;
	command: string;
	source: string;
}

export interface RunOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut?: boolean;
}

export interface CommandRunner {
	run(
		command: string,
		options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
	): Promise<RunOutcome>;
}

export interface GateResult extends GateCommand {
	ok: boolean;
	exitCode: number;
	durationMs: number;
	timedOut: boolean;
	output: string;
}

export type GateVerdict = "passed" | "failed" | "unverifiable";

export interface GateReport {
	verdict: GateVerdict;
	results: GateResult[];
	failed: GateResult[];
	reason?: string;
}

export const VERIFY_CONFIG = join(KAIOKEN_DIR, "verify.json");
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_TAIL_LINES = 60;
const OUTPUT_TAIL_CHARS = 8000;

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm" | "deno";

export async function detectPackageManager(root: string): Promise<PackageManager> {
	if (existsSync(join(root, "pnpm-lock.yaml")) || existsSync(join(root, "pnpm-workspace.yaml"))) return "pnpm";
	if (existsSync(join(root, "yarn.lock"))) return "yarn";
	if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
	if (existsSync(join(root, "deno.json")) || existsSync(join(root, "deno.jsonc")) || existsSync(join(root, "deno.lock"))) return "deno";
	return "npm";
}

export async function detectCommands(root: string): Promise<{
	commands: GateCommand[];
	source: string;
}> {
	const configured = await readConfig(root);
	if (configured) return { commands: configured, source: VERIFY_CONFIG };

	const found: GateCommand[] = [];
	const sources: string[] = [];

	const pkg = await readJson(join(root, "package.json"));
	const pm = await detectPackageManager(root);

	if (pkg && typeof pkg === "object") {
		const pkgRecord = pkg as { scripts?: unknown; workspaces?: unknown };
		const scripts = pkgRecord.scripts;
		const hasWorkspaces = Boolean(pkgRecord.workspaces);
		const hasPnpmWorkspace = existsSync(join(root, "pnpm-workspace.yaml"));
		const names = scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>) : null;

		if (names) {
			for (const label of ["typecheck", "build", "test"]) {
				if (typeof names[label] === "string") {
					const command =
						label === "test"
							? pm === "npm"
								? "npm run test"
								: `${pm} test`
							: `${pm} run ${label}`;
					found.push({
						id: `${pm}:${label}`,
						label,
						command,
						source: "package.json scripts",
					});
				}
			}
			if (found.length > 0) sources.push("package.json");
		}

		// Monorepo handling: if root package.json has a workspaces field or pnpm-workspace.yaml exists
		// and the root has no test script, fall back to a workspace-aware test command instead of failing.
		const hasTestScript = names && typeof names["test"] === "string";
		if ((hasWorkspaces || hasPnpmWorkspace) && !hasTestScript) {
			let workspaceCommand: string;
			if (pm === "pnpm") {
				workspaceCommand = "pnpm -r --if-present test";
			} else if (pm === "yarn") {
				workspaceCommand = "yarn workspaces run test";
			} else if (pm === "bun") {
				workspaceCommand = "bun test";
			} else {
				workspaceCommand = "npm test --workspaces --if-present";
			}
			found.push({
				id: `${pm}:test:workspaces`,
				label: "test",
				command: workspaceCommand,
				source: hasPnpmWorkspace ? "pnpm-workspace.yaml" : "package.json workspaces",
			});
			sources.push(hasPnpmWorkspace ? "pnpm-workspace.yaml" : "package.json workspaces");
		}

		// Fallback when package.json exists with no recognized scripts and not a monorepo
		if (found.length === 0) {
			const fallbackCmd = pm === "npm" ? "npm test" : `${pm} test`;
			found.push({
				id: `${pm}:test`,
				label: "test",
				command: fallbackCmd,
				source: "package.json",
			});
			sources.push("package.json");
		}
	} else if (existsSync(join(root, "pnpm-workspace.yaml"))) {
		found.push({
			id: "pnpm:test:workspaces",
			label: "test",
			command: "pnpm -r --if-present test",
			source: "pnpm-workspace.yaml",
		});
		sources.push("pnpm-workspace.yaml");
	}

	// Deno detection (deno.json / deno.jsonc / deno.lock -> deno test)
	const denoFile = existsSync(join(root, "deno.json"))
		? "deno.json"
		: existsSync(join(root, "deno.jsonc"))
			? "deno.jsonc"
			: existsSync(join(root, "deno.lock"))
				? "deno.lock"
				: null;
	if (denoFile && (found.length === 0 || pm === "deno")) {
		found.push({
			id: "deno:test",
			label: "test",
			command: "deno test",
			source: denoFile,
		});
		sources.push(denoFile);
	}

	if (existsSync(join(root, "go.mod"))) {
		found.push(
			{ id: "go:build", label: "build", command: "go build ./...", source: "go.mod" },
			{ id: "go:test", label: "test", command: "go test ./...", source: "go.mod" },
		);
		sources.push("go.mod");
	}

	if (existsSync(join(root, "Cargo.toml"))) {
		found.push(
			{ id: "cargo:build", label: "build", command: "cargo build", source: "Cargo.toml" },
			{ id: "cargo:test", label: "test", command: "cargo test", source: "Cargo.toml" },
		);
		sources.push("Cargo.toml");
	}

	if (found.length === 0 && existsSync(join(root, "Makefile"))) {
		const make = await readText(join(root, "Makefile"));
		if (make) {
			for (const label of ["build", "test"]) {
				if (new RegExp(`^${label}:`, "m").test(make)) {
					found.push({
						id: `make:${label}`,
						label,
						command: `make ${label}`,
						source: "Makefile",
					});
				}
			}
			if (found.length > 0) sources.push("Makefile");
		}
	}

	if (found.length === 0 && existsSync(join(root, "pyproject.toml"))) {
		found.push({ id: "py:test", label: "test", command: "pytest", source: "pyproject.toml" });
		sources.push("pyproject.toml");
	}

	return { commands: found, source: sources.join(", ") };
}

export interface TestFailure {
	file?: string;
	testName?: string;
	message?: string;
}

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function extractFailures(output: string): TestFailure[] {
	const clean = stripAnsi(output).replace(/\r\n/g, "\n");
	const lines = clean.split("\n");
	const failures: TestFailure[] = [];
	const seen = new Set<string>();

	// Pytest: FAILED path/to/file.py::test_name - message
	const pytestRe = /^FAILED\s+([^:\s]+)::(\S+)(?:\s+-\s+(.*))?$/;

	// Go test: --- FAIL: TestName (0.01s)
	const goFailRe = /^---\s*FAIL:\s*([^\s(]+)/;

	// Jest / Vitest FAIL header: FAIL path/to/file.test.ts
	const vitestFailFileRe = /^\s*FAIL\s+([^\s:]+\.(?:[jt]sx?|m[jt]s|c[jt]s|py|go|rs))/;

	// Vitest arrow: ❯ path/to/file.test.ts:12:5 > suite > testName OR ❯ testName
	const vitestArrowRe = /^\s*❯\s+(?:([^\s:]+\.(?:[jt]sx?|m[jt]s|c[jt]s)):\d+:\d+\s+>\s+)?(.*)$/;

	// Jest bullet: ● suite › testName
	const jestBulletRe = /^\s*●\s+(.+)$/;

	// Vitest / Jest cross: ✕ testName or ✖ testName
	const crossRe = /^\s*[✕✖×]\s+(.+?)(?:\s+\(\d+.*?\))?$/;

	// Cargo test: test module::test_name ... FAILED
	const cargoFailRe = /^test\s+([^\s]+)\s+\.\.\.\s+FAILED$/;

	let currentFile: string | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		const fileMatch = vitestFailFileRe.exec(line);
		if (fileMatch) {
			currentFile = fileMatch[1];
		}

		const pyMatch = pytestRe.exec(line);
		if (pyMatch) {
			const file = pyMatch[1];
			const testName = pyMatch[2];
			const message = pyMatch[3]?.trim();
			const key = `${file}::${testName}`;
			if (!seen.has(key)) {
				seen.add(key);
				failures.push({ file, testName, message });
			}
			continue;
		}

		const goMatch = goFailRe.exec(line);
		if (goMatch) {
			const testName = goMatch[1];
			let file: string | undefined;
			let message: string | undefined;
			if (i + 1 < lines.length) {
				const nextLine = lines[i + 1]!;
				const locMatch = /^\s*([^\s:]+\.go:\d+)(?::\s*(.*))?$/.exec(nextLine);
				if (locMatch) {
					file = locMatch[1];
					message = locMatch[2]?.trim();
				}
			}
			const key = `${file || ""}:${testName}`;
			if (!seen.has(key)) {
				seen.add(key);
				failures.push({ file, testName, message });
			}
			continue;
		}

		const cargoMatch = cargoFailRe.exec(line);
		if (cargoMatch) {
			const testName = cargoMatch[1];
			const key = `cargo:${testName}`;
			if (!seen.has(key)) {
				seen.add(key);
				failures.push({ testName });
			}
			continue;
		}

		const arrowMatch = vitestArrowRe.exec(line);
		if (arrowMatch) {
			const file = arrowMatch[1] || currentFile;
			const testName = arrowMatch[2]?.trim();
			if (testName && !testName.startsWith("FAIL") && !testName.includes("Error:")) {
				const key = `${file || ""}:${testName}`;
				if (!seen.has(key)) {
					seen.add(key);
					failures.push({ file, testName });
				}
			}
			continue;
		}

		const jestMatch = jestBulletRe.exec(line);
		if (jestMatch) {
			const testName = jestMatch[1]?.trim();
			const key = `${currentFile || ""}:${testName}`;
			if (!seen.has(key)) {
				seen.add(key);
				failures.push({ file: currentFile, testName });
			}
			continue;
		}

		const crossMatch = crossRe.exec(line);
		if (crossMatch) {
			const testName = crossMatch[1]?.trim();
			if (testName && !testName.includes("failed") && !testName.includes("Tests ") && !testName.includes("Test Files")) {
				const key = `${currentFile || ""}:${testName}`;
				if (!seen.has(key)) {
					seen.add(key);
					failures.push({ file: currentFile, testName });
				}
			}
			continue;
		}
	}

	return failures;
}

export function formatFailureSummary(rawOutput: string): string {
	const trimmed = rawOutput.replace(/\r\n/g, "\n").trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("Failed tests (")) return trimmed;

	const failures = extractFailures(trimmed);
	const rawTail = tail(trimmed);

	if (failures.length === 0) {
		return rawTail;
	}

	const headerLines = [
		`Failed tests (${failures.length}):`,
		...failures.map((f) => {
			if (f.file && f.testName) return `  - ${f.file}: ${f.testName}`;
			if (f.file) return `  - ${f.file}`;
			return `  - ${f.testName ?? "unknown test"}`;
		}),
		"",
		"--- Output tail ---",
		rawTail,
	];

	return headerLines.join("\n");
}

export class SystemCommandRunner implements CommandRunner {
	async run(
		command: string,
		options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
	): Promise<RunOutcome> {
		const isWin = process.platform === "win32";
		const start = Date.now();
		const shell = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
		const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
		try {
			const { stdout, stderr } = await runExec(shell, args, {
				cwd: options.cwd,
				timeout: options.timeoutMs,
				signal: options.signal,
				maxBuffer: 1e7,
			});
			return {
				exitCode: 0,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
				durationMs: Date.now() - start,
			};
		} catch (error: unknown) {
			const err = error as {
				code?: number | string;
				stdout?: string;
				stderr?: string;
				killed?: boolean;
				message?: string;
			};
			const timedOut = Boolean(err.killed);
			const exitCode = typeof err.code === "number" ? err.code : 1;
			return {
				exitCode,
				stdout: err.stdout ?? "",
				stderr: err.stderr ?? err.message ?? (error instanceof Error ? error.message : String(error)),
				durationMs: Date.now() - start,
				timedOut,
			};
		}
	}
}

export async function runGate(
	commands: readonly GateCommand[],
	runner: CommandRunner,
	options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<GateReport> {
	if (commands.length === 0) {
		return {
			verdict: "unverifiable",
			results: [],
			failed: [],
			reason:
				"no build or test command could be discovered — " +
				`declare them in ${VERIFY_CONFIG} to make the gate meaningful`,
		};
	}

	const results: GateResult[] = [];
	for (const command of commands) {
		if (options.signal?.aborted) {
			results.push({
				...command,
				ok: false,
				exitCode: -1,
				durationMs: 0,
				timedOut: false,
				output: "aborted by signal",
			});
			break;
		}

		let outcome: RunOutcome;
		try {
			outcome = await runner.run(command.command, {
				cwd: options.cwd,
				timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				signal: options.signal,
			});
		} catch (error) {
			outcome = {
				exitCode: -1,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
				durationMs: 0,
			};
		}

		const isOk = outcome.exitCode === 0 && outcome.timedOut !== true && !options.signal?.aborted;
		const rawOutput = `${outcome.stdout}${outcome.stderr}`;
		results.push({
			...command,
			ok: isOk,
			exitCode: outcome.exitCode,
			durationMs: outcome.durationMs,
			timedOut: outcome.timedOut === true,
			output: isOk ? tail(rawOutput) : formatFailureSummary(rawOutput),
		});

		if (options.signal?.aborted) break;
	}

	const failed = results.filter((result) => !result.ok);
	return { verdict: failed.length === 0 ? "passed" : "failed", results, failed };
}

export function tail(text: string): string {
	const trimmed = text.replace(/\r\n/g, "\n").trimEnd();
	if (!trimmed) return "";

	const lines = trimmed.split("\n");
	let out = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
	if (out.length > OUTPUT_TAIL_CHARS) out = out.slice(-OUTPUT_TAIL_CHARS);
	return out;
}

export const REPAIR_PROTOCOL =
	"REPAIR LOOP: read failure verbatim → minimal fix → re-run kaio_verify.\n" +
	"Max 5 iterations; then stop and present failing output to the human.\n" +
	"Never weaken/delete tests to pass. Never mark done on FAIL.";

export async function runVerify(
	root: string,
	timeoutMs = 300_000,
	runner: CommandRunner = new SystemCommandRunner(),
): Promise<{ pass: boolean; summary: string }> {
	const { commands } = await detectCommands(root);
	if (commands.length === 0) {
		return { pass: false, summary: "unverifiable: no native suite detected" };
	}

	const report = await runGate(commands, runner, {
		cwd: root,
		timeoutMs,
	});

	if (report.verdict === "passed") {
		const combined = report.results
			.map((r) => r.output)
			.filter(Boolean)
			.join("\n");
		return {
			pass: true,
			summary: tail(combined.slice(-2000)) || "all checks passed",
		};
	}

	const failedOutputs = report.failed
		.map((f) => f.output)
		.filter(Boolean)
		.join("\n");
	const combinedFailed = failedOutputs || report.reason || "verification failed";
	return {
		pass: false,
		summary: formatFailureSummary(combinedFailed),
	};
}

async function readConfig(root: string): Promise<GateCommand[] | null> {
	const parsed = await readJson(join(root, VERIFY_CONFIG));
	if (!parsed || typeof parsed !== "object") return null;

	const raw = (parsed as { commands?: unknown }).commands;
	if (!Array.isArray(raw)) return null;

	const commands: GateCommand[] = [];
	for (const [i, entry] of raw.entries()) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const command = typeof record["command"] === "string" ? record["command"].trim() : "";
		if (!command) continue;
		const label = typeof record["label"] === "string" ? record["label"].trim() : "check";
		commands.push({ id: `config:${label}:${i}`, label, command, source: VERIFY_CONFIG });
	}
	return commands.length > 0 ? commands : null;
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function readJson(path: string): Promise<unknown> {
	const text = await readText(path);
	if (text === null) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}
