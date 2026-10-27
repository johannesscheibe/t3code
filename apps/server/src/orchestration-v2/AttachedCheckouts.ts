import type { OrchestrationV2AppThread, ThreadAttachedCheckout } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProjectStore from "./ProjectStore.ts";

/** An attached checkout and the directory it lives in. */
export interface AttachedCheckoutRoot {
  readonly checkout: ThreadAttachedCheckout;
  readonly cwd: string;
}

/**
 * Resolves a thread's attached checkouts to their directories. A project
 * deleted since it was attached is skipped: nothing is left to work in.
 */
export const resolveAttachedCheckoutRoots = (
  thread: Pick<OrchestrationV2AppThread, "attachedCheckouts">,
  projects: ProjectStore.ProjectStoreV2["Service"],
) =>
  Effect.forEach(thread.attachedCheckouts ?? [], (checkout) =>
    checkout.worktreePath !== null
      ? Effect.succeed<ReadonlyArray<AttachedCheckoutRoot>>([
          { checkout, cwd: checkout.worktreePath },
        ])
      : projects.get(checkout.projectId).pipe(
          Effect.map(
            Option.match({
              onNone: (): ReadonlyArray<AttachedCheckoutRoot> => [],
              onSome: (project) => [{ checkout, cwd: project.workspaceRoot }],
            }),
          ),
        ),
  ).pipe(Effect.map((roots) => roots.flat()));
