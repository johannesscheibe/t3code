import type { OrchestrationV2AppThread, OrchestrationV2CheckpointScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { CheckoutRestoreTarget } from "./CheckpointService.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.";

export const ATTACHED_CHECKOUT_RESTORE_MESSAGE =
  "File restore requires every attached checkout to be a worktree only this thread uses, attached before the turn you rewind to. Rewind the conversation without restoring files instead.";

interface RestoreSafetyDependencies {
  readonly fileSystem: FileSystem.FileSystem;
  readonly projections: ProjectionStoreV2["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly path: Path.Path;
}

/** Whether no other thread works in or around `cwd`, which must already be a real path. */
const isUsedOnlyBy = Effect.fn("orchestrationV2.isUsedOnlyBy")(function* (
  threadId: OrchestrationV2AppThread["id"],
  cwd: string,
  dependencies: RestoreSafetyDependencies,
) {
  const { fileSystem, projections, projects, path } = dependencies;
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  const projectRoot = (projectId: OrchestrationV2AppThread["projectId"]) =>
    projects
      .get(projectId, { includeDeleted: true })
      .pipe(Effect.map(Option.map((project) => project.workspaceRoot)));
  const shell = yield* projections.getShellSnapshot();
  const checkedPaths = new Set<string>();
  for (const otherThread of [...shell.threads, ...shell.archivedThreads]) {
    if (otherThread.id === threadId || otherThread.deletedAt !== null) continue;
    const other = yield* projections.getCheckpointContext(otherThread.id);
    const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
    const paths = [
      otherThread.worktreePath,
      ...other.checkpointScopes.map((candidate) => candidate.cwd),
      // A failed turn can leave an errored session with a live event stream.
      // A session shared across threads keeps the cwd it was opened with,
      // often another thread's; each turn runs in the thread's own
      // worktree or project root, which this list already covers.
      ...providerContext.providerSessions
        .filter(
          (session) =>
            session.status !== "stopped" &&
            !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
        )
        .map((session) => session.cwd),
    ].filter((value): value is string => value !== null);
    // A thread without a worktree works in its project's checkout, and so
    // does each of its attached project roots.
    for (const projectId of [
      ...(otherThread.worktreePath === null ? [otherThread.projectId] : []),
      ...(otherThread.attachedCheckouts ?? []).flatMap((checkout) =>
        checkout.worktreePath === null ? [checkout.projectId] : [],
      ),
    ]) {
      const root = yield* projectRoot(projectId);
      if (Option.isNone(root)) return false;
      paths.push(root.value);
    }
    for (const checkout of otherThread.attachedCheckouts ?? []) {
      if (checkout.worktreePath !== null) paths.push(checkout.worktreePath);
    }
    for (const candidate of paths) {
      if (checkedPaths.has(candidate)) continue;
      checkedPaths.add(candidate);
      const otherCwd = yield* fileSystem
        .realPath(candidate)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
      if (otherCwd !== null && (contains(cwd, otherCwd) || contains(otherCwd, cwd))) {
        return false;
      }
    }
  }
  return true;
});

// A checkpoint snapshots the whole checkout. Check at command admission and
// again before provider rollback so a newly shared worktree is rejected too.
export const isCheckpointRestoreIsolated = Effect.fn("orchestrationV2.isCheckpointRestoreIsolated")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    dependencies: RestoreSafetyDependencies,
  ) {
    if (thread.worktreePath == null) return false;
    const cwd = yield* dependencies.fileSystem.realPath(scope.cwd);
    if (cwd !== (yield* dependencies.fileSystem.realPath(thread.worktreePath))) return false;
    return yield* isUsedOnlyBy(thread.id, cwd, dependencies);
  },
);

/**
 * Whether every attached checkout can be restored with the thread's own
 * workspace: each is a worktree no other thread uses, and has a ref for the
 * target. Checked with isCheckpointRestoreIsolated, before anything changes.
 */
export const areAttachedCheckoutsRestorable = Effect.fn(
  "orchestrationV2.areAttachedCheckoutsRestorable",
)(function* (
  thread: Pick<OrchestrationV2AppThread, "id">,
  targets: ReadonlyArray<CheckoutRestoreTarget & { readonly available: boolean }>,
  dependencies: RestoreSafetyDependencies,
) {
  for (const target of targets) {
    if (!target.available || target.root.checkout.worktreePath === null) return false;
    const cwd = yield* dependencies.fileSystem.realPath(target.root.cwd);
    if (!(yield* isUsedOnlyBy(thread.id, cwd, dependencies))) return false;
  }
  return true;
});
