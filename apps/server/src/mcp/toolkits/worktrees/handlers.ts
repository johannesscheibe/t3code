import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { normalizeThreadWorktreePath, threadWorktrees } from "@t3tools/shared/threadWorktrees";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadWorktreeAttach from "../../../threadWorktrees/ThreadWorktreeAttach.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type ListThreadWorktreesResult,
  WorktreeAttachFailedError,
  WorktreeDetachFailedError,
  WorktreeListFailedError,
  WorktreeProjectAmbiguousError,
  WorktreeProjectNotFoundError,
  WorktreeThreadNotFoundError,
  WorktreesToolkit,
} from "./tools.ts";

/**
 * Agents name projects the way they see them: by title or by the directory
 * they live in. A workspace root match is exact; a title match must be unique.
 */
const resolveProject = Effect.fn("WorktreesToolkit.resolveProject")(function* (
  reference: string,
  projects: ReadonlyArray<OrchestrationProjectShell>,
) {
  const path = normalizeThreadWorktreePath(reference);
  const byRoot = projects.find(
    (project) => normalizeThreadWorktreePath(project.workspaceRoot) === path,
  );
  if (byRoot !== undefined) return byRoot;
  const title = reference.trim().toLowerCase();
  const byTitle = projects.filter((project) => project.title.toLowerCase() === title);
  if (byTitle.length > 1) return yield* new WorktreeProjectAmbiguousError({ project: reference });
  if (byTitle.length === 0) return yield* new WorktreeProjectNotFoundError({ project: reference });
  return byTitle[0]!;
});

/** What list_thread_worktrees reports; exported so the shape is testable without a layer. */
export function listThreadWorktrees(
  thread: Pick<OrchestrationThreadShell, "projectId" | "branch" | "worktreePath" | "worktrees">,
  projects: ReadonlyArray<OrchestrationProjectShell>,
): ListThreadWorktreesResult {
  const titleOf = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.title ?? projectId;
  const primaryProject = projects.find((project) => project.id === thread.projectId);
  const primaryPath = thread.worktreePath ?? primaryProject?.workspaceRoot ?? null;
  const attached = threadWorktrees(thread);
  return {
    primary:
      primaryPath === null
        ? null
        : { project: titleOf(thread.projectId), path: primaryPath, branch: thread.branch },
    attached: attached.map((link) => ({
      project: titleOf(link.projectId),
      worktreePath: link.worktreePath,
      branch: link.branch,
      source: link.source,
    })),
    attachableProjects: projects
      .filter(
        (project) =>
          project.id !== thread.projectId &&
          !attached.some((link) => link.projectId === project.id),
      )
      .map((project) => ({ title: project.title, workspaceRoot: project.workspaceRoot })),
  };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const attach = yield* ThreadWorktreeAttach.make;

  const requireThread = <E>(onReadFailure: (cause: unknown) => E) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("worktrees");
      const thread = yield* snapshots
        .getThreadShellById(scope.threadId)
        .pipe(Effect.mapError(onReadFailure));
      if (Option.isNone(thread)) {
        return yield* new WorktreeThreadNotFoundError({ threadId: scope.threadId });
      }
      return thread.value;
    });

  return WorktreesToolkit.of({
    attach_worktree: (input) =>
      Effect.gen(function* () {
        const readFailed = () =>
          new WorktreeAttachFailedError({ detail: "Could not read this thread's projects." });
        const thread = yield* requireThread(readFailed);
        const projects = yield* snapshots.getProjectShells().pipe(Effect.mapError(readFailed));
        const project = yield* resolveProject(input.project, projects);
        const alreadyAttached = threadWorktrees(thread).some(
          (link) => link.projectId === project.id,
        );
        // Related changes across repositories read best on one branch name. During
        // the first turn the thread's branch is a placeholder that gets renamed
        // later, so it is not copied into another repository.
        const threadBranch =
          thread.branch !== null && !isTemporaryWorktreeBranch(thread.branch)
            ? thread.branch
            : undefined;
        const branch = input.branch ?? threadBranch;
        const { link } = yield* attach(
          {
            threadId: thread.id,
            projectId: project.id,
            ...(branch === undefined ? {} : { branch }),
            ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
            runSetupScript: true,
          },
          "agent",
        ).pipe(
          Effect.mapError((error) => new WorktreeAttachFailedError({ detail: error.message })),
        );
        return {
          project: project.title,
          worktreePath: link.worktreePath,
          branch: link.branch,
          alreadyAttached,
        };
      }),
    detach_worktree: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread((cause) => new WorktreeDetachFailedError({ cause }));
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const wasAttached = yield* engine
          .dispatch({
            type: "thread.worktree.detach",
            commandId: CommandId.make(`server:mcp-worktree-detach:${thread.id}:${uuid}`),
            threadId: thread.id,
            worktreePath: input.worktreePath,
          })
          .pipe(
            Effect.as(true),
            // Detaching a worktree that is not attached is the outcome the agent asked for.
            Effect.catchTags({ OrchestrationCommandInvariantError: () => Effect.succeed(false) }),
            Effect.mapError((cause) => new WorktreeDetachFailedError({ cause })),
          );
        return { worktreePath: input.worktreePath, wasAttached };
      }),
    list_thread_worktrees: () =>
      Effect.gen(function* () {
        const thread = yield* requireThread((cause) => new WorktreeListFailedError({ cause }));
        const projects = yield* snapshots
          .getProjectShells()
          .pipe(Effect.mapError((cause) => new WorktreeListFailedError({ cause })));
        return listThreadWorktrees(thread, projects);
      }),
  });
});

export const WorktreesToolkitHandlersLive = WorktreesToolkit.toLayer(make);
