import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_ProjectionThreadWorktrees", (it) => {
  it.effect("creates the worktree link table keyed by thread and path", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      yield* sql`
        INSERT INTO projection_thread_worktrees
          (thread_id, worktree_path, project_id, branch, source, linked_at)
        VALUES
          ('thread-1', '/tmp/lib-wt', 'project-lib', 'feat/x', 'agent', '2026-03-01T00:00:00.000Z')
      `;
      const duplicate = yield* sql`
        INSERT INTO projection_thread_worktrees
          (thread_id, worktree_path, project_id, branch, source, linked_at)
        VALUES
          ('thread-1', '/tmp/lib-wt', 'project-lib', 'feat/y', 'manual', '2026-03-02T00:00:00.000Z')
      `.pipe(
        Effect.as("inserted"),
        Effect.orElseSucceed(() => "rejected"),
      );
      assert.strictEqual(duplicate, "rejected");

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_worktrees
      `;
      assert.strictEqual(rows[0]?.count, 1);
    }),
  );
});
