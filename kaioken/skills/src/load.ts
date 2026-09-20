import { loadSkills, type Skill } from "./skills.ts";

export async function loadSkill(root: string, name: string): Promise<string> {
	const { skills } = await loadSkills(root);
	const skill = skills.find((s: Skill) => s.name === name);
	if (!skill) {
		const list = skills.map((s: Skill) => s.name).join(", ");
		return `Skill "${name}" not found. Available skills: ${list || "none"}`;
	}
	return `# Skill: ${skill.name}\n${skill.description}\n\n${skill.content}`;
}
