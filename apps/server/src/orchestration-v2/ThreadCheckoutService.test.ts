import { describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2AttachCheckoutInput,
  type OrchestrationV2ThreadProjection,
  type Project,
  ProjectId,
  type ThreadAttachedCheckout,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadCheckoutService from "./ThreadCheckoutService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:checkout-service");
const ownProjectId = ProjectId.make("project:own");
const otherProjectId = ProjectId.make("project:other");
const projectFor = (id: ProjectId): Project =>
  ({ id, title: id, workspaceRoot: `/repos/${id}`, scripts: [] }) as unknown as Project;

// Directories that exist; everything else is missing.
const existing = new Set([
  `/repos/${ownProjectId}`,
  `/repos/${otherProjectId}`,
  "/worktrees/other/existing",
  "/somewhere/else",
]);
const fileSystemLayer = FileSystem.layerNoop({
  realPath: (path) =>
    existing.has(path)
      ? Effect.succeed(path)
      : Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "realPath",
            pathOrDescriptor: path,
          }),
        ),
});

const makeHarness = (
  options: { readonly dispatchFails?: boolean; readonly activeRunOrdinal?: number } = {},
) => {
  let attached: ReadonlyArray<ThreadAttachedCheckout> = [];
  const dispatch = vi.fn((command: { readonly checkout: ThreadAttachedCheckout }) =>
    options.dispatchFails
      ? (Effect.fail("dispatch failed") as never)
      : Effect.sync(() => {
          attached = [...attached, command.checkout];
          return { sequence: 1, storedEvents: [] } as never;
        }),
  );
  const createWorktree = vi.fn(() =>
    Effect.succeed({ worktree: { path: "/worktrees/other/feature", refName: "feature" } } as never),
  );
  const removeWorktree = vi.fn(() => Effect.void);
  const captureCheckoutBaselines = vi.fn(() => Effect.void);
  const layer = ThreadCheckoutService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: threadId,
                projectId: ownProjectId,
                worktreePath: null,
                archivedAt: null,
                deletedAt: null,
                attachedCheckouts: attached,
              },
              runs:
                options.activeRunOrdinal === undefined
                  ? []
                  : [
                      {
                        id: "run:done",
                        ordinal: options.activeRunOrdinal - 1,
                        status: "completed",
                      },
                      { id: "run:active", ordinal: options.activeRunOrdinal, status: "waiting" },
                    ],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: dispatch as never,
        }),
        Layer.mock(CheckpointService.CheckpointServiceV2)({ captureCheckoutBaselines }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(Option.some(projectFor(id))),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (id) => Effect.succeed(Option.some(projectFor(id) as never)),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
          listLocalBranchNames: () => Effect.succeed(["main"]),
          hasCommit: () => Effect.succeed(false),
          createWorktree,
          removeWorktree,
          deleteLocalBranch: () => Effect.void,
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute: () =>
            Effect.succeed({
              stdout: `worktree /repos/${otherProjectId}\nworktree /worktrees/other/existing\n`,
            } as never),
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" } as const),
        }),
        fileSystemLayer,
        Path.layer,
      ),
    ),
  );
  const attach = (input: Omit<OrchestrationV2AttachCheckoutInput, "threadId" | "commandId">) =>
    Effect.gen(function* () {
      const service = yield* ThreadCheckoutService.ThreadCheckoutService;
      return yield* service.attach({
        ...input,
        threadId,
        commandId: CommandId.make("command:attach"),
      });
    }).pipe(Effect.provide(layer));
  return { attach, dispatch, createWorktree, removeWorktree, captureCheckoutBaselines };
};

describe("ThreadCheckoutService.attach", () => {
  it.effect("attaches a project root with its current branch, once per command", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const first = yield* harness.attach({
        projectId: otherProjectId,
        workspace: { type: "root" },
      });
      expect(first).toEqual({
        id: "checkout:command:attach",
        projectId: otherProjectId,
        worktreePath: null,
        branch: "main",
      });
      // A retry of the same command returns the attachment without dispatching again.
      const retried = yield* harness.attach({
        projectId: otherProjectId,
        workspace: { type: "root" },
      });
      expect(retried).toEqual(first);
      expect(harness.dispatch).toHaveBeenCalledTimes(1);
      // No turn is running, so the next turn takes the checkout's first baseline.
      expect(harness.captureCheckoutBaselines).not.toHaveBeenCalled();
    });
  });

  it.effect("takes the running turn's baseline for a checkout attached mid-turn", () => {
    const harness = makeHarness({ activeRunOrdinal: 3 });
    return Effect.gen(function* () {
      const checkout = yield* harness.attach({
        projectId: otherProjectId,
        workspace: { type: "existing_worktree", worktreePath: "/worktrees/other/existing" },
      });
      expect(harness.captureCheckoutBaselines).toHaveBeenCalledOnce();
      expect(harness.captureCheckoutBaselines).toHaveBeenCalledWith({
        threadId,
        ordinalWithinScope: 2,
        checkouts: [{ checkout, cwd: "/worktrees/other/existing" }],
      });
    });
  });

  it.effect(
    "rejects the thread's own project, foreign worktrees, main checkouts, and missing roots",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const own = yield* Effect.flip(
          harness.attach({ projectId: ownProjectId, workspace: { type: "root" } }),
        );
        expect(own.message).toContain("own project");
        const foreign = yield* Effect.flip(
          harness.attach({
            projectId: otherProjectId,
            workspace: { type: "existing_worktree", worktreePath: "/somewhere/else" },
          }),
        );
        expect(foreign.message).toContain("is not a worktree of");
        const main = yield* Effect.flip(
          harness.attach({
            projectId: otherProjectId,
            workspace: { type: "existing_worktree", worktreePath: `/repos/${otherProjectId}` },
          }),
        );
        expect(main.message).toContain("main checkout");
        const missing = yield* Effect.flip(
          harness.attach({
            projectId: ProjectId.make("project:gone"),
            workspace: { type: "root" },
          }),
        );
        expect(missing.message).toContain("does not exist");
        expect(harness.dispatch).not.toHaveBeenCalled();
      });
    },
  );

  it.effect("removes a new worktree when the attach cannot be recorded", () => {
    const harness = makeHarness({ dispatchFails: true });
    return Effect.gen(function* () {
      yield* Effect.flip(
        harness.attach({
          projectId: otherProjectId,
          workspace: { type: "worktree", baseRef: "main", branch: "feature" },
        }),
      );
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
      expect(harness.removeWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/worktrees/other/feature" }),
      );
    });
  });
});
