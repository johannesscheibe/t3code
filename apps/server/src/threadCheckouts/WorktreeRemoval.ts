import { GitCommandError, type VcsRemoveWorktreeInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * Protect registered project roots and worktrees a thread still uses at the removal
 * boundary, including filesystem aliases. Archived threads count: clients never
 * load them, so only the server can see that one still needs its workspace.
 */
export const make = Effect.gen(function* () {
  const git = yield* GitWorkflowService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isGitCommandError = Schema.is(GitCommandError);

  const existingRealPath = (value: string) =>
    fs
      .realPath(value)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
        ),
      );

  return Effect.fn("WorktreeRemoval.remove")(function* (input: VcsRemoveWorktreeInput) {
    const failure = (detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: "WorktreeRemoval.remove",
        command: "git worktree remove",
        cwd: input.cwd,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    yield* Effect.gen(function* () {
      const requestedPath = path.resolve(input.cwd, input.path);
      const target = yield* existingRealPath(requestedPath);
      const projects = yield* snapshots.getProjectShells();
      for (const project of projects) {
        const root = yield* existingRealPath(project.workspaceRoot);
        if (
          path.resolve(project.workspaceRoot) === requestedPath ||
          (target !== null && root === target)
        ) {
          return yield* failure(
            "Cannot remove a registered project's workspace. Remove the project registration first.",
          );
        }
      }
      const threads = [
        ...(yield* snapshots.getShellSnapshot()).threads,
        ...(yield* snapshots.getArchivedShellSnapshot()).threads,
      ];
      const usedPaths = new Set(
        threads.flatMap((thread) => [
          thread.worktreePath,
          ...thread.checkouts.map((checkout) => checkout.worktreePath),
        ]),
      );
      for (const usedPath of usedPaths) {
        if (usedPath === null) continue;
        if (
          path.resolve(usedPath) === requestedPath ||
          (target !== null && (yield* existingRealPath(usedPath)) === target)
        ) {
          return yield* failure(
            "A thread still uses this worktree. Delete the thread or detach the checkout first.",
          );
        }
      }
    }).pipe(
      Effect.mapError((cause) =>
        isGitCommandError(cause)
          ? cause
          : failure("Could not verify that the worktree is safe to remove.", cause),
      ),
    );
    yield* git.removeWorktree(input);
  });
});
