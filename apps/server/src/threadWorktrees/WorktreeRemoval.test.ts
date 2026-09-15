// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorktreeRemoval from "./WorktreeRemoval.ts";

function runGit(cwd: string, args: string[]) {
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

const fixture = Effect.acquireRelease(
  Effect.sync(() => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-removal-"));
    const repo = NodePath.join(root, "repo");
    const checkout = NodePath.join(root, "checkout");
    const alias = NodePath.join(root, "alias");
    NodeFS.mkdirSync(repo);
    runGit(repo, ["init", "--initial-branch=main"]);
    runGit(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    runGit(repo, ["worktree", "add", "-b", "feature", checkout]);
    NodeFS.symlinkSync(checkout, alias, "junction");
    NodeFS.writeFileSync(NodePath.join(checkout, "uncommitted.txt"), "keep this\n");
    return { root, repo, checkout, alias };
  }),
  ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

const makeRemoval = (roots: string[]) =>
  WorktreeRemoval.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShells: () =>
            Effect.succeed(
              roots.map(
                (workspaceRoot, index) =>
                  ({
                    id: ProjectId.make(`project-${index}`),
                    title: "Project",
                    workspaceRoot,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  }) satisfies OrchestrationProjectShell,
              ),
            ),
        }),
        Layer.mock(GitWorkflowService)({
          removeWorktree: (input) =>
            Effect.sync(() => runGit(input.cwd, ["worktree", "remove", "--force", input.path])),
        }),
      ),
    ),
  );

describe("WorktreeRemoval", () => {
  it.effect.each(["registered-alias", "requested-alias", "both-alias"] as const)(
    "preserves registered roots and uncommitted files with %s",
    (kind) =>
      Effect.gen(function* () {
        const { repo, checkout, alias } = yield* fixture;
        const remove = yield* makeRemoval([kind === "requested-alias" ? checkout : alias]);
        const error = yield* remove({
          cwd: repo,
          path: kind === "registered-alias" ? checkout : alias,
          force: true,
        }).pipe(Effect.flip);
        expect(error.detail).toContain("registered project's workspace");
        expect(NodeFS.readFileSync(NodePath.join(checkout, "uncommitted.txt"), "utf8")).toBe(
          "keep this\n",
        );
      }),
  );

  it.effect("allows removal of an unregistered checkout even with a missing project root", () =>
    Effect.gen(function* () {
      const { root, repo, checkout } = yield* fixture;
      const remove = yield* makeRemoval([repo, NodePath.join(root, "missing")]);
      yield* remove({ cwd: repo, path: checkout, force: true });
      expect(NodeFS.existsSync(checkout)).toBe(false);
      expect(NodeFS.existsSync(repo)).toBe(true);
    }),
  );
});
