import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ThreadWorktreeLink,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
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
  type ProjectSetupScriptRunnerResult,
} from "../../../project/ProjectSetupScriptRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { listThreadWorktrees, WorktreesToolkitHandlersLive } from "./handlers.ts";
import { WorktreesToolkit } from "./tools.ts";

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

function makeThread(worktrees: ReadonlyArray<ThreadWorktreeLink> = []): OrchestrationThreadShell {
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
    worktrees,
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
  };
}

interface HarnessOptions {
  readonly thread?: OrchestrationThreadShell;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
}

const makeHarness = Effect.fn("makeWorktreesToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const createdWorktrees = yield* Ref.make<ReadonlyArray<VcsCreateWorktreeInput>>([]);
  const thread = options.thread ?? makeThread();
  const projects = options.projects ?? PROJECTS;
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      if (
        command.type === "thread.worktree.detach" &&
        !(thread.worktrees ?? []).some((link) => link.worktreePath === command.worktreePath)
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
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(GitWorkflowService)({
      status: () => Effect.succeed({ isRepo: true, refName: "main" } as VcsStatusResult),
      createWorktree: (input) =>
        Ref.update(createdWorktrees, (recorded) => [...recorded, input]).pipe(
          Effect.as({
            worktree: { path: "/worktrees/lib", refName: input.newRefName ?? input.refName },
          } as VcsCreateWorktreeResult),
        ),
      removeWorktree: () => Effect.void,
    }),
    Layer.mock(ProjectSetupScriptRunner)({
      runForThread: () =>
        Effect.succeed({ status: "no-script" } as unknown as ProjectSetupScriptRunnerResult),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* WorktreesToolkit.pipe(
    Effect.provide(WorktreesToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof WorktreesToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["worktrees"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof WorktreesToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { commands, createdWorktrees, call };
});

describe("worktrees toolkit handlers", () => {
  it.effect("refuses a credential without the worktrees capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_worktrees", {}, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "worktrees",
      });
    }),
  );

  it.effect("creates a worktree of a project named by title on the thread's branch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("attach_worktree", { project: "lib" });
      expect(result).toEqual({
        project: "Lib",
        worktreePath: "/worktrees/lib",
        branch: "feat/shared-change",
        alreadyAttached: false,
      });
      expect(yield* Ref.get(harness.createdWorktrees)).toMatchObject([
        { cwd: "/code/lib", refName: "main", newRefName: "feat/shared-change" },
      ]);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.worktree.attach",
          threadId: THREAD_ID,
          projectId: LIB,
          worktreePath: "/worktrees/lib",
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("asks for a branch instead of copying a first-turn placeholder branch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: { ...makeThread(), branch: "t3code/1a2b3c4d" },
      });
      const error = yield* harness.call("attach_worktree", { project: "Lib" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorktreeAttachFailedError" });
      expect(error.message).toContain("Pass a branch name");
      expect(yield* Ref.get(harness.createdWorktrees)).toEqual([]);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("resolves a project by its workspace root and rejects ambiguous titles", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        projects: [...PROJECTS, makeProject(ProjectId.make("project-lib-2"), "Lib", "/other/lib")],
      });
      const byRoot = yield* harness.call("attach_worktree", { project: "/code/lib/" });
      expect(byRoot.project).toBe("Lib");
      const ambiguous = yield* harness
        .call("attach_worktree", { project: "Lib" })
        .pipe(Effect.flip);
      expect(ambiguous._tag).toBe("WorktreeProjectAmbiguousError");
    }),
  );

  it.effect("hands back the worktree the thread already has without creating another", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([
          {
            worktreePath: "/worktrees/lib",
            projectId: LIB,
            branch: "feat/shared-change",
            source: "manual",
            linkedAt: NOW,
          },
        ]),
      });
      const result = yield* harness.call("attach_worktree", { project: "Lib" });
      expect(result.alreadyAttached).toBe(true);
      expect(yield* Ref.get(harness.createdWorktrees)).toEqual([]);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("treats detaching a worktree that is not attached as done", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("detach_worktree", { worktreePath: "/worktrees/lib" });
      expect(result).toEqual({ worktreePath: "/worktrees/lib", wasAttached: false });
    }),
  );
});

describe("listThreadWorktrees", () => {
  it("reports the primary workspace, attached worktrees, and attachable projects", () => {
    const docs = makeProject(ProjectId.make("project-docs"), "Docs", "/code/docs");
    const result = listThreadWorktrees(
      makeThread([
        {
          worktreePath: "/worktrees/lib",
          projectId: LIB,
          branch: "feat/shared-change",
          source: "agent",
          linkedAt: NOW,
        },
      ]),
      [...PROJECTS, docs],
    );
    expect(result).toEqual({
      primary: { project: "App", path: "/code/app-wt", branch: "feat/shared-change" },
      attached: [
        {
          project: "Lib",
          worktreePath: "/worktrees/lib",
          branch: "feat/shared-change",
          source: "agent",
        },
      ],
      attachableProjects: [{ title: "Docs", workspaceRoot: "/code/docs" }],
    });
  });
});
