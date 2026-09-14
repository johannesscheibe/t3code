import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Who attached a worktree to a thread: the user from the branch toolbar, or the
 * agent through the t3-code MCP server when its work reached another repository.
 */
export const ThreadWorktreeLinkSource = Schema.Literals(["manual", "agent"]);
export type ThreadWorktreeLinkSource = typeof ThreadWorktreeLinkSource.Type;

/** Identity of an attached worktree: its absolute path on the environment. */
export const ThreadWorktreeKey = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
});
export type ThreadWorktreeKey = typeof ThreadWorktreeKey.Type;

/**
 * A worktree attached to a thread beside its primary workspace. The project is
 * the registered project whose repository the worktree belongs to; it supplies
 * scripts, the pull request host, and the one-worktree-per-project invariant.
 */
export const ThreadWorktreeLink = Schema.Struct({
  ...ThreadWorktreeKey.fields,
  projectId: ProjectId,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  source: ThreadWorktreeLinkSource,
  linkedAt: IsoDateTime,
});
export type ThreadWorktreeLink = typeof ThreadWorktreeLink.Type;

/**
 * Attach a worktree of another project to a thread. With `worktreePath` an
 * existing checkout is attached as is; without it the server creates a new
 * worktree of the project from `baseBranch`.
 */
export const ThreadWorktreeAttachInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  worktreePath: Schema.optional(TrimmedNonEmptyString),
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
  runSetupScript: Schema.optional(Schema.Boolean),
});
export type ThreadWorktreeAttachInput = typeof ThreadWorktreeAttachInput.Type;

export const ThreadWorktreeAttachResult = Schema.Struct({
  link: ThreadWorktreeLink,
});
export type ThreadWorktreeAttachResult = typeof ThreadWorktreeAttachResult.Type;

export class ThreadWorktreeAttachError extends Schema.TaggedError<ThreadWorktreeAttachError>()(
  "ThreadWorktreeAttachError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
