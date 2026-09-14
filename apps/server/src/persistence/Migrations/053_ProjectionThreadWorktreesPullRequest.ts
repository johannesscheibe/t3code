import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_worktrees)
  `;

  if (!columns.some((column) => column.name === "pull_request_json")) {
    yield* sql`
      ALTER TABLE projection_thread_worktrees
      ADD COLUMN pull_request_json TEXT
    `;
  }
});
