// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2CheckpointScope,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { AttachedCheckoutRoot } from "./AttachedCheckouts.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerTest = CheckpointService.layer.pipe(
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(CheckpointStore.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provideMerge(layerVcsProcess),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-checkout-checkpoints-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    return yield* vcs.run({ operation: "test.git", command: "git", cwd, args, timeoutMs: 10_000 });
  });

const makeRepo = (prefix: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(NodePath.join(cwd, "file.txt"), "before\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial"]);
    return cwd;
  });

it.layer(layerTest)("CheckpointService attached checkouts", (it) => {
  it.effect("captures, restores, and cleans up attached checkouts with the thread", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const store = yield* CheckpointStore.CheckpointStore;
      const primary = yield* makeRepo("t3-primary-");
      const attached = yield* makeRepo("t3-attached-");
      const late = yield* makeRepo("t3-late-");
      const midRun = yield* makeRepo("t3-mid-run-");
      const threadId = ThreadId.make("thread:checkout-checkpoints");
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:checkout-checkpoints"),
        threadId,
        runId: RunId.make("run:checkout-checkpoints:1"),
        nodeId: NodeId.make("node:checkout-checkpoints:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:checkout-checkpoints"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: primary,
        createdAt: yield* DateTime.now,
      };
      const root = (id: string, cwd: string): AttachedCheckoutRoot => ({
        checkout: {
          id,
          projectId: ProjectId.make(`project:${id}`),
          worktreePath: cwd,
          branch: null,
        },
        cwd,
      });
      const attachedRoot = root("attached", attached);
      // Its baseline capture failed: no baseline for it.
      const lateRoot = root("late", late);
      // Attached while run 1 was already running.
      const midRunRoot = root("mid-run", midRun);

      yield* checkpoints.captureBaseline({
        scope,
        ordinalWithinScope: 0,
        checkouts: [attachedRoot],
      });
      yield* checkpoints.captureCheckoutBaselines({
        threadId,
        ordinalWithinScope: 0,
        checkouts: [midRunRoot],
      });
      yield* fileSystem.writeFileString(NodePath.join(attached, "file.txt"), "after\n");
      yield* fileSystem.writeFileString(NodePath.join(midRun, "file.txt"), "after\n");
      yield* fileSystem.writeFileString(NodePath.join(late, "file.txt"), "after\n");
      const checkpoint = yield* checkpoints.capture({
        scope,
        runId: RunId.make("run:checkout-checkpoints:1"),
        nodeId: scope.nodeId,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt: yield* DateTime.now,
        checkouts: [attachedRoot, lateRoot, midRunRoot],
      });

      assert.equal(checkpoint.status, "ready");
      assert.deepEqual(
        checkpoint.checkouts?.map(({ attachmentId, status, files }) => ({
          attachmentId,
          status,
          files: files.map((file) => file.path),
        })),
        [
          { attachmentId: "attached", status: "ready", files: ["file.txt"] },
          { attachmentId: "mid-run", status: "ready", files: ["file.txt"] },
        ],
      );

      const [target, lateTarget] = yield* checkpoints.checkoutRestoreTargets({
        threadId,
        checkouts: [attachedRoot, lateRoot],
        ordinalWithinScope: 0,
      });
      assert.isTrue(target?.available);
      assert.isFalse(lateTarget?.available);

      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
      });
      yield* checkpoints.restore({ scope, checkpoint: baseline, checkouts: [target!] });
      assert.equal(
        yield* fileSystem.readFileString(NodePath.join(attached, "file.txt")),
        "before\n",
      );

      yield* checkpoints.deleteStaleRefs({ scope, checkpoints: [checkpoint] });
      const entry = checkpoint.checkouts![0]!;
      assert.isFalse(yield* store.hasCheckpointRef({ cwd: attached, checkpointRef: entry.ref }));
    }),
  );
});
