import type { OrchestrationProjectShell, ThreadWorktreeLink } from "@t3tools/contracts";
import { normalizeThreadWorktreePath, threadWorktrees } from "@t3tools/shared/threadWorktrees";

import type { ThreadShell } from "./types";

type WorktreeUser = Pick<ThreadShell, "id" | "projectId" | "worktreePath"> & {
  readonly worktrees?: ReadonlyArray<ThreadWorktreeLink> | undefined;
};

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return normalizeThreadWorktreePath(trimmed);
}

type WorktreeProject = Pick<OrchestrationProjectShell, "id" | "workspaceRoot">;

/** Whether a thread works in the path, as its primary workspace or an attachment. */
function usesWorktree(
  thread: WorktreeUser,
  path: string,
  projects: ReadonlyArray<WorktreeProject>,
): boolean {
  return (
    normalizeWorktreePath(
      thread.worktreePath ??
        projects.find((project) => project.id === thread.projectId)?.workspaceRoot ??
        null,
    ) === path ||
    threadWorktrees(thread).some((link) => normalizeWorktreePath(link.worktreePath) === path)
  );
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<WorktreeUser>,
  threadId: ThreadShell["id"],
  projects: ReadonlyArray<WorktreeProject>,
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (
    !targetWorktreePath ||
    projects.some((project) => normalizeWorktreePath(project.workspaceRoot) === targetWorktreePath)
  ) {
    return null;
  }

  const isShared = threads.some(
    (thread) => thread.id !== threadId && usesWorktree(thread, targetWorktreePath, projects),
  );

  return isShared ? null : targetWorktreePath;
}

/** Attached worktrees no other thread works in, safe to offer for deletion with this thread. */
export function getOrphanedAttachedWorktrees(
  threads: ReadonlyArray<WorktreeUser>,
  threadId: ThreadShell["id"],
  projects: ReadonlyArray<WorktreeProject>,
): ReadonlyArray<ThreadWorktreeLink> {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return [];
  }
  return threadWorktrees(targetThread).filter((link) => {
    const path = normalizeWorktreePath(link.worktreePath);
    return (
      path !== null &&
      !projects.some((project) => normalizeWorktreePath(project.workspaceRoot) === path) &&
      !threads.some((thread) => thread.id !== threadId && usesWorktree(thread, path, projects))
    );
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
