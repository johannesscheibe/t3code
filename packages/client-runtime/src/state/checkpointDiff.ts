import type {
  EnvironmentId,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export type CheckpointDiffResult =
  | OrchestrationGetTurnDiffResult
  | OrchestrationGetFullThreadDiffResult;

export interface CheckpointDiffState {
  readonly data: CheckpointDiffResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface CheckpointDiffTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
  readonly cacheScope?: string | null;
  /** The project of an attached checkout to diff instead of the thread's own workspace. */
  readonly checkoutProjectId?: ProjectId | null;
}
