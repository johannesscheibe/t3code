import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import {
  formatWorktreePathForDisplay,
  getOrphanedAttachedWorktrees,
  getOrphanedWorktreePathForThread,
} from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
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
    session: null,
    messages: [],
    checkpoints: [],
    pullRequests: [],
    activities: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when the target thread does not exist", () => {
    const result = getOrphanedWorktreePathForThread([], ThreadId.make("missing-thread"), []);
    expect(result).toBeNull();
  });

  it("returns null when the target thread has no worktree", () => {
    const threads = [makeThread()];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"), []);
    expect(result).toBeNull();
  });

  it("returns the path when no other thread links to that worktree", () => {
    const threads = [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"), []);
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });

  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"), []);
    expect(result).toBeNull();
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"), []);
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

function attachedWorktree(worktreePath: string) {
  return {
    worktreePath,
    projectId: ProjectId.make("project-library"),
    branch: null,
    source: "manual" as const,
    linkedAt: "2026-02-13T00:00:00.000Z",
  };
}

describe("attached worktree cleanup", () => {
  it("keeps a thread's own worktree when another thread has it attached", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/feature-a" }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktrees: [attachedWorktree("/tmp/repo/worktrees/feature-a/")],
      }),
    ];

    expect(getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"), [])).toBeNull();
  });

  it.each([false, true])(
    "preserves registered project roots, with a local thread: %s",
    (hasLocalThread) => {
      const root = "/tmp/library";
      const projects = [{ id: ProjectId.make("project-library"), workspaceRoot: `${root}/` }];
      const threads = [
        makeThread({ worktreePath: root, worktrees: [attachedWorktree(root)] }),
        ...(hasLocalThread
          ? [makeThread({ id: ThreadId.make("local"), projectId: projects[0]!.id })]
          : []),
      ];
      expect(getOrphanedWorktreePathForThread(threads, threads[0]!.id, projects)).toBeNull();
      expect(getOrphanedAttachedWorktrees(threads, threads[0]!.id, projects)).toEqual([]);
    },
  );

  it("offers only attached worktrees that no other thread works in", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktrees: [
          attachedWorktree("/tmp/library-a"),
          attachedWorktree("/tmp/library-b"),
          attachedWorktree("/tmp/library-c"),
        ],
      }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/library-b" }),
      makeThread({
        id: ThreadId.make("thread-3"),
        worktrees: [attachedWorktree("/tmp/library-c/")],
      }),
    ];

    expect(
      getOrphanedAttachedWorktrees(threads, ThreadId.make("thread-1"), []).map(
        (link) => link.worktreePath,
      ),
    ).toEqual(["/tmp/library-a"]);
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
