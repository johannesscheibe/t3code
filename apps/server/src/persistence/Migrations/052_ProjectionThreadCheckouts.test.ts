import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_ProjectionThreadCheckouts", (it) => {
  it.effect("keys checkouts by thread and project, with a nullable worktree path", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      yield* sql`
        INSERT INTO projection_thread_checkouts
          (thread_id, project_id, worktree_path, branch, source, attached_at, checkpoint_id)
        VALUES
          ('thread-1', 'project-lib', NULL, 'main', 'agent', '2026-03-01T00:00:00.000Z', 'c-1')
      `;
      const duplicate = yield* sql`
        INSERT INTO projection_thread_checkouts
          (thread_id, project_id, worktree_path, branch, source, attached_at, checkpoint_id)
        VALUES
          ('thread-1', 'project-lib', '/tmp/lib-wt', 'feat/y', 'manual', '2026-03-02T00:00:00.000Z', 'c-2')
      `.pipe(
        Effect.as("inserted"),
        Effect.orElseSucceed(() => "rejected"),
      );
      assert.strictEqual(duplicate, "rejected");

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_checkouts
      `;
      assert.strictEqual(rows[0]?.count, 1);
    }),
  );
});
