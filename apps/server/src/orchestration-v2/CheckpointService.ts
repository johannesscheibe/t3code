import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { AttachedCheckoutRoot } from "./AttachedCheckouts.ts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";

export class CheckpointRootScopePrepareError extends Schema.TaggedError<CheckpointRootScopePrepareError>()(
  "CheckpointRootScopePrepareError",
  {
    threadId: ThreadId,
    runId: RunId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare root checkpoint scope for run ${this.runId}.`;
  }
}

export class CheckpointScopeEnsureError extends Schema.TaggedError<CheckpointScopeEnsureError>()(
  "CheckpointScopeEnsureError",
  {
    scopeId: CheckpointScopeId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ensure checkpoint scope ${this.scopeId}.`;
  }
}

export class CheckpointBaselineCaptureError extends Schema.TaggedError<CheckpointBaselineCaptureError>()(
  "CheckpointBaselineCaptureError",
  {
    scopeId: CheckpointScopeId,
    ordinalWithinScope: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint baseline ${this.ordinalWithinScope} for scope ${this.scopeId}.`;
  }
}

export class CheckpointCaptureError extends Schema.TaggedError<CheckpointCaptureError>()(
  "CheckpointCaptureError",
  {
    scopeId: CheckpointScopeId,
    parentCheckpointId: Schema.optional(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint for scope ${this.scopeId}.`;
  }
}

export class CheckpointRestoreError extends Schema.TaggedError<CheckpointRestoreError>()(
  "CheckpointRestoreError",
  {
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restore checkpoint ${this.checkpointId} for scope ${this.scopeId}.`;
  }
}

export class CheckpointDeleteStaleRefsError extends Schema.TaggedError<CheckpointDeleteStaleRefsError>()(
  "CheckpointDeleteStaleRefsError",
  {
    scopeId: CheckpointScopeId,
    checkpointIds: Schema.Array(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete stale checkpoint refs for scope ${this.scopeId}.`;
  }
}

export const CheckpointServiceV2Error = Schema.Union([
  CheckpointRootScopePrepareError,
  CheckpointScopeEnsureError,
  CheckpointBaselineCaptureError,
  CheckpointCaptureError,
  CheckpointRestoreError,
  CheckpointDeleteStaleRefsError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly ensureScope: (
    scope: OrchestrationV2CheckpointScope,
  ) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /** Attached checkouts of a root run; each gets the same ordinal under its own ref. */
    readonly checkouts?: ReadonlyArray<AttachedCheckoutRoot>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /** Baselines for attached checkouts only, such as one attached during a run. */
  readonly captureCheckoutBaselines: (input: {
    readonly threadId: ThreadId;
    readonly ordinalWithinScope: number;
    readonly checkouts: ReadonlyArray<AttachedCheckoutRoot>;
  }) => Effect.Effect<void>;
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly capturedAt: DateTime.Utc;
    /**
     * Attached checkouts of a root run. One without a baseline for this run
     * (its baseline capture failed) starts its history at the next run instead.
     */
    readonly checkouts?: ReadonlyArray<AttachedCheckoutRoot>;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly restore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
    /** Attached checkouts to restore too, checked beforehand by checkoutRestoreTargets. */
    readonly checkouts?: ReadonlyArray<CheckoutRestoreTarget>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /** Each attached checkout's ref for an ordinal, and whether it can be restored to it. */
  readonly checkoutRestoreTargets: (input: {
    readonly threadId: ThreadId;
    readonly checkouts: ReadonlyArray<AttachedCheckoutRoot>;
    readonly ordinalWithinScope: number;
  }) => Effect.Effect<ReadonlyArray<CheckoutRestoreTarget & { readonly available: boolean }>>;
  readonly deleteStaleRefs: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

export interface CheckoutRestoreTarget {
  readonly root: AttachedCheckoutRoot;
  readonly ref: CheckpointRef;
}

/**
 * An attached checkout's ref for a run ordinal. Keyed by thread and
 * attachment, so re-attaching starts a fresh history and a subagent that
 * inherits its parent's attachments does not overwrite the parent's refs.
 */
export const checkpointRefForCheckoutOrdinal = Effect.fn("checkpointRefForCheckoutOrdinal")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly ordinalWithinScope: number;
  }) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`${input.threadId}\n${input.attachmentId}`))
      .pipe(Effect.orDie);
    return CheckpointRef.make(
      `${CHECKPOINT_REFS_PREFIX}/checkout/${Hex.encode(digest).slice(0, 32)}/ordinal/${input.ordinalWithinScope}`,
    );
  },
);

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  function* (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(input.scopeId))
      .pipe(Effect.orDie);
    const scopeKey = Hex.encode(digest).slice(0, 32);
    return CheckpointRef.make(
      `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}/ordinal/${input.ordinalWithinScope}`,
    );
  },
);

