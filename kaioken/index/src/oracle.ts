import type { FileMap, IndexResult, SymbolRecord } from "./types.ts";

/**
 * The index's second job. Phase 4's verifier asks "does this symbol exist?" and
 * needs a definitive answer, not a search result — a maybe is what lets an
 * invented symbol ship.
 *
 * This is a lookup over the same artifact the bundler reads. Forking it into a
 * separate "verification index" would create two things that could disagree.
 */

export interface SymbolLocation {
	path: string;
	symbol: SymbolRecord;
}

export class SymbolOracle {
	private readonly byName = new Map<string, SymbolLocation[]>();
	private readonly byPath = new Map<string, FileMap>();

	constructor(index: IndexResult) {
		for (const file of index.files) {
			this.byPath.set(file.path, file);
			for (const symbol of file.symbols) {
				const list = this.byName.get(symbol.name);
				const location: SymbolLocation = { path: file.path, symbol };
				if (list) list.push(location);
				else this.byName.set(symbol.name, [location]);
			}
		}

		// Register re-exported names so has(name) and lookup(name) connect re-exports
		for (const file of index.files) {
			if (!file.reexports) continue;
			for (const re of file.reexports) {
				if (re.name === "*") {
					const targetPath = this.resolvePath(file.path, re.from);
					const targetFile = targetPath ? this.byPath.get(targetPath) : null;
					if (targetFile) {
						for (const sym of targetFile.symbols) {
							if (sym.exported) {
								const list = this.byName.get(sym.name);
								const location: SymbolLocation = { path: targetFile.path, symbol: sym };
								if (list) {
									if (!list.some((l) => l.path === location.path && l.symbol.name === sym.name)) {
										list.push(location);
									}
								} else {
									this.byName.set(sym.name, [location]);
								}
							}
						}
					}
				} else {
					const resolved = this.resolve(file.path, re.name);
					if (resolved) {
						const list = this.byName.get(re.name);
						const location: SymbolLocation = { path: resolved.path, symbol: resolved.symbol };
						if (list) {
							if (!list.some((l) => l.path === location.path && l.symbol.name === resolved.symbol.name)) {
								list.push(location);
							}
						} else {
							this.byName.set(re.name, [location]);
						}
					}
				}
			}
		}
	}

	/** Definitive: the repository either declares or re-exports this name or it does not. */
	has(name: string): boolean {
		return this.byName.has(name);
	}

	/** Every declaration of a name. More than one is normal and not an error. */
	lookup(name: string): SymbolLocation[] {
		return this.byName.get(name) ?? [];
	}

	/** Scoped lookup, resolving local declarations or re-exports. */
	lookupIn(path: string, name: string): SymbolRecord | null {
		const loc = this.resolve(path, name);
		return loc ? loc.symbol : null;
	}

	/** Resolve a symbol name from a given file to its originating declaration location. */
	resolve(path: string, name: string): SymbolLocation | null {
		return this.resolveInternal(path, name, new Set<string>());
	}

	private resolveInternal(path: string, name: string, visited: Set<string>): SymbolLocation | null {
		const key = `${path}:${name}`;
		if (visited.has(key)) return null;
		visited.add(key);

		const file = this.byPath.get(path);
		if (!file) return null;

		// 1. Direct declaration
		const direct = file.symbols.find((s) => s.name === name);
		if (direct) {
			return { path: file.path, symbol: direct };
		}

		if (!file.reexports || file.reexports.length === 0) return null;

		// 2. Named re-export
		for (const re of file.reexports) {
			if (re.name === name) {
				const targetPath = this.resolvePath(path, re.from);
				if (!targetPath) continue;
				const targetName = re.importedName ?? re.name;
				const resolved = this.resolveInternal(targetPath, targetName, visited);
				if (resolved) return resolved;
			}
		}

		// 3. Wildcard re-export
		for (const re of file.reexports) {
			if (re.name === "*") {
				const targetPath = this.resolvePath(path, re.from);
				if (!targetPath) continue;
				const resolved = this.resolveInternal(targetPath, name, visited);
				if (resolved) return resolved;
			}
		}

		return null;
	}

	private resolvePath(fromPath: string, specifier: string): string | null {
		if (this.byPath.has(specifier)) return specifier;
		const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
		const raw = dir ? `${dir}/${specifier}` : specifier;
		const parts: string[] = [];
		for (const seg of raw.split("/")) {
			if (seg === "" || seg === ".") continue;
			if (seg === "..") parts.pop();
			else parts.push(seg);
		}
		const base = parts.join("/");
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
		for (const c of candidates) {
			if (this.byPath.has(c)) return c;
		}
		return null;
	}

	hasFile(path: string): boolean {
		return this.byPath.has(path);
	}

	file(path: string): FileMap | null {
		return this.byPath.get(path) ?? null;
	}

	/**
	 * Names a document claims exist but the repository does not declare. This is
	 * the shape phase 4 reports as defects, so it returns the misses rather than
	 * a boolean over the batch.
	 */
	unknownNames(names: Iterable<string>): string[] {
		const missing: string[] = [];
		for (const name of names) {
			if (!this.byName.has(name)) missing.push(name);
		}
		return missing;
	}

	/**
	 * Every exported declaration, which is what the coverage rubric scores a
	 * generated chapter against.
	 */
	exported(path?: string): SymbolLocation[] {
		const out: SymbolLocation[] = [];
		const files = path
			? [this.byPath.get(path)].filter((f): f is FileMap => f !== undefined)
			: [...this.byPath.values()];
		for (const file of files) {
			for (const symbol of file.symbols) {
				if (symbol.exported) out.push({ path: file.path, symbol });
			}
			if (file.reexports) {
				for (const re of file.reexports) {
					if (re.name === "*") {
						const targetPath = this.resolvePath(file.path, re.from);
						const targetFile = targetPath ? this.byPath.get(targetPath) : null;
						if (targetFile) {
							for (const sym of targetFile.symbols) {
								if (
									sym.exported &&
									!out.some((o) => o.path === targetFile.path && o.symbol.name === sym.name)
								) {
									out.push({ path: targetFile.path, symbol: sym });
								}
							}
						}
					} else {
						const resolved = this.resolve(file.path, re.name);
						if (
							resolved &&
							!out.some((o) => o.path === resolved.path && o.symbol.name === resolved.symbol.name)
						) {
							out.push(resolved);
						}
					}
				}
			}
		}
		return out;
	}

	get symbolCount(): number {
		let total = 0;
		for (const file of this.byPath.values()) total += file.symbols.length;
		return total;
	}
}
