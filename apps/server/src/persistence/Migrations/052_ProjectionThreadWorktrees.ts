import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_worktrees (
      thread_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch TEXT,
      source TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, worktree_path)
    )
  `;
});
