import {
  McpCapabilityUnavailableError,
  ThreadWorktreeLinkSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  GitWorkflowService.GitWorkflowService,
  ProjectSetupScriptRunner.ProjectSetupScriptRunner,
];

export class WorktreeThreadNotFoundError extends Schema.TaggedError<WorktreeThreadNotFoundError>()(
  "WorktreeThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class WorktreeProjectNotFoundError extends Schema.TaggedError<WorktreeProjectNotFoundError>()(
  "WorktreeProjectNotFoundError",
  { project: Schema.String },
) {
  override get message(): string {
    return `No project matches "${this.project}". Call list_thread_worktrees for the projects you can attach.`;
  }
}

export class WorktreeProjectAmbiguousError extends Schema.TaggedError<WorktreeProjectAmbiguousError>()(
  "WorktreeProjectAmbiguousError",
  { project: Schema.String },
) {
  override get message(): string {
    return `Several projects are named "${this.project}". Pass the project's workspace root instead.`;
  }
}

export class WorktreeAttachFailedError extends Schema.TaggedError<WorktreeAttachFailedError>()(
  "WorktreeAttachFailedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class WorktreeDetachFailedError extends Schema.TaggedError<WorktreeDetachFailedError>()(
  "WorktreeDetachFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not detach the worktree.";
  }
}

export class WorktreeListFailedError extends Schema.TaggedError<WorktreeListFailedError>()(
  "WorktreeListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the thread's worktrees.";
  }
}

export const WorktreeToolError = Schema.Union([
  McpCapabilityUnavailableError,
  WorktreeThreadNotFoundError,
  WorktreeProjectNotFoundError,
  WorktreeProjectAmbiguousError,
  WorktreeAttachFailedError,
  WorktreeDetachFailedError,
  WorktreeListFailedError,
]);
export type WorktreeToolError = typeof WorktreeToolError.Type;

export const AttachWorktreeInput = Schema.Struct({
  project: TrimmedNonEmptyString.annotate({
    description:
      "The project to work in: its title or its workspace root path, as listed by list_thread_worktrees.",
  }),
  branch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch to create for the new worktree. Defaults to this thread's branch so related changes share a name. Pass one during the thread's first turn, while its branch has only a placeholder name.",
    }),
  ),
  baseBranch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Branch the new worktree starts from. Defaults to the project's current branch.",
    }),
  ),
});
export type AttachWorktreeInput = typeof AttachWorktreeInput.Type;

export const AttachWorktreeResult = Schema.Struct({
  project: Schema.String,
  worktreePath: Schema.String.annotate({ description: "Make this project's changes here." }),
  branch: Schema.NullOr(Schema.String),
  alreadyAttached: Schema.Boolean.annotate({
    description: "True when this thread already had a worktree of the project.",
  }),
});
export type AttachWorktreeResult = typeof AttachWorktreeResult.Type;

export const DetachWorktreeInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString.annotate({
    description: "Path of the attached worktree, as listed by list_thread_worktrees.",
  }),
});
export type DetachWorktreeInput = typeof DetachWorktreeInput.Type;

export const DetachWorktreeResult = Schema.Struct({
  worktreePath: Schema.String,
  wasAttached: Schema.Boolean.annotate({
    description: "False when the worktree was not attached to this thread to begin with.",
  }),
});
export type DetachWorktreeResult = typeof DetachWorktreeResult.Type;

export const ListThreadWorktreesResult = Schema.Struct({
  primary: Schema.NullOr(
    Schema.Struct({
      project: Schema.String,
      path: Schema.String,
      branch: Schema.NullOr(Schema.String),
    }),
  ),
  attached: Schema.Array(
    Schema.Struct({
      project: Schema.String,
      worktreePath: Schema.String,
      branch: Schema.NullOr(Schema.String),
      source: ThreadWorktreeLinkSource,
    }),
  ),
  attachableProjects: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      workspaceRoot: Schema.String,
    }),
  ),
});
export type ListThreadWorktreesResult = typeof ListThreadWorktreesResult.Type;

const AttachWorktreeTool = Tool.make("attach_worktree", {
  description:
    "Attach a worktree of another project to this thread when your work needs changes there. Creates a worktree on a new branch (or reuses the one this thread already has) and returns its path. Make that project's changes in the returned path, not in its main checkout.",
  parameters: AttachWorktreeInput,
  success: AttachWorktreeResult,
  failure: WorktreeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Attach worktree to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DetachWorktreeTool = Tool.make("detach_worktree", {
  description:
    "Detach a worktree from this thread. The worktree stays on disk. Only detach when the user asks.",
  parameters: DetachWorktreeInput,
  success: DetachWorktreeResult,
  failure: WorktreeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Detach worktree from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadWorktreesTool = Tool.make("list_thread_worktrees", {
  description:
    "List this thread's primary workspace, the worktrees attached to it, and the other projects you can attach with attach_worktree.",
  success: ListThreadWorktreesResult,
  failure: WorktreeToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread worktrees")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const WorktreesToolkit = Toolkit.make(
  AttachWorktreeTool,
  DetachWorktreeTool,
  ListThreadWorktreesTool,
);
