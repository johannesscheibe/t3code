import {
  CommandId,
  OrchestrationV2AttachCheckoutError,
  type OrchestrationV2AttachCheckoutInput,
  type OrchestrationV2RunStatus,
  type ProjectId,
  type ThreadAttachedCheckout,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { type AttachedCheckoutRoot, resolveAttachedCheckoutRoots } from "./AttachedCheckouts.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Attaches a checkout of another project to a thread: provisions it (a new
 * worktree when asked), then records it with `thread.checkout.attach`. Both the
 * client RPC and the agent's MCP tool go through here.
 */
export class ThreadCheckoutService extends Context.Service<
  ThreadCheckoutService,
  {
    /**
     * Retrying with the same commandId returns the checkout the first attempt
     * attached instead of provisioning another one.
     */
    readonly attach: (
      input: OrchestrationV2AttachCheckoutInput,
    ) => Effect.Effect<ThreadAttachedCheckout, OrchestrationV2AttachCheckoutError>;
  }
>()("t3/orchestration-v2/ThreadCheckoutService") {}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

// Runs that may still capture a checkpoint, including one waiting for its capture.
const UNCHECKPOINTED_RUN_STATUSES = new Set<OrchestrationV2RunStatus>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const failure = (message: string) => new OrchestrationV2AttachCheckoutError({ message });

