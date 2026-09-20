import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { KAIOKEN_DIR } from "@kaioken/scan";
import { parse as parseYaml } from "yaml";

export const SKILLS_DIR = join(KAIOKEN_DIR, "skills");

export interface Skill {
	name: string;
	description: string;
	content: string;
	path: string;
}

export interface SkillProblem {
	path: string;
	reason: string;
}

export interface LoadedSkills {
	skills: Skill[];
	problems: SkillProblem[];
}

export function skillsDir(root: string): string {
	return join(root, SKILLS_DIR);
}

export async function loadSkills(root: string): Promise<LoadedSkills> {
	const dir = skillsDir(root);
	const skills: Skill[] = [];
	const problems: SkillProblem[] = [];

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return { skills, problems };
	}

	for (const entry of entries.sort()) {
		const abs = join(dir, entry);

		let isDir = false;
		try {
			isDir = (await stat(abs)).isDirectory();
		} catch {
			continue;
		}

		const file = isDir ? join(abs, "SKILL.md") : abs;
		if (!isDir && extname(entry).toLowerCase() !== ".md") continue;

		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch {
			if (isDir) continue;
			problems.push({ path: relative(root, file).split("\\").join("/"), reason: "unreadable" });
			continue;
		}

		const relPath = relative(root, file).split("\\").join("/");
		const parsed = parseSkill(raw, defaultName(entry, isDir));

		if ("reason" in parsed) {
			problems.push({ path: relPath, reason: parsed.reason });
			continue;
		}
		skills.push({ ...parsed, path: relPath });
	}

	const seen = new Set<string>();
	for (const skill of skills) {
		if (seen.has(skill.name)) {
			problems.push({ path: skill.path, reason: `duplicate skill name "${skill.name}"` });
		}
		seen.add(skill.name);
	}

	return { skills, problems };
}

function defaultName(entry: string, isDir: boolean): string {
	return isDir ? entry : basename(entry, extname(entry));
}

export function parseSkill(
	raw: string,
	fallbackName: string,
): Omit<Skill, "path"> | { reason: string } {
	const normalised = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalised);
	if (!match) return { reason: "no frontmatter block" };

	let front: unknown;
	try {
		front = parseYaml(match[1] as string);
	} catch (error) {
		return { reason: `frontmatter is not valid YAML (${(error as Error).message.split("\n")[0]})` };
	}
	if (typeof front !== "object" || front === null || Array.isArray(front)) {
		return { reason: "frontmatter is not a mapping" };
	}

	const fields = front as Record<string, unknown>;
	const name = typeof fields["name"] === "string" ? fields["name"].trim() : "";
	const description =
		typeof fields["description"] === "string" ? fields["description"].trim() : "";

	if (!description) return { reason: "frontmatter has no description" };

	const content = normalised.slice(match[0].length).trim();
	if (!content) return { reason: "skill has no body" };

	return { name: name || fallbackName, description, content };
}
