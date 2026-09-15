import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

/**
 * Checkpoint ref for an attached worktree. The path separates worktrees in one
 * repository. New links also carry an attachment ID so detach and reattach can
 * start a fresh baseline without overwriting the earlier attachment's refs.
 * Legacy links omit the ID and retain their original ref names.
 */
export function checkpointRefForThreadWorktreeTurn(
  threadId: ThreadId,
  worktreePath: string,
  turnCount: number,
  checkpointId?: string,
): CheckpointRef {
  const attachment =
    checkpointId === undefined ? "" : `/attachment/${Encoding.encodeBase64Url(checkpointId)}`;
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/worktree/${Encoding.encodeBase64Url(worktreePath)}${attachment}/turn/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