function checkpointIdForScopeOrdinal(
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
  input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
  },
) {
  return idAllocator.allocate.checkpoint({
    checkpointScopeId: input.scopeId,
    name: String(input.ordinalWithinScope),
  });
}

function makeRootRunScope(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly cwd: string;
  readonly createdAt: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const scopeId = yield* input.idAllocator.allocate.checkpointScope({
      threadId: input.threadId,
      name: ROOT_CHECKPOINT_SCOPE_NAME,
    });
    return {
      id: scopeId,
      threadId: input.threadId,
      runId: input.runId,
      nodeId: input.rootNodeId,
      parentScopeId: null,
      providerThreadId: input.providerThreadId,
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: input.cwd,
      createdAt: input.createdAt,
    } satisfies OrchestrationV2CheckpointScope;
  });
}

function makeCheckpoint(input: {
  readonly id: CheckpointId;
  readonly scope: OrchestrationV2CheckpointScope;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly parentCheckpointId: CheckpointId | null;
  readonly ordinalWithinScope: number;
  readonly appRunOrdinal: number | null;
  readonly ref: CheckpointRef;
  readonly status: OrchestrationV2Checkpoint["status"];
  readonly files: OrchestrationV2Checkpoint["files"];
  readonly capturedAt: DateTime.Utc;
}): OrchestrationV2Checkpoint {
  return {
    id: input.id,
    threadId: input.scope.threadId,
    scopeId: input.scope.id,
    runId: input.runId,
    nodeId: input.nodeId,
    parentCheckpointId: input.parentCheckpointId,
    ordinalWithinScope: input.ordinalWithinScope,
    appRunOrdinal: input.appRunOrdinal,
    ref: input.ref,
    status: input.status,
    files: input.files,
    capturedAt: input.capturedAt,
  };
}

