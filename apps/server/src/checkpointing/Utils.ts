import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

/**
 * Checkpoint ref for a checkout attached to a thread, written in the checkout's
 * repository. The attachment's checkpoint ID keeps refs apart when threads share
 * a checkout, and lets a detached checkout start a fresh baseline when reattached.
 */
export function checkpointRefForThreadCheckoutTurn(
  threadId: ThreadId,
  checkpointId: string,
  turnCount: number,
): CheckpointRef {
  return CheckpointRef.make(
    `${checkpointRefPrefixForThreadCheckout(threadId, checkpointId)}${turnCount}`,
  );
}

/** Ref prefix holding every turn ref of one attachment, for listing them in one Git call. */
export function checkpointRefPrefixForThreadCheckout(
  threadId: ThreadId,
  checkpointId: string,
): string {
  return `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/checkout/${Encoding.encodeBase64Url(checkpointId)}/turn/`;
}

/** Turn counts of the refs listed below an attachment's prefix, ascending. */
export function turnCountsOfCheckpointRefs(
  checkpointRefs: ReadonlyArray<CheckpointRef>,
): ReadonlyArray<number> {
  return checkpointRefs
    .map((checkpointRef) => Number(checkpointRef.slice(checkpointRef.lastIndexOf("/") + 1)))
    .filter(Number.isInteger)
    .toSorted((left, right) => left - right);
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
