import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  ThreadWorktreeLink,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { normalizeThreadWorktreePath } from "@t3tools/shared/threadWorktrees";
import { useCallback, useMemo, useState } from "react";

import {
  readEnvironmentThreadRefs,
  readProject,
  readThreadShell,
  useProjects,
  useServerConfigs,
} from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { readLocalApi } from "~/localApi";
import { formatWorktreePathForDisplay, getOrphanedAttachedWorktrees } from "~/worktreeCleanup";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";

const NO_WORKTREES: ReadonlyArray<ThreadWorktreeLink> = [];

/** Commands only log their failures, so a failed action the user started shows a toast. */
function toastCommandFailure(
  title: string,
  result: Parameters<typeof isAtomCommandInterrupted>[0],
): void {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/**
 * Detach a worktree from a thread. Detaching leaves the files; when no other
 * thread uses the worktree, the user is offered the chance to delete it too,
 * the same way deleting a thread does.
 */
function useWorktreeDetach(
  environmentId: EnvironmentId,
  thread: Pick<OrchestrationThreadShell, "id">,
): (link: ThreadWorktreeLink) => Promise<void> {
  const projects = useProjects();
  const detach = useAtomCommand(threadEnvironment.detachWorktree);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree);

  return useCallback(
    async (link: ThreadWorktreeLink) => {
      const environmentProjects = projects.filter(
        (project) => project.environmentId === environmentId,
      );
      const threads = readEnvironmentThreadRefs(environmentId).flatMap((ref) => {
        const shell = readThreadShell(ref);
        return shell === null ? [] : [shell];
      });
      const orphaned = getOrphanedAttachedWorktrees(threads, thread.id, environmentProjects).some(
        (entry) => entry.worktreePath === link.worktreePath,
      );
      const project = readProject({ environmentId, projectId: link.projectId });
      const localApi = readLocalApi();
      let deleteWorktree = false;
      if (orphaned && project !== null && localApi) {
        const confirmation = await settlePromise(() =>
          localApi.dialogs.confirm(
            [
              "No other thread uses this worktree:",
              formatWorktreePathForDisplay(link.worktreePath),
              "",
              "Delete the worktree too?",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmation._tag === "Failure") return;
        deleteWorktree = confirmation.value;
      }
      const detached = await detach({
        environmentId,
        input: { threadId: thread.id, worktreePath: link.worktreePath },
      });
      if (detached._tag === "Failure") {
        toastCommandFailure("Failed to detach worktree", detached);
        return;
      }
      if (!deleteWorktree || project === null) return;
      const removed = await removeWorktree({
        environmentId,
        input: { cwd: project.workspaceRoot, path: link.worktreePath, force: true },
      });
      toastCommandFailure("Worktree detached, but deleting it failed", removed);
    },
    [detach, environmentId, projects, removeWorktree, thread.id],
  );
}

/**
 * Everything a checkout menu needs about a started thread: its attached
 * worktrees, the projects that could still be attached, and the actions on them.
 */
export function useThreadCheckouts(
  environmentId: EnvironmentId,
  thread: Pick<OrchestrationThreadShell, "id" | "projectId" | "branch" | "worktrees">,
) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadWorktrees === true;
  const projects = useProjects();
  const detach = useWorktreeDetach(environmentId, thread);
  const links = thread.worktrees ?? NO_WORKTREES;

  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const attachableProjects = useMemo(
    () =>
      environmentProjects.filter(
        (project) =>
          project.id !== thread.projectId && !links.some((link) => link.projectId === project.id),
      ),
    [environmentProjects, links, thread.projectId],
  );

  return {
    supported,
    links,
    attachableProjects,
    detach,
    projectTitle: (projectId: ProjectId) =>
      environmentProjects.find((project) => project.id === projectId)?.title ?? projectId,
    /** An attached checkout that is its project's own root rather than a worktree. */
    isLocalCheckout: (link: ThreadWorktreeLink) => {
      const root = environmentProjects.find(
        (project) => project.id === link.projectId,
      )?.workspaceRoot;
      return (
        root !== undefined &&
        normalizeThreadWorktreePath(root) === normalizeThreadWorktreePath(link.worktreePath)
      );
    },
    defaultBranch:
      thread.branch !== null && !isTemporaryWorktreeBranch(thread.branch) ? thread.branch : null,
  };
}

export function AttachWorktreeDialog({
  environmentId,
  threadId,
  projects,
  defaultBranch,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projects: ReadonlyArray<EnvironmentProject>;
  defaultBranch: string | null;
  onClose: () => void;
}) {
  const attach = useAtomCommand(vcsEnvironment.attachThreadWorktree);
  const [projectId, setProjectId] = useState<ProjectId | null>(projects[0]?.id ?? null);
  const [existingPath, setExistingPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branch, setBranch] = useState(defaultBranch ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const reuseExisting = existingPath.trim().length > 0;

  const submit = async () => {
    if (project === null || pending) return;
    setPending(true);
    setError(null);
    const result = await attach({
      environmentId,
      input: {
        threadId,
        projectId: project.id,
        ...(reuseExisting
          ? { worktreePath: existingPath.trim() }
          : {
              ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
              ...(branch.trim() ? { branch: branch.trim() } : {}),
              runSetupScript: true,
            }),
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not attach the worktree.");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach worktree</DialogTitle>
          <DialogDescription>
            Work on another project from this thread. The agent gets access to the worktree on its
            next turn.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Project</span>
            <Select
              modal={false}
              value={projectId}
              onValueChange={(value: string | null) => setProjectId(value as ProjectId | null)}
              items={projects.map((candidate) => ({ value: candidate.id, label: candidate.title }))}
            >
              <SelectTrigger size="sm" aria-label="Project">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {projects.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">New branch</span>
            <Input
              value={branch}
              disabled={reuseExisting}
              placeholder="Branch to create in the new worktree"
              onChange={(event) => setBranch(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Base branch</span>
            <Input
              value={baseBranch}
              disabled={reuseExisting}
              placeholder="Defaults to the project's current branch"
              onChange={(event) => setBaseBranch(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Existing worktree path</span>
            <Input
              value={existingPath}
              placeholder="Leave empty to create a new worktree"
              onChange={(event) => setExistingPath(event.target.value)}
            />
          </label>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={project === null || pending || (!reuseExisting && branch.trim() === "")}
            onClick={() => void submit()}
          >
            {pending ? "Attaching..." : reuseExisting ? "Attach" : "Create and attach"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
