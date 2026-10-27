import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for checkout commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-checkouts" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("attaches and detaches other projects' checkouts", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:checkouts");
    const ownProjectId = ProjectId.make("project:own");
    const otherProjectId = ProjectId.make("project:other");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ownProjectId,
      title: "Checkouts",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("session-attached"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderSessionId.make("session:checkouts"),
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/own",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    const checkout = {
      id: "attachment:1",
      projectId: otherProjectId,
      worktreePath: "/other-worktree",
      branch: "feature",
    };
    const attach = (commandId: string, projectId: ProjectId) =>
      orchestrator.dispatch({
        type: "thread.checkout.attach",
        commandId: CommandId.make(commandId),
        threadId,
        checkout: { ...checkout, projectId },
      });
    const detach = (commandId: string) =>
      orchestrator.dispatch({
        type: "thread.checkout.detach",
        commandId: CommandId.make(commandId),
        threadId,
        projectId: otherProjectId,
      });

    yield* attach("attach", otherProjectId);
    assert.deepEqual((yield* projections.getThread(threadId)).attachedCheckouts, [checkout]);
    assert.deepEqual((yield* projections.getThreadShell(threadId))?.attachedCheckouts, [checkout]);
    // A running turn keeps its session; the next turn's open reloads it.
    assert.deepEqual(
      (yield* projections.getThreadProviderContext(threadId)).providerSessions.map(
        (session) => session.status,
      ),
      ["ready"],
    );

    assert.equal((yield* Effect.exit(attach("attach-again", otherProjectId)))._tag, "Failure");
    assert.equal((yield* Effect.exit(attach("attach-own", ownProjectId)))._tag, "Failure");

    yield* detach("detach");
    assert.deepEqual((yield* projections.getThread(threadId)).attachedCheckouts, []);
    assert.equal((yield* Effect.exit(detach("detach-again")))._tag, "Failure");
  }).pipe(Effect.provide(layerTest)),
);
