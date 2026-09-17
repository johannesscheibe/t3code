import { ProjectId, ThreadCheckout, ThreadCheckoutPullRequest, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export const ProjectionThreadCheckout = Schema.Struct({
  threadId: ThreadId,
  ...ThreadCheckout.fields,
});
export type ProjectionThreadCheckout = typeof ProjectionThreadCheckout.Type;

export const ProjectionThreadCheckoutDbRow = ProjectionThreadCheckout.mapFields(
  Struct.assign({
    pullRequest: Schema.NullOr(Schema.fromJsonString(ThreadCheckoutPullRequest)),
  }),
);

export const DeleteProjectionThreadCheckoutInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export type DeleteProjectionThreadCheckoutInput = typeof DeleteProjectionThreadCheckoutInput.Type;

export const DeleteProjectionThreadCheckoutsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadCheckoutsInput = typeof DeleteProjectionThreadCheckoutsInput.Type;

export class ProjectionThreadCheckoutRepository extends Context.Service<
  ProjectionThreadCheckoutRepository,
  {
    readonly upsert: (
      row: ProjectionThreadCheckout,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly delete: (
      input: DeleteProjectionThreadCheckoutInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteByThreadId: (
      input: DeleteProjectionThreadCheckoutsInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("t3/persistence/ProjectionThreadCheckouts/ProjectionThreadCheckoutRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadCheckout,
    execute: (row) => sql`
      INSERT INTO projection_thread_checkouts (
        thread_id,
        project_id,
        worktree_path,
        branch,
        pull_request_json,
        source,
        attached_at,
        checkpoint_id
      )
      VALUES (
        ${row.threadId},
        ${row.projectId},
        ${row.worktreePath},
        ${row.branch},
        ${row.pullRequest === null ? null : JSON.stringify(row.pullRequest)},
        ${row.source},
        ${row.attachedAt},
        ${row.checkpointId}
      )
      ON CONFLICT (thread_id, project_id)
      DO UPDATE SET
        worktree_path = excluded.worktree_path,
        branch = excluded.branch,
        pull_request_json = excluded.pull_request_json,
        source = excluded.source,
        attached_at = excluded.attached_at,
        checkpoint_id = excluded.checkpoint_id
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteProjectionThreadCheckoutInput,
    execute: ({ threadId, projectId }) => sql`
      DELETE FROM projection_thread_checkouts
      WHERE thread_id = ${threadId}
        AND project_id = ${projectId}
    `,
  });

  const deleteRowsByThread = SqlSchema.void({
    Request: DeleteProjectionThreadCheckoutsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_checkouts
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadCheckoutRepository["Service"]["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadCheckoutRepository.upsert:query")),
    );

  const deleteCheckout: ProjectionThreadCheckoutRepository["Service"]["delete"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadCheckoutRepository.delete:query")),
    );

  const deleteByThreadId: ProjectionThreadCheckoutRepository["Service"]["deleteByThreadId"] = (
    input,
  ) =>
    deleteRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadCheckoutRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    delete: deleteCheckout,
    deleteByThreadId,
  } satisfies ProjectionThreadCheckoutRepository["Service"];
});

export const layer = Layer.effect(ProjectionThreadCheckoutRepository, make);
