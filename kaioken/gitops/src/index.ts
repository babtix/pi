export { git, gitDir, gitLine, isRepo, type GitResult } from "./run.ts";
export { hookPath, hookStatus, installPostCommit, removePostCommit, type HookStatus } from "./hook.ts";
export { currentBranch, readDiff, recentSubjects, type DiffSnapshot } from "./diff.ts";
