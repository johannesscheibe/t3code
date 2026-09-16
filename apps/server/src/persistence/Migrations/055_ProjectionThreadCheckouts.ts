import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_checkouts (
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      worktree_path TEXT,
      branch TEXT,
      pull_request_json TEXT,
      source TEXT NOT NULL,
      attached_at TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, project_id)
    )
  `;
});
