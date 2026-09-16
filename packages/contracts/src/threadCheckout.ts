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
 * Who attached a checkout to a thread: the user from the Files panel, or the
 * agent through the t3-code MCP server when its work reached another project.
 */
export const ThreadCheckoutSource = Schema.Literals(["manual", "agent"]);
export type ThreadCheckoutSource = typeof ThreadCheckoutSource.Type;

/** The pull request of an attached checkout's branch, as last detected on its host. */
export const ThreadCheckoutPullRequest = Schema.Struct({
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  state: PullRequestState,
});
export type ThreadCheckoutPullRequest = typeof ThreadCheckoutPullRequest.Type;

/**
 * A checkout of another project attached to a thread beside its own workspace.
 * It mirrors the thread's own workspace: `worktreePath` is null when the thread
 * works in the project's checkout, otherwise it names a worktree. A thread
 * attaches at most one checkout per project, so the project identifies it.
 */
export const ThreadCheckout = Schema.Struct({
  projectId: ProjectId,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  pullRequest: Schema.NullOr(ThreadCheckoutPullRequest),
  source: ThreadCheckoutSource,
  attachedAt: IsoDateTime,
  // Names this attachment's checkpoint refs, so reattaching starts a fresh baseline.
  checkpointId: TrimmedNonEmptyString,
});
export type ThreadCheckout = typeof ThreadCheckout.Type;

/**
 * What to attach: the project's own checkout, an existing checkout of its
 * repository by path, or a new worktree created from `baseBranch`.
 */
export const ThreadCheckoutAttachTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("local") }),
  Schema.Struct({ type: Schema.Literal("existing"), path: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("new-worktree"),
    branch: TrimmedNonEmptyString,
    baseBranch: Schema.optional(TrimmedNonEmptyString),
    runSetupScript: Schema.optional(Schema.Boolean),
  }),
]);
export type ThreadCheckoutAttachTarget = typeof ThreadCheckoutAttachTarget.Type;

export const ThreadCheckoutAttachInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  target: ThreadCheckoutAttachTarget,
});
export type ThreadCheckoutAttachInput = typeof ThreadCheckoutAttachInput.Type;

export const ThreadCheckoutAttachResult = Schema.Struct({
  checkout: ThreadCheckout,
});
export type ThreadCheckoutAttachResult = typeof ThreadCheckoutAttachResult.Type;

export class ThreadCheckoutAttachError extends Schema.TaggedError<ThreadCheckoutAttachError>()(
  "ThreadCheckoutAttachError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