const failWith = (prefix: string) =>
  Effect.mapError((error: unknown) => failure(`${prefix}: ${errorMessage(error)}`));

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Two concurrent attaches could both pass the "not attached yet" check and
  // provision a checkout each.
  const threadsInFlight = new Set<ThreadId>();

  const loadThread = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(
      failWith(`Unable to read thread ${threadId}`),
      Effect.map((projection) => projection.thread),
      Effect.filterOrFail(
        (thread) => thread.deletedAt === null,
        () => failure(`Thread ${threadId} was not found.`),
      ),
    );

  const loadProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      failWith(`Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failure(`Project ${projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const realPath = (directory: string) =>
    fileSystem.realPath(directory).pipe(Effect.orElseSucceed(() => directory));

  // Nested checkouts would be captured and restored twice.
  const overlaps = (left: string, right: string) => {
    const inside = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };
    return inside(left, right) || inside(right, left);
  };

  const attach = Effect.fn("ThreadCheckoutService.attach")(function* (
    input: OrchestrationV2AttachCheckoutInput,
  ) {
    const attachmentId = `checkout:${input.commandId}`;
    const thread = yield* loadThread(input.threadId);
    const retried = thread.attachedCheckouts?.find((checkout) => checkout.id === attachmentId);
    if (retried !== undefined) return retried;
    if (thread.archivedAt !== null) {
      return yield* failure(`Thread ${input.threadId} is archived.`);
    }
    if (input.projectId === thread.projectId) {
      return yield* failure("A thread can't attach its own project.");
    }
    if ((thread.attachedCheckouts ?? []).some((c) => c.projectId === input.projectId)) {
      return yield* failure(`Project ${input.projectId} is already attached to this thread.`);
    }
    if (threadsInFlight.has(input.threadId)) {
      return yield* failure("Another checkout is being attached to this thread.");
    }
    threadsInFlight.add(input.threadId);
    return yield* Effect.gen(function* () {
      const project = yield* loadProject(input.projectId);
      const projectRoot = project.workspaceRoot;

      if (input.workspace.type !== "worktree") {
        const directory =
          input.workspace.type === "root" ? projectRoot : input.workspace.worktreePath;
        if (!path.isAbsolute(directory)) {
          return yield* failure(`worktreePath must be absolute, got '${directory}'.`);
        }
        const resolved = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.mapError(() => failure(`'${directory}' does not exist.`)));
        const status = yield* git
          .localStatus({ cwd: directory })
          .pipe(failWith(`Unable to read '${directory}'`));
        // Only the project's own worktrees, so the checkout really is that project's.
        if (input.workspace.type === "existing_worktree") {
          const listed = yield* gitDriver
            .execute({
              operation: "ThreadCheckoutService.listWorktrees",
              cwd: projectRoot,
              args: ["worktree", "list", "--porcelain"],
            })
            .pipe(failWith("Unable to list the project's worktrees"));
          const worktrees = yield* Effect.forEach(
            listed.stdout
              .split("\n")
              .filter((line) => line.startsWith("worktree "))
              .map((line) => line.slice("worktree ".length)),
            realPath,
          );
          if (!worktrees.includes(resolved)) {
            return yield* failure(`'${directory}' is not a worktree of ${project.title}.`);
          }
          // Git lists the main checkout first. It is the project's own
          // checkout, which attaches as `root` and is never restored.
          if (worktrees[0] === resolved) {
            return yield* failure(
              `'${directory}' is ${project.title}'s main checkout; attach it as root.`,
            );
          }
        }
        const threadRoots = [
          thread.worktreePath ?? (yield* loadProject(thread.projectId)).workspaceRoot,
          ...(yield* resolveAttachedCheckoutRoots(thread, projectStore).pipe(
            failWith("Unable to read projects"),
          )).map((root) => root.cwd),
        ];
        for (const root of threadRoots) {
          if (overlaps(resolved, yield* realPath(root))) {
            return yield* failure(`'${directory}' overlaps '${root}', which this thread uses.`);
          }
        }
        const checkout: ThreadAttachedCheckout = {
          id: attachmentId,
          projectId: project.id,
          worktreePath: input.workspace.type === "root" ? null : directory,
          branch: status.isRepo ? status.refName : null,
        };
        yield* dispatchAttach(input, checkout);
        yield* ensureRecorded(input, checkout, Effect.void);
        yield* captureActiveRunBaseline(input.threadId, { checkout, cwd: directory });
        return checkout;
      }

      const workspace = input.workspace;
      const status = yield* git
        .localStatus({ cwd: projectRoot })
        .pipe(failWith("Unable to read git status"));
      if (!status.isRepo) {
        return yield* failure(`Project workspace '${projectRoot}' is not a git repository.`);
      }
      const uuid = yield* randomUuidV4;
      let branch =
        workspace.branch ?? buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
      // A plain `t3` branch makes every `t3/<hex>` ref impossible.
      if (
        workspace.branch === undefined &&
        (yield* git
          .hasCommit({ cwd: projectRoot, refName: `refs/heads/${WORKTREE_BRANCH_PREFIX}` })
          .pipe(failWith("Unable to read branches")))
      ) {
        branch = flattenTemporaryWorktreeBranchName(branch);
      }
      if (
        workspace.branch !== undefined &&
        (yield* git
          .listLocalBranchNames(projectRoot)
          .pipe(failWith("Unable to list branches"))).includes(workspace.branch)
      ) {
        return yield* failure(
          `Branch '${workspace.branch}' already exists. Attach its worktree or choose another name.`,
        );
      }
      let startRef: string = workspace.baseRef;
      if (workspace.startFromOrigin === true) {
        yield* git
          .fetchRemote({ cwd: projectRoot, remoteName: "origin", refName: workspace.baseRef })
          .pipe(failWith("Unable to fetch origin"));
        startRef = (yield* git
          .resolveRemoteTrackingCommit({
            cwd: projectRoot,
            refName: workspace.baseRef,
            fallbackRemoteName: "origin",
          })
          .pipe(failWith(`Unable to resolve '${workspace.baseRef}' on origin`))).commitSha;
      }

      // Cleanup is armed as soon as the worktree path is claimed. Before the
      // attach is dispatched any failure removes it; once dispatch starts, an
      // interrupt may have committed it, and removing a worktree the thread
      // points at is worse than leaking one.
      let claimedPath: string | null = null;
      const removeClaimed = Effect.suspend(() =>
        claimedPath === null
          ? Effect.void
          : git
              .removeWorktree({ cwd: projectRoot, path: claimedPath, force: true })
              .pipe(
                Effect.andThen(
                  git.deleteLocalBranch({ cwd: projectRoot, refName: branch, force: true }),
                ),
                Effect.ignoreCause({ log: true }),
              ),
      );
      const created = yield* git
        .createWorktree(
          {
            cwd: projectRoot,
            refName: startRef,
            newRefName: branch,
            baseRefName: workspace.baseRef,
            path: null,
          },
          {
            progress: {
              onWorktreeClaimed: (claimed) =>
                Effect.sync(() => {
                  claimedPath = claimed;
                }),
            },
          },
        )
        .pipe(
          failWith("Unable to create the worktree"),
          Effect.onError(() => removeClaimed),
        );
      claimedPath = created.worktree.path;
      const worktreePath = created.worktree.path;
      const checkout: ThreadAttachedCheckout = {
        id: attachmentId,
        projectId: project.id,
        worktreePath,
        branch: created.worktree.refName,
      };
      yield* dispatchAttach(input, checkout).pipe(
        Effect.onError((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : removeClaimed)),
      );
      // Committed: from here a failed read must not remove the worktree.
      yield* ensureRecorded(input, checkout, removeClaimed);
      yield* captureActiveRunBaseline(input.threadId, { checkout, cwd: worktreePath });
      if (input.runSetupScript ?? true) {
        yield* setupScripts
          .runForThread({
            threadId: input.threadId,
            projectId: project.id,
            projectCwd: projectRoot,
            worktreePath,
            // The thread's own setup script may run in `setup-<script>`.
            preferredTerminalId: `checkout-setup-${project.id}`,
            project: {
              id: project.id,
              workspaceRoot: project.workspaceRoot,
              scripts: project.scripts,
            },
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      return checkout;
    }).pipe(Effect.ensuring(Effect.sync(() => threadsInFlight.delete(input.threadId))));
  });

  const dispatchAttach = (
    input: OrchestrationV2AttachCheckoutInput,
    checkout: ThreadAttachedCheckout,
  ) =>
    threads
      .dispatch({
        type: "thread.checkout.attach",
        commandId: CommandId.make(input.commandId),
        threadId: input.threadId,
        checkout,
      })
      .pipe(failWith("Unable to attach the checkout"));

  // A turn under way took its baselines before this checkout was attached.
  // Without one now, the turn's edits to it would be in no turn's diff.
  const captureActiveRunBaseline = (threadId: ThreadId, root: AttachedCheckoutRoot) =>
    Effect.gen(function* () {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      yield* Effect.forEach(
        runs.filter((run) => UNCHECKPOINTED_RUN_STATUSES.has(run.status)),
        (run) =>
          checkpoints.captureCheckoutBaselines({
            threadId,
            ordinalWithinScope: run.ordinal - 1,
            checkouts: [root],
          }),
        { discard: true },
      );
    }).pipe(Effect.ignoreCause({ log: true }));

  // A retried command whose attach was since detached replays its receipt and
  // records nothing; `discard` then undoes what this attempt provisioned.
  const ensureRecorded = (
    input: OrchestrationV2AttachCheckoutInput,
    checkout: ThreadAttachedCheckout,
    discard: Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const thread = yield* loadThread(input.threadId);
      if (thread.attachedCheckouts?.some((c) => c.id === checkout.id) === true) return checkout;
      yield* discard;
      return yield* failure("This attach request already ran; the checkout was detached since.");
    });

  return ThreadCheckoutService.of({ attach });
});

export const layer = Layer.effect(ThreadCheckoutService, make);
