import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  ThreadWorktreeLink,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  CopyIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  GitPullRequestIcon,
  UnlinkIcon,
} from "lucide-react";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { memo, useMemo, useState } from "react";

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
import { composerFloatingLayerProps } from "./chat/composerEventScope";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
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

interface ThreadWorktreesControlProps {
  environmentId: EnvironmentId;
  thread: Pick<OrchestrationThreadShell, "id" | "projectId" | "branch" | "worktrees">;
}

/**
 * Worktrees of other projects attached to a started thread. Each chip copies
 * its path or detaches it; the trailing button attaches another project.
 */
export const ThreadWorktreesControl = memo(function ThreadWorktreesControl({
  environmentId,
  thread,
}: ThreadWorktreesControlProps) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadWorktrees === true;
  const projects = useProjects();
  const detach = useAtomCommand(threadEnvironment.detachWorktree);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree);
  const [dialogOpen, setDialogOpen] = useState(false);
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

  // Detaching leaves the files. When no other thread uses the worktree, offer
  // to delete it too, the same way deleting a thread does.
  const detachWorktree = async (link: ThreadWorktreeLink) => {
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
  };

  if (!supported) {
    return null;
  }

  return (
    <>
      {links.map((link) => {
        const title =
          environmentProjects.find((project) => project.id === link.projectId)?.title ??
          formatWorktreePathForDisplay(link.worktreePath);
        return (
          <Menu key={link.worktreePath}>
            <MenuTrigger
              render={<Button variant="ghost" size="xs" />}
              className="min-w-0 shrink font-normal text-muted-foreground/70 text-xs! hover:text-foreground/80"
              title={link.worktreePath}
              data-composer-context-control
            >
              <FolderGit2Icon className="size-3 shrink-0" />
              <span className="min-w-0 max-w-[180px] truncate">
                {[title, link.branch, link.pullRequest ? `#${link.pullRequest.number}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </MenuTrigger>
            <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
              {link.pullRequest ? (
                <MenuItem
                  onClick={() => {
                    if (link.pullRequest) {
                      void readLocalApi()?.shell.openExternal(link.pullRequest.url);
                    }
                  }}
                >
                  <GitPullRequestIcon className="size-3.5" />
                  Open pull request #{link.pullRequest.number}
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => void navigator.clipboard.writeText(link.worktreePath)}>
                <CopyIcon className="size-3.5" />
                Copy path
              </MenuItem>
              <MenuItem onClick={() => void detachWorktree(link)}>
                <UnlinkIcon className="size-3.5" />
                Detach from thread
              </MenuItem>
            </MenuPopup>
          </Menu>
        );
      })}
      {attachableProjects.length > 0 ? (
        <Button
          variant="ghost"
          size="xs"
          className="font-normal text-muted-foreground/70 hover:text-foreground/80"
          aria-label="Attach worktree"
          title="Attach a worktree of another project"
          data-composer-context-control
          onClick={() => setDialogOpen(true)}
        >
          <FolderPlusIcon className="size-3" />
        </Button>
      ) : null}
      {dialogOpen ? (
        <AttachWorktreeDialog
          environmentId={environmentId}
          threadId={thread.id}
          projects={attachableProjects}
          defaultBranch={
            thread.branch !== null && !isTemporaryWorktreeBranch(thread.branch)
              ? thread.branch
              : null
          }
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  );
});

function AttachWorktreeDialog({
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
