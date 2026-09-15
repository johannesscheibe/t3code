import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestState } from "./pullRequest.ts";

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
/** The pull request of an attached worktree's branch, as last detected on its host. */
export const ThreadWorktreePullRequest = Schema.Struct({
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  state: PullRequestState,
});
export type ThreadWorktreePullRequest = typeof ThreadWorktreePullRequest.Type;

export const ThreadWorktreeLink = Schema.Struct({
  ...ThreadWorktreeKey.fields,
  projectId: ProjectId,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  source: ThreadWorktreeLinkSource,
  linkedAt: IsoDateTime,
  // Absent on legacy links, which retain their original path-based checkpoint refs.
  checkpointId: Schema.optional(TrimmedNonEmptyString),
  // Maintained by the server like a thread's branch pull request. Optional so
  // links recorded before detection still decode.
  pullRequest: Schema.optional(Schema.NullOr(ThreadWorktreePullRequest)),
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
