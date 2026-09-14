import type { ProjectId, ThreadWorktreeKey, ThreadWorktreeLink } from "@t3tools/contracts";

/** Trailing separators are noise: `/repo/wt/` and `/repo/wt` name the same worktree. */
export function normalizeThreadWorktreePath(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  const stripped = trimmed.replace(/[\\/]+$/, "");
  return stripped.length === 0 ? trimmed : stripped;
}

export function threadWorktreeKeysEqual(
  left: ThreadWorktreeKey,
  right: ThreadWorktreeKey,
): boolean {
  return (
    normalizeThreadWorktreePath(left.worktreePath) ===
    normalizeThreadWorktreePath(right.worktreePath)
  );
}

/** Attached worktrees of a thread; threads from pre-attach servers carry none. */
export function threadWorktrees(thread: {
  readonly worktrees?: ReadonlyArray<ThreadWorktreeLink> | undefined;
}): ReadonlyArray<ThreadWorktreeLink> {
  return thread.worktrees ?? [];
}

export interface ThreadWorkspace {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly branch: string | null;
  /** True for the workspace the provider session runs in. */
  readonly primary: boolean;
}

/**
 * Every checkout a thread works in: the primary workspace first, then attached
 * worktrees in attach order. Callers that fan out git work over a thread
 * (checkpoints, status refresh, cleanup) iterate this instead of reading
 * `worktreePath` alone.
 */
export function threadWorkspaces(
  thread: {
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly worktrees?: ReadonlyArray<ThreadWorktreeLink> | undefined;
  },
  primaryWorkspaceRoot: string | undefined,
): ReadonlyArray<ThreadWorkspace> {
  const primaryPath = thread.worktreePath ?? primaryWorkspaceRoot;
  const primary: ReadonlyArray<ThreadWorkspace> =
    primaryPath === undefined
      ? []
      : [{ projectId: thread.projectId, path: primaryPath, branch: thread.branch, primary: true }];
  return [
    ...primary,
    ...threadWorktrees(thread).map((link) => ({
      projectId: link.projectId,
      path: link.worktreePath,
      branch: link.branch,
      primary: false,
    })),
  ];
}
