import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_ProjectionThreadWorktreesCheckpointId", (it) => {
  it.effect("adds an optional checkpoint namespace to existing worktree links", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`
        INSERT INTO projection_thread_worktrees
          (thread_id, worktree_path, project_id, branch, source, linked_at)
        VALUES
          ('thread-1', '/tmp/lib-wt', 'project-lib', 'feat/x', 'manual', '2026-03-01T00:00:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 54 });
      const rows = yield* sql<{ readonly checkpointId: string | null }>`
        SELECT checkpoint_id AS "checkpointId" FROM projection_thread_worktrees
      `;
      assert.strictEqual(rows[0]?.checkpointId, null);
    }),
  );
});
