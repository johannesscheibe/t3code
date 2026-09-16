import * as NodeCrypto from "node:crypto";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";

import {
  CommandId,
  ThreadCheckoutAttachError,
  type ThreadCheckoutAttachInput,
  type ThreadCheckoutAttachResult,
  type ThreadCheckoutSource,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadCheckoutTurn } from "../checkpointing/Utils.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";

const attachError = (detail: string) => new ThreadCheckoutAttachError({ detail });
const attachFailure = (detail: string) => (cause: unknown) =>
  new ThreadCheckoutAttachError({ detail, cause });

/**
 * Attaches a checkout of another project to a thread: the project's own
 * checkout, an existing checkout of its repository, or a new worktree that is
 * removed again if the attachment cannot be recorded. Shared by the websocket
 * RPC and the agent's MCP tool, so both enforce the same preconditions before
 * touching the filesystem.
 */
export const make = Effect.gen(function* () {
  const git = yield* GitWorkflowService.GitWorkflowService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const crypto = yield* Crypto.Crypto;
  const checkpoints = yield* CheckpointStore;
  const registry = yield* VcsDriverRegistry;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const canonicalPath = (cwd: string, value: string) =>
    fs
      .realPath(path.resolve(cwd, value))
      .pipe(Effect.mapError(attachFailure(`Could not resolve ${value}.`)));

  return Effect.fn("ThreadCheckoutAttach.attach")(function* (
    input: ThreadCheckoutAttachInput,
    source: ThreadCheckoutSource,
  ) {
    const thread = yield* snapshots.getThreadShellById(input.threadId).pipe(
      Effect.mapError(attachFailure("Could not read the thread.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(attachError(`Thread ${input.threadId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
    const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
      Effect.mapError(attachFailure("Could not read the project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(attachError(`Project ${input.projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (input.projectId === thread.projectId) {
      return yield* attachError(
        `This thread already works in ${project.title}. Attach a checkout of another project.`,
      );
    }

    // A thread has one checkout per project. Asking again, as an agent does when
    // it needs "project B", returns the checkout the thread already has.
    const attached = thread.checkouts.find((checkout) => checkout.projectId === input.projectId);
    if (attached !== undefined) {
      return { checkout: attached } satisfies ThreadCheckoutAttachResult;
    }

    const checkpointContext = yield* snapshots.getThreadCheckpointContext(input.threadId).pipe(
      Effect.mapError(attachFailure("Could not read the thread's checkpoint context.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(attachError("The thread's own project was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const threadCwd = thread.worktreePath ?? checkpointContext.workspaceRoot;
    if (
      !(yield* checkpoints
        .isGitRepository(threadCwd)
        .pipe(Effect.mapError(attachFailure("Could not inspect the thread's workspace."))))
    ) {
      return yield* attachError(
        "Attaching checkouts requires a Git workspace so changes can be checkpointed and reverted.",
      );
    }

    const readBranch = (cwd: string) =>
      git.status({ cwd }).pipe(
        Effect.mapError(attachFailure(`Could not read ${cwd}.`)),
        Effect.flatMap((status) =>
          status.isRepo
            ? Effect.succeed(status.refName)
            : Effect.fail(attachError(`${cwd} is not a Git checkout.`)),
        ),
      );

    const target = input.target;
    const checkout = yield* Effect.gen(function* () {
      switch (target.type) {
        case "local":
          return {
            worktreePath: null,
            branch: yield* readBranch(project.workspaceRoot),
            created: false,
          };
        case "existing": {
          const repository = yield* registry
            .resolve({ cwd: target.path })
            .pipe(Effect.mapError(attachFailure(`Could not inspect ${target.path}.`)));
          const selected = yield* registry
            .resolve({ cwd: project.workspaceRoot })
            .pipe(Effect.mapError(attachFailure(`Could not inspect ${project.workspaceRoot}.`)));
          if (
            repository.kind !== "git" ||
            selected.kind !== "git" ||
            repository.repository.metadataPath === null ||
            selected.repository.metadataPath === null
          ) {
            return yield* attachError(
              "The checkout and selected project must be Git repositories.",
            );
          }
          const commonDir = yield* canonicalPath(target.path, repository.repository.metadataPath);
          const selectedCommonDir = yield* canonicalPath(
            project.workspaceRoot,
            selected.repository.metadataPath,
          );
          if (commonDir !== selectedCommonDir) {
            return yield* attachError(
              `The checkout does not belong to ${project.title}'s Git repository.`,
            );
          }
          const checkoutRoot = yield* canonicalPath(target.path, repository.repository.rootPath);
          const projectRoot = yield* canonicalPath(
            project.workspaceRoot,
            selected.repository.rootPath,
          );
          // The project's own checkout is recorded like a thread's: no worktree path.
          const worktreePath = checkoutRoot === projectRoot ? null : checkoutRoot;
          return {
            worktreePath,
            branch: yield* readBranch(worktreePath ?? project.workspaceRoot),
            created: false,
          };
        }
        case "new-worktree": {
          // Git would otherwise check out the base branch, which the project's
          // own checkout usually holds already.
          const baseBranch = target.baseBranch ?? (yield* readBranch(project.workspaceRoot));
          if (baseBranch === null) {
            return yield* attachError(
              `${project.title} has no checked-out branch to start from. Pass a base branch.`,
            );
          }
          const created = yield* git
            .createWorktree({
              cwd: project.workspaceRoot,
              refName: baseBranch,
              baseRefName: baseBranch,
              newRefName: target.branch,
              path: null,
            })
            .pipe(
              Effect.mapError(attachFailure(`Could not create a worktree of ${project.title}.`)),
            );
          return {
            worktreePath: created.worktree.path,
            branch: created.worktree.refName,
            created: true,
          };
        }
      }
    });
    const directory = checkout.worktreePath ?? project.workspaceRoot;

    // Attached checkouts live beside the thread's own workspace, never on top of it.
    if (
      !checkout.created &&
      (yield* canonicalPath(directory, ".")) === (yield* canonicalPath(threadCwd, "."))
    ) {
      return yield* attachError("That checkout is this thread's own workspace.");
    }

    const checkpointId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Effect.gen(function* () {
      // Capture before publishing the checkout or starting setup. Agents and clients
      // must never observe an attachment whose baseline already includes future edits.
      const turnCount = checkpointContext.checkpoints.reduce(
        (count, checkpoint) => Math.max(count, checkpoint.checkpointTurnCount),
        0,
      );
      yield* checkpoints.captureCheckpoint({
        cwd: directory,
        checkpointRef: checkpointRefForThreadCheckoutTurn(input.threadId, checkpointId, turnCount),
      });
      yield* engine.dispatch({
        type: "thread.checkout.attach",
        commandId: CommandId.make(
          `server:thread-checkout-attach:${input.threadId}:${checkpointId}`,
        ),
        threadId: input.threadId,
        projectId: input.projectId,
        worktreePath: checkout.worktreePath,
        branch: checkout.branch,
        source,
        checkpointId,
      });
    }).pipe(
      Effect.mapError(attachFailure("Could not attach the checkout to the thread.")),
      Effect.onError(() =>
        checkout.created
          ? git
              .removeWorktree({ cwd: project.workspaceRoot, path: directory, force: true })
              .pipe(Effect.ignoreCause({ log: true }))
          : Effect.void,
      ),
    );

    if (checkout.created && target.type === "new-worktree" && target.runSetupScript === true) {
      // The checkout is already recorded; a failed setup script leaves a usable
      // worktree the user can finish setting up from its terminal.
      yield* setupScripts
        .runForThread({
          threadId: input.threadId,
          projectId: input.projectId,
          projectCwd: project.workspaceRoot,
          preferredTerminalId: `setup-worktree-${NodeCrypto.createHash("sha256").update(directory).digest("hex")}`,
          worktreePath: directory,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("setup script for attached checkout failed", {
              threadId: input.threadId,
              worktreePath: directory,
              cause,
            }),
          ),
        );
    }

    const recorded = yield* snapshots.getThreadShellById(input.threadId).pipe(
      Effect.map((shell) =>
        Option.flatMap(shell, (value) =>
          Option.fromNullishOr(
            value.checkouts.find((entry) => entry.projectId === input.projectId),
          ),
        ),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(recorded)) {
      return { checkout: recorded.value } satisfies ThreadCheckoutAttachResult;
    }
    return {
      checkout: {
        projectId: input.projectId,
        worktreePath: checkout.worktreePath,
        branch: checkout.branch,
        pullRequest: null,
        source,
        attachedAt: DateTime.formatIso(yield* DateTime.now),
        checkpointId,
      },
    } satisfies ThreadCheckoutAttachResult;
  });
});

export type ThreadCheckoutAttach = Effect.Success<typeof make>;
