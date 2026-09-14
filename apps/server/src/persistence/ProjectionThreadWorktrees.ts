import { normalizeThreadWorktreePath } from "@t3tools/shared/threadWorktrees";
import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  ThreadWorktreeKey,
  ThreadWorktreeLinkSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export const ProjectionThreadWorktree = Schema.Struct({
  threadId: ThreadId,
  worktreePath: TrimmedNonEmptyString,
  projectId: ProjectId,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  source: ThreadWorktreeLinkSource,
  linkedAt: IsoDateTime,
});
export type ProjectionThreadWorktree = typeof ProjectionThreadWorktree.Type;

export const ListProjectionThreadWorktreesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadWorktreesInput = typeof ListProjectionThreadWorktreesInput.Type;

export const DeleteProjectionThreadWorktreeInput = Schema.Struct({
  threadId: ThreadId,
  ...ThreadWorktreeKey.fields,
});
export type DeleteProjectionThreadWorktreeInput = typeof DeleteProjectionThreadWorktreeInput.Type;

export const DeleteProjectionThreadWorktreesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadWorktreesInput = typeof DeleteProjectionThreadWorktreesInput.Type;

export class ProjectionThreadWorktreeRepository extends Context.Service<
  ProjectionThreadWorktreeRepository,
  {
    readonly upsert: (
      row: ProjectionThreadWorktree,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<ProjectionThreadWorktree>,
      ProjectionRepositoryError
    >;
    readonly listByThreadId: (
      input: ListProjectionThreadWorktreesInput,
    ) => Effect.Effect<ReadonlyArray<ProjectionThreadWorktree>, ProjectionRepositoryError>;
    readonly delete: (
      input: DeleteProjectionThreadWorktreeInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteByThreadId: (
      input: DeleteProjectionThreadWorktreesInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("t3/persistence/ProjectionThreadWorktrees/ProjectionThreadWorktreeRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadWorktree,
    execute: (row) => sql`
      INSERT INTO projection_thread_worktrees (
        thread_id,
        worktree_path,
        project_id,
        branch,
        source,
        linked_at
      )
      VALUES (
        ${row.threadId},
        ${row.worktreePath},
        ${row.projectId},
        ${row.branch},
        ${row.source},
        ${row.linkedAt}
      )
      ON CONFLICT (thread_id, worktree_path)
      DO UPDATE SET
        project_id = excluded.project_id,
        branch = excluded.branch,
        source = excluded.source,
        linked_at = excluded.linked_at
    `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadWorktree,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        worktree_path AS "worktreePath",
        project_id AS "projectId",
        branch,
        source,
        linked_at AS "linkedAt"
      FROM projection_thread_worktrees
      ORDER BY thread_id ASC, linked_at ASC, worktree_path ASC
    `,
  });

  const listRowsByThread = SqlSchema.findAll({
    Request: ListProjectionThreadWorktreesInput,
    Result: ProjectionThreadWorktree,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        worktree_path AS "worktreePath",
        project_id AS "projectId",
        branch,
        source,
        linked_at AS "linkedAt"
      FROM projection_thread_worktrees
      WHERE thread_id = ${threadId}
      ORDER BY linked_at ASC, worktree_path ASC
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteProjectionThreadWorktreeInput,
    execute: ({ threadId, worktreePath }) => sql`
      DELETE FROM projection_thread_worktrees
      WHERE thread_id = ${threadId}
        AND worktree_path = ${worktreePath}
    `,
  });

  const deleteRowsByThread = SqlSchema.void({
    Request: DeleteProjectionThreadWorktreesInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_worktrees
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadWorktreeRepository["Service"]["upsert"] = (row) =>
    upsertRow({ ...row, worktreePath: normalizeThreadWorktreePath(row.worktreePath) }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadWorktreeRepository.upsert:query")),
    );

  const listAll: ProjectionThreadWorktreeRepository["Service"]["listAll"] = () =>
    listAllRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadWorktreeRepository.listAll:query")),
    );

  const listByThreadId: ProjectionThreadWorktreeRepository["Service"]["listByThreadId"] = (input) =>
    listRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadWorktreeRepository.listByThreadId:query"),
      ),
    );

  const deleteLink: ProjectionThreadWorktreeRepository["Service"]["delete"] = (input) =>
    deleteRow({ ...input, worktreePath: normalizeThreadWorktreePath(input.worktreePath) }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadWorktreeRepository.delete:query")),
    );

  const deleteByThreadId: ProjectionThreadWorktreeRepository["Service"]["deleteByThreadId"] = (
    input,
  ) =>
    deleteRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadWorktreeRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listAll,
    listByThreadId,
    delete: deleteLink,
    deleteByThreadId,
  } satisfies ProjectionThreadWorktreeRepository["Service"];
});

export const layer = Layer.effect(ProjectionThreadWorktreeRepository, make);
