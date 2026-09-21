import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadCheckoutAttach from "../../../threadCheckouts/ThreadCheckoutAttach.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type CheckoutMode,
  CheckoutAttachFailedError,
  CheckoutDetachFailedError,
  CheckoutListFailedError,
  CheckoutProjectAmbiguousError,
  CheckoutProjectNotFoundError,
  CheckoutThreadNotFoundError,
  CheckoutsToolkit,
  type ListThreadCheckoutsResult,
} from "./tools.ts";

const withoutTrailingSeparators = (value: string) => value.trim().replace(/(?<=.)[\\/]+$/, "");

/**
 * Agents name projects the way they see them: by title or by the directory
 * they live in. A workspace root match is exact; a title match must be unique.
 */
const resolveProject = Effect.fn("CheckoutsToolkit.resolveProject")(function* (
  reference: string,
  projects: ReadonlyArray<OrchestrationProjectShell>,
) {
  const path = withoutTrailingSeparators(reference);
  const byRoot = projects.find(
    (project) => withoutTrailingSeparators(project.workspaceRoot) === path,
  );
  if (byRoot !== undefined) return byRoot;
  const title = reference.trim().toLowerCase();
  const byTitle = projects.filter((project) => project.title.toLowerCase() === title);
  if (byTitle.length > 1) return yield* new CheckoutProjectAmbiguousError({ project: reference });
  if (byTitle.length === 0) return yield* new CheckoutProjectNotFoundError({ project: reference });
  return byTitle[0]!;
});

const modeOf = (workspace: { readonly worktreePath: string | null }): CheckoutMode =>
  workspace.worktreePath === null ? "local" : "worktree";

/** What list_thread_checkouts reports; exported so the shape is testable without a layer. */
export function listThreadCheckouts(
  thread: Pick<OrchestrationThreadShell, "projectId" | "branch" | "worktreePath" | "checkouts">,
  projects: ReadonlyArray<OrchestrationProjectShell>,
): ListThreadCheckoutsResult {
  const projectOf = (projectId: string) => projects.find((project) => project.id === projectId);
  const summarize = (workspace: {
    readonly projectId: string;
    readonly worktreePath: string | null;
    readonly branch: string | null;
  }) => {
    const project = projectOf(workspace.projectId);
    const path = workspace.worktreePath ?? project?.workspaceRoot;
    return path === undefined
      ? null
      : {
          project: project?.title ?? workspace.projectId,
          path,
          mode: modeOf(workspace),
          branch: workspace.branch,
        };
  };
  return {
    workspace: summarize(thread),
    attached: thread.checkouts.flatMap((checkout) => {
      const summary = summarize(checkout);
      return summary === null ? [] : [{ ...summary, source: checkout.source }];
    }),
    attachableProjects: projects
      .filter(
        (project) =>
          project.id !== thread.projectId &&
          !thread.checkouts.some((checkout) => checkout.projectId === project.id),
      )
      .map((project) => ({ title: project.title, workspaceRoot: project.workspaceRoot })),
  };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const attach = yield* ThreadCheckoutAttach.make;

  const requireThread = <E>(onReadFailure: (cause: unknown) => E) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("checkouts");
      const thread = yield* snapshots
        .getThreadShellById(scope.threadId)
        .pipe(Effect.mapError(onReadFailure));
      if (Option.isNone(thread)) {
        return yield* new CheckoutThreadNotFoundError({ threadId: scope.threadId });
      }
      return thread.value;
    });

  return CheckoutsToolkit.of({
    attach_checkout: (input) =>
      Effect.gen(function* () {
        const readFailed = () =>
          new CheckoutAttachFailedError({ detail: "Could not read this thread's projects." });
        const thread = yield* requireThread(readFailed);
        const projects = yield* snapshots.getProjectShells().pipe(Effect.mapError(readFailed));
        const project = yield* resolveProject(input.project, projects);
        const alreadyAttached = thread.checkouts.some(
          (checkout) => checkout.projectId === project.id,
        );
        // The agent works the way the user set this thread up: in the project's
        // checkout for a local thread, in a new worktree for a worktree thread.
        const mode = input.mode ?? modeOf(thread);
        const { checkout } = yield* attach(
          {
            threadId: thread.id,
            projectId: project.id,
            target:
              mode === "local"
                ? { type: "local" }
                : {
                    type: "new-worktree",
                    ...(input.branch === undefined ? {} : { branch: input.branch }),
                    ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
                    runSetupScript: true,
                  },
          },
          "agent",
        ).pipe(
          Effect.mapError((error) => new CheckoutAttachFailedError({ detail: error.message })),
        );
        return {
          project: project.title,
          path: checkout.worktreePath ?? project.workspaceRoot,
          mode: modeOf(checkout),
          branch: checkout.branch,
          alreadyAttached,
        };
      }),
    detach_checkout: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread((cause) => new CheckoutDetachFailedError({ cause }));
        const projects = yield* snapshots
          .getProjectShells()
          .pipe(Effect.mapError((cause) => new CheckoutDetachFailedError({ cause })));
        const project = yield* resolveProject(input.project, projects);
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const wasAttached = yield* engine
          .dispatch({
            type: "thread.checkout.detach",
            commandId: CommandId.make(`server:mcp-checkout-detach:${thread.id}:${uuid}`),
            threadId: thread.id,
            projectId: project.id,
          })
          .pipe(
            Effect.as(true),
            // Detaching a checkout that is not attached is the outcome the agent asked for.
            Effect.catchTags({ OrchestrationCommandInvariantError: () => Effect.succeed(false) }),
            Effect.mapError((cause) => new CheckoutDetachFailedError({ cause })),
          );
        return { project: project.title, wasAttached };
      }),
    list_thread_checkouts: () =>
      Effect.gen(function* () {
        const thread = yield* requireThread((cause) => new CheckoutListFailedError({ cause }));
        const projects = yield* snapshots
          .getProjectShells()
          .pipe(Effect.mapError((cause) => new CheckoutListFailedError({ cause })));
        return listThreadCheckouts(thread, projects);
      }),
  });
});

export const CheckoutsToolkitHandlersLive = CheckoutsToolkit.toLayer(make);
