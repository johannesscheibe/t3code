import {
  OrchestrationCommand,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadCheckout,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

const asEvents = (decided: PlannedEvent | ReadonlyArray<PlannedEvent>) =>
  Array.isArray(decided) ? (decided as ReadonlyArray<PlannedEvent>) : [decided as PlannedEvent];

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const APP = ProjectId.make("project-app");
const LIB = ProjectId.make("project-lib");

function makeReadModel(checkouts: ReadonlyArray<ThreadCheckout>): OrchestrationReadModel {
  const project = (id: ProjectId, root: string) => ({
    id,
    title: root.slice(1),
    workspaceRoot: root,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  });
  return {
    snapshotSequence: 0,
    projects: [project(APP, "/app"), project(LIB, "/lib")],
    threads: [
      {
        id: THREAD_ID,
        projectId: APP,
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feat/x",
        worktreePath: "/app-wt",
        pullRequests: [],
        checkouts,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const libCheckout: ThreadCheckout = {
  projectId: LIB,
  worktreePath: "/lib-wt",
  branch: "feat/x",
  pullRequest: null,
  source: "manual",
  attachedAt: NOW,
  checkpointId: "checkpoint-lib",
};

const attach = (overrides: Record<string, unknown> = {}) =>
  decodeCommand({
    type: "thread.checkout.attach",
    commandId: "attach",
    threadId: THREAD_ID,
    projectId: LIB,
    worktreePath: "/lib-wt",
    branch: "feat/x",
    source: "agent",
    checkpointId: "checkpoint-lib",
    ...overrides,
  });

const detach = (projectId: ProjectId = LIB) =>
  decodeCommand({
    type: "thread.checkout.detach",
    commandId: "detach",
    threadId: THREAD_ID,
    projectId,
  });

const sync = (overrides: Record<string, unknown> = {}) =>
  decodeCommand({
    type: "thread.checkout.sync",
    commandId: "sync",
    threadId: THREAD_ID,
    projectId: LIB,
    branch: "feat/y",
    pullRequest: { number: 7, url: "https://github.com/acme/lib/pull/7", state: "open" },
    ...overrides,
  });

const project = Effect.fn("project")(function* (
  model: OrchestrationReadModel,
  decided: PlannedEvent | ReadonlyArray<PlannedEvent>,
) {
  let next = model;
  for (const [index, event] of asEvents(decided).entries()) {
    next = yield* projectEvent(next, { ...event, sequence: index + 1 } as OrchestrationEvent);
  }
  return next;
});

it.layer(NodeServices.layer)("thread checkout decider", (it) => {
  it.effect("attaches a checkout of another project, then detaches it by project", () =>
    Effect.gen(function* () {
      let model = makeReadModel([]);
      const attached = yield* decideOrchestrationCommand({
        readModel: model,
        command: yield* attach(),
      });
      expect(asEvents(attached).map((event) => event.type)).toEqual([
        "thread.checkout-attached",
        "thread.activity-appended",
      ]);
      expect(asEvents(attached)[1]).toMatchObject({
        payload: { activity: { kind: "checkout.attached" } },
      });
      model = yield* project(model, attached);
      expect(model.threads[0]!.checkouts).toEqual([
        { ...libCheckout, source: "agent", attachedAt: expect.any(String) },
      ]);

      const detached = yield* decideOrchestrationCommand({
        readModel: model,
        command: yield* detach(),
      });
      expect(asEvents(detached).map((event) => event.type)).toEqual([
        "thread.checkout-detached",
        "thread.activity-appended",
      ]);
      expect(asEvents(detached)[0]).toMatchObject({ payload: { projectId: LIB } });
      model = yield* project(model, detached);
      expect(model.threads[0]!.checkouts).toEqual([]);
    }),
  );

  it.effect("records a project's own checkout without a worktree path", () =>
    Effect.gen(function* () {
      const attached = yield* decideOrchestrationCommand({
        readModel: makeReadModel([]),
        command: yield* attach({ worktreePath: null, branch: "main" }),
      });
      const model = yield* project(makeReadModel([]), attached);
      expect(model.threads[0]!.checkouts).toMatchObject([
        { projectId: LIB, worktreePath: null, branch: "main" },
      ]);
      expect(asEvents(attached)[1]).toMatchObject({
        payload: { activity: { payload: { worktreePath: null, detail: "/lib (main)" } } },
      });
    }),
  );

  it.effect("rejects a checkout of the thread's own project", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: makeReadModel([]),
          command: yield* attach({ projectId: APP, worktreePath: null }),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a second checkout of a project that is already attached", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: makeReadModel([libCheckout]),
          command: yield* attach({ worktreePath: null }),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("records a checkout's drifted branch and detected pull request once", () =>
    Effect.gen(function* () {
      const model = makeReadModel([libCheckout]);
      const command = yield* sync();
      const synced = yield* decideOrchestrationCommand({ readModel: model, command });
      expect(asEvents(synced)).toMatchObject([
        {
          type: "thread.checkout-attached",
          payload: {
            checkout: {
              projectId: LIB,
              worktreePath: "/lib-wt",
              branch: "feat/y",
              source: "manual",
              checkpointId: "checkpoint-lib",
              pullRequest: { number: 7, state: "open" },
            },
          },
        },
      ]);
      const next = yield* project(model, synced);
      expect(next.threads[0]!.checkouts).toHaveLength(1);
      const repeated = yield* Effect.flip(decideOrchestrationCommand({ readModel: next, command }));
      expect(repeated._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a pull request looked up for a branch the checkout has since left", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: makeReadModel([libCheckout]),
          command: yield* sync({ expectedBranch: "feat/old", branch: "feat/old" }),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects syncing or detaching a project that has no checkout attached", () =>
    Effect.gen(function* () {
      const model = makeReadModel([]);
      const syncError = yield* Effect.flip(
        decideOrchestrationCommand({ readModel: model, command: yield* sync() }),
      );
      expect(syncError._tag).toBe("OrchestrationCommandInvariantError");
      const detachError = yield* Effect.flip(
        decideOrchestrationCommand({ readModel: model, command: yield* detach() }),
      );
      expect(detachError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
