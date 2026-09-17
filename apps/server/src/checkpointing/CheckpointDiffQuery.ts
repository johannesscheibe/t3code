/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  type CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
} from "./Errors.ts";
import type { CheckpointServiceError } from "./Errors.ts";
import {
  checkpointRefForThreadCheckoutTurn,
  checkpointRefForThreadTurn,
  checkpointRefPrefixForThreadCheckout,
  turnCountsOfCheckpointRefs,
} from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    /**
     * Read the patch diff for a single turn checkpoint transition.
     *
     * Verifies checkpoint availability in both projection state and filesystem.
     */
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    /**
     * Read the full patch diff across a thread range of checkpoints.
     *
     * Uses turn-diff semantics with `fromTurnCount = 0`.
     */
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;

  // A diff of an attached checkout reads that checkout's own refs in its own
  // directory. Only a checkout attached to the thread can be read this way.
  const requireAttachedCheckout = Effect.fn("CheckpointDiffQuery.requireAttachedCheckout")(
    function* (
      operation: "CheckpointDiffQuery.getTurnDiff" | "CheckpointDiffQuery.getFullThreadDiff",
      threadId: ThreadId,
      projectId: ProjectId,
    ) {
      const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      const checkout = Option.isSome(thread)
        ? thread.value.checkouts.find((entry) => entry.projectId === projectId)
        : undefined;
      const project = yield* projectionSnapshotQuery.getProjectShellById(projectId);
      const cwd = checkout?.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
      if (checkout === undefined || cwd === undefined) {
        return yield* new CheckpointWorkspacePathMissingError({ operation, threadId });
      }
      // A checkout attached partway through the thread has refs from that turn on.
      const turnCounts = turnCountsOfCheckpointRefs(
        yield* checkpointStore.listCheckpointRefs({
          cwd,
          prefix: checkpointRefPrefixForThreadCheckout(threadId, checkout.checkpointId),
        }),
      );
      return { cwd, checkpointId: checkout.checkpointId, turnCounts };
    },
  );

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const threadContext = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(input.threadId)
        .pipe(Effect.withSpan("checkpoint.turnDiff.lookupContext"));
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointThreadNotFoundError({
          operation,
          threadId: input.threadId,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const toCheckpointRef = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )?.checkpointRef;
      if (!toCheckpointRef) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const attached =
        input.checkoutProjectId === undefined
          ? null
          : yield* requireAttachedCheckout(operation, input.threadId, input.checkoutProjectId);
      // Turns before the attachment changed nothing in the checkout, and a range that
      // straddles the attachment starts at its first ref.
      const attachedFirstTurnCount = attached?.turnCounts[0];
      const attachedFromTurnCount =
        attachedFirstTurnCount === undefined
          ? input.fromTurnCount
          : Math.max(input.fromTurnCount, attachedFirstTurnCount);
      if (attached !== null) {
        if (attachedFirstTurnCount !== undefined && input.toTurnCount <= attachedFirstTurnCount) {
          return buildTurnDiffResult(input, "");
        }
        for (const [checkpoint, turnCount] of [
          ["from", attachedFromTurnCount],
          ["to", input.toTurnCount],
        ] as const) {
          if (!attached.turnCounts.includes(turnCount)) {
            return yield* new CheckpointRefUnavailableError({
              operation,
              threadId: input.threadId,
              turnCount,
              checkpoint,
            });
          }
        }
      }
      const diff = yield* checkpointStore
        .diffCheckpoints(
          attached === null
            ? {
                cwd: workspaceCwd,
                fromCheckpointRef,
                toCheckpointRef,
                fallbackFromToHead: false,
                ignoreWhitespace,
              }
            : {
                cwd: attached.cwd,
                fromCheckpointRef: checkpointRefForThreadCheckoutTurn(
                  input.threadId,
                  attached.checkpointId,
                  attachedFromTurnCount,
                ),
                toCheckpointRef: checkpointRefForThreadCheckoutTurn(
                  input.threadId,
                  attached.checkpointId,
                  input.toTurnCount,
                ),
                fallbackFromToHead: false,
                ignoreWhitespace,
              },
        )
        .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const threadContext = yield* projectionSnapshotQuery
      .getFullThreadDiffContext(input.threadId, input.toTurnCount)
      .pipe(Effect.withSpan("checkpoint.fullThread.lookupContext"));

    if (Option.isNone(threadContext)) {
      return yield* new CheckpointThreadNotFoundError({
        operation,
        threadId: input.threadId,
      });
    }

    if (input.toTurnCount > threadContext.value.latestCheckpointTurnCount) {
      return yield* new CheckpointTurnRangeUnavailableError({
        operation,
        threadId: input.threadId,
        requestedTurnCount: input.toTurnCount,
        availableTurnCount: threadContext.value.latestCheckpointTurnCount,
      });
    }

    const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointWorkspacePathMissingError({
        operation,
        threadId: input.threadId,
      });
    }

    if (!threadContext.value.toCheckpointRef) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    const attached =
      input.checkoutProjectId === undefined
        ? null
        : yield* requireAttachedCheckout(operation, input.threadId, input.checkoutProjectId);
    const attachedFromTurnCount =
      attached?.turnCounts.find((turnCount) => turnCount <= input.toTurnCount) ?? null;
    if (attached !== null && attachedFromTurnCount === null) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: 0,
        checkpoint: "from",
      });
    }

    const diff = yield* checkpointStore
      .diffCheckpoints(
        attached === null || attachedFromTurnCount === null
          ? {
              cwd: workspaceCwd,
              fromCheckpointRef: checkpointRefForThreadTurn(input.threadId, 0),
              toCheckpointRef: threadContext.value.toCheckpointRef as CheckpointRef,
              fallbackFromToHead: false,
              ignoreWhitespace,
            }
          : {
              cwd: attached.cwd,
              fromCheckpointRef: checkpointRefForThreadCheckoutTurn(
                input.threadId,
                attached.checkpointId,
                attachedFromTurnCount,
              ),
              toCheckpointRef: checkpointRefForThreadCheckoutTurn(
                input.threadId,
                attached.checkpointId,
                input.toTurnCount,
              ),
              fallbackFromToHead: false,
              ignoreWhitespace,
            },
      )
      .pipe(Effect.withSpan("checkpoint.fullThread.diffCheckpoints"));

    const turnDiff = buildTurnDiffResult(
      {
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
      },
      diff,
    );
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
