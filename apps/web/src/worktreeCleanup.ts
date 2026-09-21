import type { OrchestrationProjectShell } from "@t3tools/contracts";

import type { ThreadShell } from "./types";

type WorktreeUser = Pick<ThreadShell, "id" | "worktreePath" | "checkouts">;
type WorktreeProject = Pick<OrchestrationProjectShell, "id" | "workspaceRoot">;

/** Trailing separators are noise: `/repo/wt/` and `/repo/wt` name the same directory. */
function normalizeWorktreePath(path: string | null | undefined): string | null {
  const trimmed = path?.trim().replace(/(?<=.)[\\/]+$/, "");
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

/** Whether a thread works in the worktree, as its own workspace or an attached checkout. */
function usesWorktree(thread: WorktreeUser, path: string): boolean {
  return (
    normalizeWorktreePath(thread.worktreePath) === path ||
    thread.checkouts.some((checkout) => normalizeWorktreePath(checkout.worktreePath) === path)
  );
}

/**
 * Whether deleting the worktree at `path` along with `threadId` is safe. A
 * registered project's root is never deleted: another project may be registered
 * at a linked worktree, and its local threads record no worktree path there.
 */
function isOrphanedWorktree(
  threads: ReadonlyArray<WorktreeUser>,
  threadId: ThreadShell["id"],
  path: string,
  projects: ReadonlyArray<WorktreeProject>,
): boolean {
  return (
    !projects.some((project) => normalizeWorktreePath(project.workspaceRoot) === path) &&
    !threads.some((thread) => thread.id !== threadId && usesWorktree(thread, path))
  );
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<WorktreeUser>,
  threadId: ThreadShell["id"],
  projects: ReadonlyArray<WorktreeProject>,
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  const path = normalizeWorktreePath(targetThread?.worktreePath);
  return path !== null && isOrphanedWorktree(threads, threadId, path, projects) ? path : null;
}

/**
 * Attached checkouts that are worktrees no other thread works in, offered for
 * deletion by the same rule as the thread's own worktree. A project's own
 * checkout has no worktree and is never offered.
 */
export function getOrphanedCheckoutWorktrees(
  threads: ReadonlyArray<WorktreeUser>,
  threadId: ThreadShell["id"],
  projects: ReadonlyArray<WorktreeProject>,
) {
  const targetThread = threads.find((thread) => thread.id === threadId);
  return (targetThread?.checkouts ?? []).flatMap((checkout) => {
    const path = normalizeWorktreePath(checkout.worktreePath);
    return path !== null && isOrphanedWorktree(threads, threadId, path, projects)
      ? [{ ...checkout, worktreePath: path }]
      : [];
  });
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
