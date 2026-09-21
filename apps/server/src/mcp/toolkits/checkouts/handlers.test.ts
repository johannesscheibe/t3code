import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ThreadCheckout,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import { CheckpointStore } from "../../../checkpointing/CheckpointStore.ts";
import { VcsDriverRegistry } from "../../../vcs/VcsDriverRegistry.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerInput,
} from "../../../project/ProjectSetupScriptRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CheckoutsToolkitHandlersLive, listThreadCheckouts } from "./handlers.ts";
import { CheckoutsToolkit } from "./tools.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const APP = ProjectId.make("project-app");
const LIB = ProjectId.make("project-lib");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(
  id: ProjectId,
  title: string,
  workspaceRoot: string,
): OrchestrationProjectShell {
  return {
    id,
    title,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const PROJECTS = [makeProject(APP, "App", "/code/app"), makeProject(LIB, "Lib", "/code/lib")];

function makeCheckout(overrides: Partial<ThreadCheckout> = {}): ThreadCheckout {
  return {
    projectId: LIB,
    worktreePath: "/worktrees/lib",
    branch: "feat/shared-change",
    pullRequest: null,
    source: "manual",
    attachedAt: NOW,
    checkpointId: "checkpoint-lib",
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: APP,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-fable-5-1" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/shared-change",
    worktreePath: "/code/app-wt",
    pullRequests: [],
    checkouts: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

interface HarnessOptions {
  readonly thread?: OrchestrationThreadShell;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  /** Branches the attached project's repository already has. */
  readonly existingBranches?: ReadonlyArray<string>;
}

const makeHarness = Effect.fn("makeCheckoutsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const createdWorktrees = yield* Ref.make<ReadonlyArray<VcsCreateWorktreeInput>>([]);
  const setupCalls = yield* Ref.make<ReadonlyArray<ProjectSetupScriptRunnerInput>>([]);
  const thread = options.thread ?? makeThread();
  const projects = options.projects ?? PROJECTS;
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      if (
        command.type === "thread.checkout.detach" &&
        !thread.checkouts.some((checkout) => checkout.projectId === command.projectId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "not attached",
        });
      }
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.some(thread) : Option.none()),
      getProjectShellById: (projectId) =>
        Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === projectId))),
      getProjectShells: () => Effect.succeed(projects),
      getThreadCheckpointContext: () =>
        Effect.succeed(
          Option.some({
            threadId: thread.id,
            projectId: thread.projectId,
            workspaceRoot: "/code/app",
            worktreePath: thread.worktreePath,
            checkpoints: [],
          }),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(GitWorkflowService)({
      status: () => Effect.succeed({ isRepo: true, refName: "main" } as VcsStatusResult),
      hasCommit: ({ refName }) =>
        Effect.succeed(
          (options.existingBranches ?? []).some((branch) => refName === `refs/heads/${branch}`),
        ),
      createWorktree: (input) =>
        Ref.update(createdWorktrees, (recorded) => [...recorded, input]).pipe(
          Effect.as({
            worktree: { path: "/worktrees/lib", refName: input.newRefName ?? input.refName },
          } as VcsCreateWorktreeResult),
        ),
      removeWorktree: () => Effect.void,
    }),
    Layer.mock(ProjectSetupScriptRunner)({
      runForThread: (input) =>
        Ref.update(setupCalls, (calls) => [...calls, input]).pipe(
          Effect.as({ status: "no-script" as const }),
        ),
    }),
    Layer.mock(CheckpointStore)({
      isGitRepository: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(false),
      captureCheckpoint: () => Effect.void,
    }),
    Layer.mock(VcsDriverRegistry)({}),
    FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) }),
    Path.layer,
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* CheckoutsToolkit.pipe(
    Effect.provide(CheckoutsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof CheckoutsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["checkouts"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof CheckoutsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { commands, createdWorktrees, setupCalls, call };
});

describe("checkouts toolkit handlers", () => {
  it.effect("refuses a credential without the checkouts capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_checkouts", {}, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "checkouts",
      });
    }),
  );

  it.effect("creates a worktree on the thread's branch for a worktree thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("attach_checkout", { project: "lib" });
      expect(result).toEqual({
        project: "Lib",
        path: "/worktrees/lib",
        mode: "worktree",
        branch: "feat/shared-change",
        alreadyAttached: false,
      });
      // Empty snapshot scripts must still reach the settings-aware setup runner.
      expect(yield* Ref.get(harness.setupCalls)).toMatchObject([
        {
          projectId: LIB,
          worktreePath: "/worktrees/lib",
          preferredTerminalId: expect.stringMatching(/^setup-worktree-/),
        },
      ]);
      expect(yield* Ref.get(harness.createdWorktrees)).toMatchObject([
        { cwd: "/code/lib", refName: "main", newRefName: "feat/shared-change" },
      ]);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.checkout.attach",
          threadId: THREAD_ID,
          projectId: LIB,
          worktreePath: "/worktrees/lib",
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("attaches the project's own checkout for a local thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ thread: makeThread({ worktreePath: null }) });
      const result = yield* harness.call("attach_checkout", { project: "Lib" });
      expect(result).toEqual({
        project: "Lib",
        path: "/code/lib",
        mode: "local",
        branch: "main",
        alreadyAttached: false,
      });
      expect(yield* Ref.get(harness.createdWorktrees)).toEqual([]);
      expect(yield* Ref.get(harness.setupCalls)).toEqual([]);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.checkout.attach", projectId: LIB, worktreePath: null, branch: "main" },
      ]);
    }),
  );

  it.effect("honors an explicit mode over the thread's own", () =>
    Effect.gen(function* () {
      const local = yield* makeHarness();
      const localResult = yield* local.call("attach_checkout", { project: "Lib", mode: "local" });
      expect(localResult).toMatchObject({ mode: "local", path: "/code/lib" });
      expect(yield* Ref.get(local.createdWorktrees)).toEqual([]);

      const worktree = yield* makeHarness({ thread: makeThread({ worktreePath: null }) });
      const worktreeResult = yield* worktree.call("attach_checkout", {
        project: "Lib",
        mode: "worktree",
        branch: "feat/other",
        baseBranch: "develop",
      });
      expect(worktreeResult).toMatchObject({
        mode: "worktree",
        path: "/worktrees/lib",
        branch: "feat/other",
      });
      expect(yield* Ref.get(worktree.createdWorktrees)).toMatchObject([
        { cwd: "/code/lib", refName: "develop", newRefName: "feat/other" },
      ]);
    }),
  );

  it.effect(
    "names the worktree with a placeholder instead of copying a placeholder or taken branch",
    () =>
      Effect.gen(function* () {
        const placeholder = yield* makeHarness({
          thread: makeThread({ branch: "t3code/1a2b3c4d" }),
        });
        yield* placeholder.call("attach_checkout", { project: "Lib" });
        const taken = yield* makeHarness({ existingBranches: ["feat/shared-change"] });
        yield* taken.call("attach_checkout", { project: "Lib" });
        for (const harness of [placeholder, taken]) {
          const [created] = yield* Ref.get(harness.createdWorktrees);
          expect(created?.newRefName).toMatch(/^t3code\/[0-9a-f]{8}$/);
          expect(created?.newRefName).not.toBe("t3code/1a2b3c4d");
        }
      }),
  );

  it.effect("resolves a project by its workspace root and rejects ambiguous titles", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        projects: [...PROJECTS, makeProject(ProjectId.make("project-lib-2"), "Lib", "/other/lib")],
      });
      const byRoot = yield* harness.call("attach_checkout", { project: "/code/lib/" });
      expect(byRoot.project).toBe("Lib");
      const ambiguous = yield* harness
        .call("attach_checkout", { project: "Lib" })
        .pipe(Effect.flip);
      expect(ambiguous._tag).toBe("CheckoutProjectAmbiguousError");
    }),
  );

  it.effect("hands back the checkout the thread already has without creating another", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({ branch: "t3code/1a2b3c4d", checkouts: [makeCheckout()] }),
      });
      const result = yield* harness.call("attach_checkout", { project: "Lib" });
      expect(result).toEqual({
        project: "Lib",
        path: "/worktrees/lib",
        mode: "worktree",
        branch: "feat/shared-change",
        alreadyAttached: true,
      });
      expect(yield* Ref.get(harness.createdWorktrees)).toEqual([]);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("detaches a checkout by project title or workspace root", () =>
    Effect.gen(function* () {
      const attached = yield* makeHarness({ thread: makeThread({ checkouts: [makeCheckout()] }) });
      expect(yield* attached.call("detach_checkout", { project: "lib" })).toEqual({
        project: "Lib",
        wasAttached: true,
      });
      expect(yield* attached.call("detach_checkout", { project: "/code/lib" })).toEqual({
        project: "Lib",
        wasAttached: true,
      });
      expect(yield* Ref.get(attached.commands)).toMatchObject([
        { type: "thread.checkout.detach", threadId: THREAD_ID, projectId: LIB },
        { type: "thread.checkout.detach", threadId: THREAD_ID, projectId: LIB },
      ]);

      // Detaching a checkout that is not attached is the outcome the agent asked for.
      const detached = yield* makeHarness();
      expect(yield* detached.call("detach_checkout", { project: "Lib" })).toEqual({
        project: "Lib",
        wasAttached: false,
      });
    }),
  );
});

