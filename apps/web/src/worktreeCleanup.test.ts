import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { makeThreadFixture } from "./test-fixtures";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreesForThread,
  isWorktreeUsedByOtherThread,
} from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

function attached(projectId: ProjectId, worktreePath: string | null) {
  return { id: `checkout-${projectId}`, projectId, worktreePath, branch: null };
}

describe("getOrphanedWorktreesForThread", () => {
  it("returns nothing when the target thread does not exist", () => {
    expect(getOrphanedWorktreesForThread([], ThreadId.make("missing-thread"))).toEqual([]);
  });

  it("returns nothing when the target thread has no worktree", () => {
    const threads = [makeThread()];
    expect(getOrphanedWorktreesForThread(threads, ThreadId.make("thread-1"))).toEqual([]);
  });

  it("returns the thread's worktree when no other thread links to it", () => {
    const threads = [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })];
    expect(getOrphanedWorktreesForThread(threads, ThreadId.make("thread-1"))).toEqual([
      { projectId: ProjectId.make("project-1"), path: "/tmp/repo/worktrees/feature-a" },
    ]);
  });

  it("keeps a worktree another thread uses as its own", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/feature-a" }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/feature-a" }),
    ];
    expect(getOrphanedWorktreesForThread(threads, ThreadId.make("thread-1"))).toEqual([]);
  });

  it("keeps a worktree another thread has attached as a checkout", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/feature-a" }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: projectB,
        attachedCheckouts: [attached(ProjectId.make("project-1"), "/tmp/repo/worktrees/feature-a")],
      }),
    ];
    expect(getOrphanedWorktreesForThread(threads, ThreadId.make("thread-1"))).toEqual([]);
  });

  it("includes attached worktrees no other thread uses, under the attached project", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        attachedCheckouts: [
          attached(projectA, "/tmp/a/worktrees/feature"),
          attached(projectB, null),
        ],
      }),
    ];
    expect(getOrphanedWorktreesForThread(threads, ThreadId.make("thread-1"))).toEqual([
      { projectId: projectA, path: "/tmp/a/worktrees/feature" },
    ]);
  });

  it("keeps an attached worktree that another thread works in", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        attachedCheckouts: [attached(projectA, "/tmp/a/worktrees/feature")],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: projectA,
        worktreePath: "/tmp/a/worktrees/feature",
      }),
    ];
    expect(getOrphanedWorktreesForThread(threads, ThreadId.make("thread-1"))).toEqual([]);
  });
});

describe("isWorktreeUsedByOtherThread", () => {
  it("ignores the asking thread itself", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        attachedCheckouts: [attached(projectA, "/tmp/a/worktrees/feature")],
      }),
    ];
    expect(
      isWorktreeUsedByOtherThread(threads, ThreadId.make("thread-1"), "/tmp/a/worktrees/feature"),
    ).toBe(false);
  });

  it("counts another thread's own worktree and attached checkouts", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1") }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/own",
        attachedCheckouts: [attached(projectA, "/tmp/a/worktrees/feature")],
      }),
    ];
    const threadId = ThreadId.make("thread-1");
    expect(isWorktreeUsedByOtherThread(threads, threadId, "/tmp/repo/worktrees/own")).toBe(true);
    expect(isWorktreeUsedByOtherThread(threads, threadId, "/tmp/a/worktrees/feature")).toBe(true);
    expect(isWorktreeUsedByOtherThread(threads, threadId, "/tmp/a/worktrees/other")).toBe(false);
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("shows only the last path segment for unix-like paths", () => {
    const result = formatWorktreePathForDisplay(
      "/Users/julius/.t3/worktrees/t3code-mvp/t3code-4e609bb8",
    );
    expect(result).toBe("t3code-4e609bb8");
  });

  it("normalizes windows separators before selecting the final segment", () => {
    const result = formatWorktreePathForDisplay(
      "C:\\Users\\julius\\.t3\\worktrees\\t3code-mvp\\t3code-4e609bb8",
    );
    expect(result).toBe("t3code-4e609bb8");
  });

  it("uses the final segment even when outside ~/.t3/worktrees", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree");
    expect(result).toBe("my-worktree");
  });

  it("ignores trailing slashes", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree/");
    expect(result).toBe("my-worktree");
  });
});
