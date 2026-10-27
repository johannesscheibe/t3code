import type { ProjectId } from "@t3tools/contracts";

import type { ThreadShell } from "./types";

type WorktreeUser = Pick<ThreadShell, "id" | "projectId" | "worktreePath" | "attachedCheckouts">;

/** A worktree and the project whose repository owns it, which is where `git worktree remove` runs. */
export interface OrphanedWorktree {
  readonly projectId: ProjectId;
  readonly path: string;
}

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function threadUsesWorktree(thread: WorktreeUser, worktreePath: string): boolean {
  return (
    normalizeWorktreePath(thread.worktreePath) === worktreePath ||
    thread.attachedCheckouts.some(
      (checkout) => normalizeWorktreePath(checkout.worktreePath) === worktreePath,
    )
  );
}

/** Whether a thread other than `threadId` works in the worktree, as its own or as an attached checkout. */
export function isWorktreeUsedByOtherThread(
  threads: ReadonlyArray<WorktreeUser>,
  threadId: ThreadShell["id"],
  worktreePath: string,
): boolean {
  const target = normalizeWorktreePath(worktreePath);
  if (!target) return false;
  return threads.some((thread) => thread.id !== threadId && threadUsesWorktree(thread, target));
}

/** The thread's own worktree and its attached checkouts' worktrees that no other thread uses. */
export function getOrphanedWorktreesForThread(
  threads: ReadonlyArray<WorktreeUser>,
  threadId: ThreadShell["id"],
): OrphanedWorktree[] {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return [];
  }
  const candidates = [
    { projectId: targetThread.projectId, path: targetThread.worktreePath },
    ...targetThread.attachedCheckouts.map((checkout) => ({
      projectId: checkout.projectId,
      path: checkout.worktreePath,
    })),
  ];
  return candidates.flatMap(({ projectId, path }) => {
    const normalized = normalizeWorktreePath(path);
    return normalized && !isWorktreeUsedByOtherThread(threads, threadId, normalized)
      ? [{ projectId, path: normalized }]
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
