import {
  OrchestrationCommand,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadWorktreeLink,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function singleEvent(decided: PlannedEvent | ReadonlyArray<PlannedEvent>): PlannedEvent {
  const event = Array.isArray(decided) ? decided[0] : (decided as PlannedEvent);
  if (event === undefined) throw new Error("expected an event");
  return event;
}

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const APP = ProjectId.make("project-app");
const LIB = ProjectId.make("project-lib");

function makeReadModel(worktrees: ReadonlyArray<ThreadWorktreeLink>): OrchestrationReadModel {
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
        worktrees,
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

const libLink: ThreadWorktreeLink = {
  worktreePath: "/lib-wt",
  projectId: LIB,
  branch: "feat/x",
  source: "manual",
  linkedAt: NOW,
};

const attach = (overrides: Record<string, unknown> = {}) =>
  decodeCommand({
    type: "thread.worktree.attach",
    commandId: "attach",
    threadId: THREAD_ID,
    worktreePath: "/lib-wt",
    projectId: LIB,
    branch: "feat/x",
    source: "agent",
    ...overrides,
  });

it.layer(NodeServices.layer)("thread worktree decider", (it) => {
  it.effect("attaches a worktree of another project, then detaches it", () =>
    Effect.gen(function* () {
      let model = makeReadModel([]);
      const attached = singleEvent(
        yield* decideOrchestrationCommand({ readModel: model, command: yield* attach() }),
      );
      expect(attached.type).toBe("thread.worktree-attached");
      const attachDecision = yield* decideOrchestrationCommand({
        readModel: model,
        command: yield* attach(),
      });
      expect(
        (Array.isArray(attachDecision) ? attachDecision : [attachDecision]).map(
          (event) => event.type,
        ),
      ).toEqual(["thread.worktree-attached", "thread.activity-appended"]);
      model = yield* projectEvent(model, { ...attached, sequence: 1 } as OrchestrationEvent);
      expect(model.threads[0]!.worktrees).toEqual([
        {
          worktreePath: "/lib-wt",
          projectId: LIB,
          branch: "feat/x",
          source: "agent",
          linkedAt: expect.any(String),
        },
      ]);

      const detach = yield* decodeCommand({
        type: "thread.worktree.detach",
        commandId: "detach",
        threadId: THREAD_ID,
        worktreePath: "/lib-wt/",
      });
      const detached = singleEvent(
        yield* decideOrchestrationCommand({ readModel: model, command: detach }),
      );
      expect(detached.type).toBe("thread.worktree-detached");
      model = yield* projectEvent(model, { ...detached, sequence: 2 } as OrchestrationEvent);
      expect(model.threads[0]!.worktrees).toEqual([]);
    }),
  );

  it.effect("rejects a worktree of the thread's own project", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: makeReadModel([]),
          command: yield* attach({ projectId: APP, worktreePath: "/app-other" }),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a second worktree of a project that is already attached", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: makeReadModel([libLink]),
          command: yield* attach({ worktreePath: "/lib-wt-2" }),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("records a worktree's drifted branch and detected pull request once", () =>
    Effect.gen(function* () {
      const model = makeReadModel([libLink]);
      const sync = yield* decodeCommand({
        type: "thread.worktree.sync",
        commandId: "sync",
        threadId: THREAD_ID,
        worktreePath: "/lib-wt",
        branch: "feat/y",
        pullRequest: { number: 7, url: "https://github.com/acme/lib/pull/7", state: "open" },
      });
      const synced = singleEvent(
        yield* decideOrchestrationCommand({ readModel: model, command: sync }),
      );
      expect(synced).toMatchObject({
        type: "thread.worktree-attached",
        payload: {
          link: {
            worktreePath: "/lib-wt",
            branch: "feat/y",
            source: "manual",
            pullRequest: { number: 7, state: "open" },
          },
        },
      });
      const next = yield* projectEvent(model, { ...synced, sequence: 1 } as OrchestrationEvent);
      const repeated = yield* Effect.flip(
        decideOrchestrationCommand({ readModel: next, command: sync }),
      );
      expect(repeated._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect(
    "compares an attachment with the thread's own workspace, not the attached project's",
    () =>
      Effect.gen(function* () {
        const base = makeReadModel([]);
        const localThread: OrchestrationReadModel = {
          ...base,
          threads: base.threads.map((thread) => ({ ...thread, worktreePath: null })),
        };
        const mainCheckout = yield* decideOrchestrationCommand({
          readModel: localThread,
          command: yield* attach({ worktreePath: "/lib" }),
        });
        expect(singleEvent(mainCheckout).type).toBe("thread.worktree-attached");

        const ownCheckout = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel: localThread,
            command: yield* attach({ worktreePath: "/app" }),
          }),
        );
        expect(ownCheckout._tag).toBe("OrchestrationCommandInvariantError");
      }),
  );

  it.effect("rejects detaching a worktree that is not attached", () =>
    Effect.gen(function* () {
      const detach = yield* decodeCommand({
        type: "thread.worktree.detach",
        commandId: "detach",
        threadId: THREAD_ID,
        worktreePath: "/lib-wt",
      });
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ readModel: makeReadModel([]), command: detach }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
