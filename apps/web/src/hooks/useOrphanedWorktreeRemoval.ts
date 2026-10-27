import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { vcsEnvironment } from "../state/vcs";
import { formatWorktreePathForDisplay, type OrphanedWorktree } from "../worktreeCleanup";

/** An orphaned worktree this connection may remove, with the repository root that owns it. */
export interface RemovableWorktree extends OrphanedWorktree {
  readonly projectRoot: string;
}

/**
 * Offering to delete worktrees no thread uses any more. Thread deletion and
 * checkout detach share it: resolve what may be removed, confirm, then remove.
 */
export function useOrphanedWorktreeRemoval() {
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const loadSessionState = useAtomQueryRunner(environmentSession.sessionStateAtom, {
    reportFailure: false,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });

  /** Drops scratch-project worktrees, and everything when the session cannot write source control. */
  const resolveRemovableWorktrees = useCallback(
    async (
      environmentId: EnvironmentId,
      worktrees: ReadonlyArray<OrphanedWorktree>,
    ): Promise<RemovableWorktree[]> => {
      if (worktrees.length === 0 || !readLocalApi()) return [];
      const scratchWorkspaceRoot = appAtomRegistry
        .get(environmentServerConfigsAtom)
        .get(environmentId)?.scratchWorkspaceRoot;
      const candidates = worktrees.flatMap((worktree) => {
        const project = readProject({ environmentId, projectId: worktree.projectId });
        return project !== null && !isScratchProject(project, scratchWorkspaceRoot)
          ? [{ ...worktree, projectRoot: project.workspaceRoot }]
          : [];
      });
      if (candidates.length === 0) return [];
      const sessionResult = await loadSessionState(environmentId);
      return sessionResult._tag === "Success" &&
        sessionGrantsScope(sessionResult.value, AuthSourceControlWriteScope)
        ? candidates
        : [];
    },
    [loadSessionState],
  );

  /** Asks whether to delete the worktrees too. `reason` leads the dialog, e.g. why they are orphaned. */
  const confirmWorktreeRemoval = useCallback(
    (reason: string, worktrees: ReadonlyArray<OrphanedWorktree>) => {
      const localApi = readLocalApi();
      if (!localApi || worktrees.length === 0) return Promise.resolve(AsyncResult.success(false));
      return settlePromise(() =>
        localApi.dialogs.confirm(
          [
            reason,
            ...worktrees.map((worktree) => formatWorktreePathForDisplay(worktree.path)),
            "",
            worktrees.length === 1 ? "Delete the worktree too?" : "Delete these worktrees too?",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
    },
    [],
  );

  /** Removes each worktree and refreshes its repository's status. Failures toast and never throw. */
  const removeWorktrees = useCallback(
    async (environmentId: EnvironmentId, worktrees: ReadonlyArray<RemovableWorktree>) => {
      for (const worktree of worktrees) {
        const displayPath = formatWorktreePathForDisplay(worktree.path);
        const removeResult = readEnvironmentScope(environmentId, AuthSourceControlWriteScope)
          ? await removeWorktree({
              environmentId,
              input: { cwd: worktree.projectRoot, path: worktree.path, force: true },
            })
          : AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  message: "This connection can no longer remove worktrees.",
                  requiredScope: AuthSourceControlWriteScope,
                }),
              ),
            );
        const refreshResult =
          removeResult._tag === "Success"
            ? await refreshVcsStatus({ environmentId, input: { cwd: worktree.projectRoot } })
            : null;
        const cleanupFailure =
          removeResult._tag === "Failure"
            ? removeResult
            : refreshResult?._tag === "Failure"
              ? refreshResult
              : null;
        if (!cleanupFailure) continue;
        const removalFailed = removeResult._tag === "Failure";
        const error = squashAtomCommandFailure(cleanupFailure);
        const message = error instanceof Error ? error.message : "An error occurred.";
        console.error("Worktree cleanup failed", {
          projectCwd: worktree.projectRoot,
          worktreePath: worktree.path,
          error,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: removalFailed
              ? "Failed to delete worktree"
              : "Worktree deleted, but Git status refresh failed",
            description: removalFailed ? `Could not remove ${displayPath}. ${message}` : message,
          }),
        );
      }
    },
    [refreshVcsStatus, removeWorktree],
  );

  return { resolveRemovableWorktrees, confirmWorktreeRemoval, removeWorktrees };
}