describe("listThreadCheckouts", () => {
  const docs = makeProject(ProjectId.make("project-docs"), "Docs", "/code/docs");
  const tools = makeProject(ProjectId.make("project-tools"), "Tools", "/code/tools");

  it("reports the workspace, attached checkouts with their paths, and attachable projects", () => {
    const result = listThreadCheckouts(
      makeThread({
        checkouts: [
          makeCheckout({ source: "agent" }),
          makeCheckout({ projectId: docs.id, worktreePath: null, branch: "main" }),
        ],
      }),
      [...PROJECTS, docs, tools],
    );
    expect(result).toEqual({
      workspace: {
        project: "App",
        path: "/code/app-wt",
        mode: "worktree",
        branch: "feat/shared-change",
      },
      attached: [
        {
          project: "Lib",
          path: "/worktrees/lib",
          mode: "worktree",
          branch: "feat/shared-change",
          source: "agent",
        },
        { project: "Docs", path: "/code/docs", mode: "local", branch: "main", source: "manual" },
      ],
      attachableProjects: [{ title: "Tools", workspaceRoot: "/code/tools" }],
    });
  });

  it("reports a local thread's workspace at its project root", () => {
    const result = listThreadCheckouts(
      makeThread({ worktreePath: null, branch: "main" }),
      PROJECTS,
    );
    expect(result.workspace).toEqual({
      project: "App",
      path: "/code/app",
      mode: "local",
      branch: "main",
    });
  });
});