export const layer: Layer.Layer<
  CheckpointServiceV2,
  never,
  CheckpointStore.CheckpointStore | Crypto.Crypto | IdAllocator.IdAllocatorV2
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const crypto = yield* Crypto.Crypto;
    const checkpointRefFor = (input: Parameters<typeof checkpointRefForScopeOrdinal>[0]) =>
      checkpointRefForScopeOrdinal(input).pipe(Effect.provideService(Crypto.Crypto, crypto));
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const workspaceLocks = yield* KeyedLock.make<string>();
    const withWorkspaceLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      workspaceLocks.withLock(cwd, effect);

    const isGitCheckpointable = (cwd: string) =>
      checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));

    const ensureScope: CheckpointServiceV2Shape["ensureScope"] = (scope) => Effect.succeed(scope);

    const checkoutRefFor = (input: Parameters<typeof checkpointRefForCheckoutOrdinal>[0]) =>
      checkpointRefForCheckoutOrdinal(input).pipe(Effect.provideService(Crypto.Crypto, crypto));

    const captureBaselineAt = (cwd: string, checkpointRef: CheckpointRef) =>
      withWorkspaceLock(
        cwd,
        Effect.gen(function* () {
          if (!(yield* isGitCheckpointable(cwd))) {
            return;
          }
          const exists = yield* checkpointStore.hasCheckpointRef({ cwd, checkpointRef });
          if (exists) {
            return;
          }
          yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef });
        }),
      );

    const captureCheckoutBaselines: CheckpointServiceV2Shape["captureCheckoutBaselines"] = (
      input,
    ) =>
      Effect.forEach(
        input.checkouts,
        (root) =>
          checkoutRefFor({
            threadId: input.threadId,
            attachmentId: root.checkout.id,
            ordinalWithinScope: input.ordinalWithinScope,
          }).pipe(
            Effect.flatMap((checkpointRef) => captureBaselineAt(root.cwd, checkpointRef)),
            // Without a baseline this checkout only misses this run's diff.
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 attached checkout baseline capture failed", {
                threadId: input.threadId,
                projectId: root.checkout.projectId,
                cause: String(cause),
              }),
            ),
          ),
        { discard: true },
      );

    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = (input) =>
      captureCheckoutBaselines({
        threadId: input.scope.threadId,
        ordinalWithinScope: input.ordinalWithinScope,
        checkouts: input.checkouts ?? [],
      }).pipe(
        Effect.andThen(
          checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          }),
        ),
        Effect.flatMap((checkpointRef) => captureBaselineAt(input.scope.cwd, checkpointRef)),
        Effect.mapError(
          (cause) =>
            new CheckpointBaselineCaptureError({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
              cause,
            }),
        ),
      );

    const materializeBaselineCheckpoint: CheckpointServiceV2Shape["materializeBaselineCheckpoint"] =
      (input) =>
        withWorkspaceLock(
          input.scope.cwd,
          Effect.gen(function* () {
            const checkpointRef = yield* checkpointRefFor({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointable = yield* isGitCheckpointable(input.scope.cwd);
            const available = checkpointable
              ? yield* checkpointStore
                  .hasCheckpointRef({
                    cwd: input.scope.cwd,
                    checkpointRef,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                        scopeId: input.scope.id,
                        checkpointRef,
                        cause: String(cause),
                      }).pipe(Effect.as(false)),
                    ),
                  )
              : false;
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: null,
              nodeId: input.scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: null,
              ref: checkpointRef,
              status: available ? "ready" : "missing",
              files: [],
              capturedAt: input.scope.createdAt,
            });
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        );

    /** Captures `cwd` at `checkpointRef` and summarizes the files changed since `previousCheckpointRef`. */
    const captureRoot = (input: {
      readonly cwd: string;
      readonly checkpointRef: CheckpointRef;
      readonly previousCheckpointRef: CheckpointRef;
      readonly logContext: Record<string, unknown>;
    }) =>
      Effect.gen(function* () {
        if (!(yield* isGitCheckpointable(input.cwd))) {
          return { status: "missing" as const, files: [] };
        }

        const captured = yield* checkpointStore
          .captureCheckpoint({
            cwd: input.cwd,
            checkpointRef: input.checkpointRef,
          })
          .pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 checkpoint capture failed", {
                ...input.logContext,
                checkpointRef: input.checkpointRef,
                cause: String(cause),
              }).pipe(Effect.as(false)),
            ),
          );
        if (!captured) {
          return { status: "error" as const, files: [] };
        }

        const previousExists = yield* checkpointStore
          .hasCheckpointRef({
            cwd: input.cwd,
            checkpointRef: input.previousCheckpointRef,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 previous checkpoint ref lookup failed", {
                ...input.logContext,
                checkpointRef: input.previousCheckpointRef,
                cause: String(cause),
              }).pipe(Effect.as(false)),
            ),
          );
        const refs = {
          cwd: input.cwd,
          fromCheckpointRef: input.previousCheckpointRef,
          toCheckpointRef: input.checkpointRef,
        };
        // A pull or rebase can change thousands of files the turn did not write.
        // Keep only the files the turn's own work touched.
        const files: OrchestrationV2Checkpoint["files"] = previousExists
          ? yield* Effect.all([
              checkpointStore.diffCheckpoints({
                ...refs,
                fallbackFromToHead: false,
                ignoreWhitespace: false,
                format: "numstat",
              }),
              checkpointStore.listAuthoredPaths(refs).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration V2 checkpoint authored paths failed", {
                    ...input.logContext,
                    checkpointRef: input.checkpointRef,
                    cause: String(cause),
                  }).pipe(Effect.as(null)),
                ),
              ),
            ]).pipe(
              Effect.map(([diff, authoredPaths]) =>
                parseTurnDiffFilesFromNumstat(diff)
                  .filter((file) => !isGitImport(file, authoredPaths))
                  .map((file) => ({
                    path: file.path,
                    kind: "modified",
                    additions: file.additions,
                    deletions: file.deletions,
                  })),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint diff summary failed", {
                  ...input.logContext,
                  checkpointRef: input.checkpointRef,
                  cause: String(cause),
                }).pipe(Effect.as([])),
              ),
            )
          : [];
        return { status: "ready" as const, files };
      });

    const captureCheckout = (input: {
      readonly threadId: ThreadId;
      readonly scopeId: CheckpointScopeId;
      readonly root: AttachedCheckoutRoot;
      readonly ordinalWithinScope: number;
    }) =>
      Effect.gen(function* () {
        const refFor = (ordinalWithinScope: number) =>
          checkoutRefFor({
            threadId: input.threadId,
            attachmentId: input.root.checkout.id,
            ordinalWithinScope,
          });
        const checkpointRef = yield* refFor(input.ordinalWithinScope);
        const previousCheckpointRef = yield* refFor(Math.max(0, input.ordinalWithinScope - 1));
        return yield* withWorkspaceLock(
          input.root.cwd,
          Effect.gen(function* () {
            // No baseline means its capture failed; the checkout's history
            // starts with the next run's baseline.
            const hasBaseline =
              (yield* isGitCheckpointable(input.root.cwd)) &&
              (yield* checkpointStore
                .hasCheckpointRef({ cwd: input.root.cwd, checkpointRef: previousCheckpointRef })
                .pipe(Effect.orElseSucceed(() => false)));
            if (!hasBaseline) {
              return [];
            }
            const { status, files } = yield* captureRoot({
              cwd: input.root.cwd,
              checkpointRef,
              previousCheckpointRef,
              logContext: { scopeId: input.scopeId, projectId: input.root.checkout.projectId },
            });
            return [
              {
                attachmentId: input.root.checkout.id,
                projectId: input.root.checkout.projectId,
                cwd: input.root.cwd,
                ref: checkpointRef,
                status,
                files,
              },
            ];
          }),
        );
      });

    const capture: CheckpointServiceV2Shape["capture"] = (input) =>
      Effect.gen(function* () {
        const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
          scopeId: input.scope.id,
          ordinalWithinScope: input.ordinalWithinScope,
        });
        const parentCheckpointId =
          input.ordinalWithinScope > 0
            ? yield* checkpointIdForScopeOrdinal(idAllocator, {
                scopeId: input.scope.id,
                ordinalWithinScope: input.ordinalWithinScope - 1,
              })
            : null;
        const checkpointRef = yield* checkpointRefFor({
          scopeId: input.scope.id,
          ordinalWithinScope: input.ordinalWithinScope,
        });
        const previousCheckpointRef = yield* checkpointRefFor({
          scopeId: input.scope.id,
          ordinalWithinScope: Math.max(0, input.ordinalWithinScope - 1),
        });

        const { status, files } = yield* withWorkspaceLock(
          input.scope.cwd,
          captureRoot({
            cwd: input.scope.cwd,
            checkpointRef,
            previousCheckpointRef,
            logContext: { scopeId: input.scope.id },
          }),
        );
        const checkouts = (yield* Effect.forEach(input.checkouts ?? [], (root) =>
          captureCheckout({
            threadId: input.scope.threadId,
            scopeId: input.scope.id,
            root,
            ordinalWithinScope: input.ordinalWithinScope,
          }),
        )).flat();

        return {
          ...makeCheckpoint({
            id: checkpointId,
            scope: input.scope,
            runId: input.runId,
            nodeId: input.nodeId,
            parentCheckpointId,
            ordinalWithinScope: input.ordinalWithinScope,
            appRunOrdinal: input.appRunOrdinal,
            ref: checkpointRef,
            status,
            files,
            capturedAt: input.capturedAt,
          }),
          ...(checkouts.length === 0 ? {} : { checkouts }),
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointCaptureError({
              scopeId: input.scope.id,
              cause,
            }),
        ),
      );

    const restore: CheckpointServiceV2Shape["restore"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (input.checkpoint.status !== "ready") {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: `Checkpoint status is ${input.checkpoint.status}.`,
            });
          }

          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd: input.scope.cwd,
            checkpointRef: input.checkpoint.ref,
            fallbackToHead: false,
          });
          if (!restored) {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: "Checkpoint ref is unavailable.",
            });
          }
        }),
      ).pipe(
        // A failure here leaves the checkouts restored so far restored; the
        // error names the one that failed.
        Effect.andThen(
          Effect.forEach(
            input.checkouts ?? [],
            (target) =>
              withWorkspaceLock(
                target.root.cwd,
                checkpointStore.restoreCheckpoint({
                  cwd: target.root.cwd,
                  checkpointRef: target.ref,
                  fallbackToHead: false,
                }),
              ).pipe(
                Effect.flatMap((restored) =>
                  restored
                    ? Effect.void
                    : Effect.fail(
                        new CheckpointRestoreError({
                          scopeId: input.scope.id,
                          checkpointId: input.checkpoint.id,
                          cause: `Checkpoint ref is unavailable in ${target.root.cwd}.`,
                        }),
                      ),
                ),
              ),
            { discard: true },
          ),
        ),
        Effect.mapError((cause) =>
          isCheckpointRestoreError(cause)
            ? cause
            : new CheckpointRestoreError({
                scopeId: input.scope.id,
                checkpointId: input.checkpoint.id,
                cause,
              }),
        ),
      );

    const checkoutRestoreTargets: CheckpointServiceV2Shape["checkoutRestoreTargets"] = (input) =>
      Effect.forEach(input.checkouts, (root) =>
        checkoutRefFor({
          threadId: input.threadId,
          attachmentId: root.checkout.id,
          ordinalWithinScope: input.ordinalWithinScope,
        }).pipe(
          Effect.flatMap((ref) =>
            isGitCheckpointable(root.cwd).pipe(
              Effect.flatMap((git) =>
                git
                  ? checkpointStore
                      .hasCheckpointRef({ cwd: root.cwd, checkpointRef: ref })
                      .pipe(Effect.orElseSucceed(() => false))
                  : Effect.succeed(false),
              ),
              Effect.map((available) => ({ root, ref, available })),
            ),
          ),
        ),
      );

    const deleteStaleRefs: CheckpointServiceV2Shape["deleteStaleRefs"] = (input) =>
      Effect.forEach(
        // Attached checkouts captured with these checkpoints, including ones detached since.
        Map.groupBy(
          input.checkpoints.flatMap((checkpoint) => checkpoint.checkouts ?? []),
          (entry) => entry.cwd,
        ),
        ([cwd, entries]) =>
          withWorkspaceLock(
            cwd,
            checkpointStore.deleteCheckpointRefs({
              cwd,
              checkpointRefs: entries.map((entry) => entry.ref),
            }),
          ).pipe(
            // A removed worktree took its refs with it.
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 attached checkout ref cleanup failed", {
                scopeId: input.scope.id,
                cwd,
                cause: String(cause),
              }),
            ),
          ),
        { discard: true },
      )
        .pipe(
          Effect.andThen(
            withWorkspaceLock(
              input.scope.cwd,
              checkpointStore.deleteCheckpointRefs({
                cwd: input.scope.cwd,
                checkpointRefs: input.checkpoints.map((checkpoint) => checkpoint.ref),
              }),
            ),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointDeleteStaleRefsError({
                scopeId: input.scope.id,
                checkpointIds: input.checkpoints.map((checkpoint) => checkpoint.id),
                cause,
              }),
          ),
        );

    return CheckpointServiceV2.of({
      prepareRootRunScope: (input) =>
        makeRootRunScope({ ...input, idAllocator }).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointRootScopePrepareError({
                threadId: input.threadId,
                runId: input.runId,
                cause,
              }),
          ),
        ),
      ensureScope,
      captureBaseline,
      captureCheckoutBaselines,
      materializeBaselineCheckpoint,
      capture,
      restore,
      checkoutRestoreTargets,
      deleteStaleRefs,
    } satisfies CheckpointServiceV2Shape);
  }),
);
