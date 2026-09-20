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

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export async function detectPackageManager(root: string): Promise<PackageManager> {
	if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(root, "yarn.lock"))) return "yarn";
	if (existsSync(join(root, "bun.lockb"))) return "bun";
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
	if (pkg && typeof pkg === "object") {
		const pm = await detectPackageManager(root);
		const scripts = (pkg as { scripts?: unknown }).scripts;

		if (scripts && typeof scripts === "object") {
			const names = scripts as Record<string, unknown>;
			for (const label of ["typecheck", "build", "test"]) {
				if (typeof names[label] === "string") {
					found.push({
						id: `${pm}:${label}`,
						label,
						command: `${pm} run ${label}`,
						source: "package.json scripts",
					});
				}
			}
			if (found.length > 0) sources.push("package.json");
		}
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

		results.push({
			...command,
			ok: outcome.exitCode === 0 && outcome.timedOut !== true && !options.signal?.aborted,
			exitCode: outcome.exitCode,
			durationMs: outcome.durationMs,
			timedOut: outcome.timedOut === true,
			output: tail(`${outcome.stdout}${outcome.stderr}`),
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

export async function runVerify(root: string, timeoutMs = 300_000): Promise<{ pass: boolean; summary: string }> {
	const isWin = process.platform === "win32";
	const suite: [string, string[]] | null =
		existsSync(join(root, "package.json"))
			? isWin
				? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm test"]]
				: ["npm", ["test"]]
			: existsSync(join(root, "go.mod"))
				? ["go", ["test", "./..."]]
				: existsSync(join(root, "Cargo.toml"))
					? ["cargo", ["test"]]
					: existsSync(join(root, "Makefile"))
						? ["make", ["test"]]
						: null;

	if (!suite) {
		return { pass: false, summary: "unverifiable: no native suite detected" };
	}

	try {
		const { stdout } = await runExec(suite[0], suite[1], {
			cwd: root,
			timeout: timeoutMs,
			maxBuffer: 1e7,
		});
		return { pass: true, summary: tail(stdout.slice(-2000)) };
	} catch (e: any) {
		const combined = (e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "");
		return { pass: false, summary: tail(combined) };
	}
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
