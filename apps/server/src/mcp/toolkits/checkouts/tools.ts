import {
  McpCapabilityUnavailableError,
  ThreadCheckoutSource,
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

export class CheckoutThreadNotFoundError extends Schema.TaggedError<CheckoutThreadNotFoundError>()(
  "CheckoutThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class CheckoutProjectNotFoundError extends Schema.TaggedError<CheckoutProjectNotFoundError>()(
  "CheckoutProjectNotFoundError",
  { project: Schema.String },
) {
  override get message(): string {
    return `No project matches "${this.project}". Call list_thread_checkouts for the projects you can attach.`;
  }
}

export class CheckoutProjectAmbiguousError extends Schema.TaggedError<CheckoutProjectAmbiguousError>()(
  "CheckoutProjectAmbiguousError",
  { project: Schema.String },
) {
  override get message(): string {
    return `Several projects are named "${this.project}". Pass the project's workspace root instead.`;
  }
}

export class CheckoutAttachFailedError extends Schema.TaggedError<CheckoutAttachFailedError>()(
  "CheckoutAttachFailedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class CheckoutDetachFailedError extends Schema.TaggedError<CheckoutDetachFailedError>()(
  "CheckoutDetachFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not detach the checkout.";
  }
}

export class CheckoutListFailedError extends Schema.TaggedError<CheckoutListFailedError>()(
  "CheckoutListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the thread's checkouts.";
  }
}

export const CheckoutToolError = Schema.Union([
  McpCapabilityUnavailableError,
  CheckoutThreadNotFoundError,
  CheckoutProjectNotFoundError,
  CheckoutProjectAmbiguousError,
  CheckoutAttachFailedError,
  CheckoutDetachFailedError,
  CheckoutListFailedError,
]);
export type CheckoutToolError = typeof CheckoutToolError.Type;

/** How a checkout relates to its project: the project's own checkout, or a worktree. */
export const CheckoutMode = Schema.Literals(["local", "worktree"]);
export type CheckoutMode = typeof CheckoutMode.Type;

const ProjectReference = TrimmedNonEmptyString.annotate({
  description:
    "The project: its title or its workspace root path, as listed by list_thread_checkouts.",
});

export const AttachCheckoutInput = Schema.Struct({
  project: ProjectReference,
  mode: Schema.optional(
    CheckoutMode.annotate({
      description:
        "local attaches the project's own checkout; worktree creates a new worktree on a new branch. Defaults to the kind of workspace this thread uses.",
    }),
  ),
  branch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Worktree mode only: branch to create. Defaults to this thread's branch so related changes share a name, or to a placeholder name when that is taken or the thread's own branch is still a placeholder.",
    }),
  ),
  baseBranch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Worktree mode only: branch the new worktree starts from. Defaults to the project's current branch.",
    }),
  ),
});
export type AttachCheckoutInput = typeof AttachCheckoutInput.Type;

export const AttachCheckoutResult = Schema.Struct({
  project: Schema.String,
  path: Schema.String.annotate({ description: "Make this project's changes here." }),
  mode: CheckoutMode,
  branch: Schema.NullOr(Schema.String),
  alreadyAttached: Schema.Boolean.annotate({
    description: "True when this thread already had a checkout of the project.",
  }),
});
export type AttachCheckoutResult = typeof AttachCheckoutResult.Type;

export const DetachCheckoutInput = Schema.Struct({
  project: ProjectReference,
});
export type DetachCheckoutInput = typeof DetachCheckoutInput.Type;

export const DetachCheckoutResult = Schema.Struct({
  project: Schema.String,
  wasAttached: Schema.Boolean.annotate({
    description: "False when the project had no checkout attached to this thread to begin with.",
  }),
});
export type DetachCheckoutResult = typeof DetachCheckoutResult.Type;

const CheckoutSummary = Schema.Struct({
  project: Schema.String,
  path: Schema.String,
  mode: CheckoutMode,
  branch: Schema.NullOr(Schema.String),
});

export const ListThreadCheckoutsResult = Schema.Struct({
  workspace: Schema.NullOr(CheckoutSummary),
  attached: Schema.Array(
    Schema.Struct({
      ...CheckoutSummary.fields,
      source: ThreadCheckoutSource,
    }),
  ),
  attachableProjects: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      workspaceRoot: Schema.String,
    }),
  ),
});
export type ListThreadCheckoutsResult = typeof ListThreadCheckoutsResult.Type;

const AttachCheckoutTool = Tool.make("attach_checkout", {
  description:
    "Attach a checkout of another project to this thread when your work needs changes there: the project's own checkout, or a new worktree on a new branch. Returns the existing checkout if the thread already has one for that project. Make that project's changes in the returned path.",
  parameters: AttachCheckoutInput,
  success: AttachCheckoutResult,
  failure: CheckoutToolError,
  dependencies,
})
  .annotate(Tool.Title, "Attach checkout to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DetachCheckoutTool = Tool.make("detach_checkout", {
  description:
    "Detach a project's checkout from this thread. The files stay on disk. Only detach when the user asks.",
  parameters: DetachCheckoutInput,
  success: DetachCheckoutResult,
  failure: CheckoutToolError,
  dependencies,
})
  .annotate(Tool.Title, "Detach checkout from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadCheckoutsTool = Tool.make("list_thread_checkouts", {
  description:
    "List this thread's own workspace, the checkouts attached to it, and the other projects you can attach with attach_checkout.",
  success: ListThreadCheckoutsResult,
  failure: CheckoutToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread checkouts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CheckoutsToolkit = Toolkit.make(
  AttachCheckoutTool,
  DetachCheckoutTool,
  ListThreadCheckoutsTool,
);
