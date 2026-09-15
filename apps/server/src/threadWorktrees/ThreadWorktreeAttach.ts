import * as NodeCrypto from "node:crypto";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";

import {
  CommandId,
  ThreadWorktreeAttachError,
  type ThreadWorktreeAttachInput,
  type ThreadWorktreeAttachResult,
  type ThreadWorktreeLinkSource,
} from "@t3tools/contracts";
import {
  normalizeThreadWorktreePath,
  threadWorktreeKeysEqual,
  threadWorktrees,
} from "@t3tools/shared/threadWorktrees";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadWorktreeTurn } from "../checkpointing/Utils.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";

const attachError = (detail: string) => new ThreadWorktreeAttachError({ detail });
const attachFailure = (detail: string) => (cause: unknown) =>
  new ThreadWorktreeAttachError({ detail, cause });

/**
 * Attaches a worktree of another project to a thread. An existing checkout is
 * attached as is; otherwise a new worktree is created from the project's root
 * and removed again if the link cannot be recorded. Shared by the websocket
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

  return Effect.fn("ThreadWorktreeAttach.attach")(function* (
    input: ThreadWorktreeAttachInput,
    source: ThreadWorktreeLinkSource,
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
        `This thread already works in ${project.title}. Attach a worktree of another project.`,
      );
    }

    const checkpointContext = yield* snapshots.getThreadCheckpointContext(input.threadId).pipe(
      Effect.mapError(attachFailure("Could not read the thread's checkpoint context.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(attachError("The thread's primary project was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const primaryCwd = thread.worktreePath ?? checkpointContext.workspaceRoot;
    if (
      !(yield* checkpoints
        .isGitRepository(primaryCwd)
        .pipe(Effect.mapError(attachFailure("Could not inspect the thread's primary workspace."))))
    ) {
      return yield* attachError(
        "Attaching worktrees requires a Git primary workspace so changes can be checkpointed and reverted.",
      );
    }

    const attached = threadWorktrees(thread).find((link) => link.projectId === input.projectId);
    if (attached !== undefined) {
      // The agent asks for "a worktree of project B"; handing back the one the
      // thread already has is the outcome it wants, not an error.
      if (
        input.worktreePath === undefined ||
        threadWorktreeKeysEqual(attached, { worktreePath: input.worktreePath })
      ) {
        return { link: attached } satisfies ThreadWorktreeAttachResult;
      }
      return yield* attachError(
        `This thread already has a worktree of ${project.title} attached at ${attached.worktreePath}.`,
      );
    }

    const checkout =
      input.worktreePath !== undefined
        ? yield* Effect.gen(function* () {
            const requestedPath = input.worktreePath!;
            const repository = yield* registry
              .resolve({ cwd: requestedPath })
              .pipe(Effect.mapError(attachFailure(`Could not inspect ${requestedPath}.`)));
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
            const canonicalPath = (cwd: string, value: string) =>
              fs
                .realPath(path.resolve(cwd, value))
                .pipe(
                  Effect.mapError(
                    attachFailure("Could not resolve the checkout's repository paths."),
                  ),
                );
            const commonDir = yield* canonicalPath(
              requestedPath,
              repository.repository.metadataPath,
            );
            const selectedCommonDir = yield* canonicalPath(
              project.workspaceRoot,
              selected.repository.metadataPath,
            );
            if (commonDir !== selectedCommonDir) {
              return yield* attachError(
                `The checkout does not belong to ${project.title}'s Git repository.`,
              );
            }
            const canonicalWorktreePath = yield* canonicalPath(
              requestedPath,
              repository.repository.rootPath,
            );
            const canonicalProjectRoot = yield* canonicalPath(
              project.workspaceRoot,
              selected.repository.rootPath,
            );
            // Keep the registered spelling for the project workspace. Clients
            // can recognize it as protected even when it contains symlinks.
            const worktreePath = normalizeThreadWorktreePath(
              canonicalWorktreePath === canonicalProjectRoot
                ? project.workspaceRoot
                : canonicalWorktreePath,
            );
            const status = yield* git
              .status({ cwd: worktreePath })
              .pipe(Effect.mapError(attachFailure(`Could not read ${worktreePath}.`)));
            if (!status.isRepo) {
              return yield* attachError(`${worktreePath} is not a Git checkout.`);
            }
            return { worktreePath, branch: status.refName, created: false };
          })
        : yield* Effect.gen(function* () {
            // Without a new branch git would check out the base branch, which the
            // project's own checkout usually holds already.
            const newBranch = input.branch;
            if (newBranch === undefined) {
              return yield* attachError(
                `Pass a branch name for the new worktree of ${project.title}.`,
              );
            }
            const baseBranch =
              input.baseBranch ??
              (yield* git
                .status({ cwd: project.workspaceRoot })
                .pipe(Effect.mapError(attachFailure(`Could not read ${project.workspaceRoot}.`))))
                .refName;
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
                newRefName: newBranch,
                path: null,
              })
              .pipe(
                Effect.mapError(attachFailure(`Could not create a worktree of ${project.title}.`)),
              );
            return {
              worktreePath: normalizeThreadWorktreePath(created.worktree.path),
              branch: created.worktree.refName,
              created: true,
            };
          });

    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Effect.gen(function* () {
      // Capture before publishing the link or starting setup. Agents and clients
      // must never observe an attachment whose baseline still includes future edits.
      const turnCount = checkpointContext.checkpoints.reduce(
        (count, checkpoint) => Math.max(count, checkpoint.checkpointTurnCount),
        0,
      );
      const checkpointRef = checkpointRefForThreadWorktreeTurn(
        input.threadId,
        checkout.worktreePath,
        turnCount,
        uuid,
      );
      if (!(yield* checkpoints.hasCheckpointRef({ cwd: checkout.worktreePath, checkpointRef }))) {
        yield* checkpoints.captureCheckpoint({ cwd: checkout.worktreePath, checkpointRef });
      }
      yield* engine.dispatch({
        type: "thread.worktree.attach",
        commandId: CommandId.make(`server:thread-worktree-attach:${input.threadId}:${uuid}`),
        threadId: input.threadId,
        worktreePath: checkout.worktreePath,
        projectId: input.projectId,
        branch: checkout.branch,
        source,
        checkpointId: uuid,
      });
    }).pipe(
      Effect.mapError(attachFailure("Could not attach the worktree to the thread.")),
      Effect.onError(() =>
        checkout.created
          ? git
              .removeWorktree({
                cwd: project.workspaceRoot,
                path: checkout.worktreePath,
                force: true,
              })
              .pipe(Effect.ignoreCause({ log: true }))
          : Effect.void,
      ),
    );

    if (checkout.created && input.runSetupScript === true) {
      // The link is already recorded; a failed setup script leaves a usable
      // worktree the user can finish setting up from its terminal.
      yield* setupScripts
        .runForThread({
          threadId: input.threadId,
          projectId: input.projectId,
          projectCwd: project.workspaceRoot,
          preferredTerminalId: `setup-worktree-${NodeCrypto.createHash("sha256").update(checkout.worktreePath).digest("hex")}`,
          worktreePath: checkout.worktreePath,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("setup script for attached worktree failed", {
              threadId: input.threadId,
              worktreePath: checkout.worktreePath,
              cause,
            }),
          ),
        );
    }

    const recorded = yield* snapshots.getThreadShellById(input.threadId).pipe(
      Effect.map((shell) =>
        Option.flatMap(shell, (value) =>
          Option.fromNullishOr(
            threadWorktrees(value).find((link) =>
              threadWorktreeKeysEqual(link, { worktreePath: checkout.worktreePath }),
            ),
          ),
        ),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(recorded)) {
      return { link: recorded.value } satisfies ThreadWorktreeAttachResult;
    }
    return {
      link: {
        worktreePath: checkout.worktreePath,
        projectId: input.projectId,
        branch: checkout.branch,
        source,
        linkedAt: DateTime.formatIso(yield* DateTime.now),
        checkpointId: uuid,
      },
    } satisfies ThreadWorktreeAttachResult;
  });
});

export type ThreadWorktreeAttach = Effect.Success<typeof make>;
