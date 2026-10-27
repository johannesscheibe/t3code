import type { EnvironmentId, ThreadAttachedCheckout } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProjects } from "./state/entities";

/** An attached checkout with its project's title and the directory the agent works in. */
export interface ThreadCheckoutRoot {
  readonly checkout: ThreadAttachedCheckout;
  readonly projectTitle: string;
  /** The worktree, or the project's own checkout. Null when the project is gone. */
  readonly cwd: string | null;
  /** The project's repository root when the project's own checkout is attached. */
  readonly repositoryRoot: string | undefined;
}

const NO_CHECKOUT_ROOTS: ReadonlyArray<ThreadCheckoutRoot> = [];

/** Resolves a thread's attached checkouts against its environment's projects. */
export function useThreadCheckoutRoots(
  environmentId: EnvironmentId | null,
  checkouts: ReadonlyArray<ThreadAttachedCheckout> | null | undefined,
): ReadonlyArray<ThreadCheckoutRoot> {
  const projects = useProjects();
  return useMemo(() => {
    if (!checkouts || checkouts.length === 0) return NO_CHECKOUT_ROOTS;
    return checkouts.map((checkout) => {
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === environmentId && candidate.id === checkout.projectId,
      );
      return {
        checkout,
        projectTitle: project?.title ?? "Unknown project",
        cwd: checkout.worktreePath ?? project?.workspaceRoot ?? null,
        repositoryRoot: checkout.worktreePath ? undefined : project?.repositoryIdentity?.rootPath,
      };
    });
  }, [checkouts, environmentId, projects]);
}
