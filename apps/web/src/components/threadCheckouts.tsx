import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ProjectId,
  ThreadCheckout,
  ThreadCheckoutAttachTarget,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  readEnvironmentThreadRefs,
  readProject,
  readProjects,
  readThreadShell,
  useProjects,
  useServerConfigs,
} from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { readLocalApi } from "~/localApi";
import { formatWorktreePathForDisplay, getOrphanedCheckoutWorktrees } from "~/worktreeCleanup";
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

type CheckoutAttachMode = ThreadCheckoutAttachTarget["type"];

const CHECKOUT_ATTACH_MODE_ITEMS: ReadonlyArray<{ value: CheckoutAttachMode; label: string }> = [
  { value: "local", label: "Local checkout" },
  { value: "new-worktree", label: "New worktree" },
  { value: "existing", label: "Existing path" },
];

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
 * Detach a checkout from a thread. Detaching leaves the files; when the checkout
 * is a worktree no other thread uses, the user is offered the chance to delete
 * it too, the same way deleting a thread does.
 */
function useCheckoutDetach(
  environmentId: EnvironmentId,
  thread: Pick<OrchestrationThreadShell, "id">,
): (checkout: ThreadCheckout) => Promise<void> {
  const detach = useAtomCommand(threadEnvironment.detachCheckout);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree);

  return useCallback(
    async (checkout: ThreadCheckout) => {
      const threads = readEnvironmentThreadRefs(environmentId).flatMap((ref) => {
        const shell = readThreadShell(ref);
        return shell === null ? [] : [shell];
      });
      const environmentProjects = readProjects().filter(
        (project) => project.environmentId === environmentId,
      );
      const orphanedWorktree =
        getOrphanedCheckoutWorktrees(threads, thread.id, environmentProjects).find(
          (entry) => entry.projectId === checkout.projectId,
        ) ?? null;
      const project = readProject({ environmentId, projectId: checkout.projectId });
      const localApi = readLocalApi();
      let deleteWorktree = false;
      if (orphanedWorktree !== null && project !== null && localApi) {
        const confirmation = await settlePromise(() =>
          localApi.dialogs.confirm(
            [
              "No other thread uses this worktree:",
              formatWorktreePathForDisplay(orphanedWorktree.worktreePath),
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
        input: { threadId: thread.id, projectId: checkout.projectId },
      });
      if (detached._tag === "Failure") {
        toastCommandFailure("Failed to detach checkout", detached);
        return;
      }
      if (!deleteWorktree || orphanedWorktree === null || project === null) return;
      const removed = await removeWorktree({
        environmentId,
        input: { cwd: project.workspaceRoot, path: orphanedWorktree.worktreePath, force: true },
      });
      toastCommandFailure("Checkout detached, but deleting its worktree failed", removed);
    },
    [detach, environmentId, removeWorktree, thread.id],
  );
}

/**
 * Everything a checkout menu needs about a started thread: its attached
 * checkouts, the projects that could still be attached, and the actions on them.
 */
export function useThreadCheckouts(
  environmentId: EnvironmentId,
  thread: Pick<
    OrchestrationThreadShell,
    "id" | "projectId" | "branch" | "worktreePath" | "checkouts"
  >,
) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadCheckouts === true;
  const projects = useProjects();
  const detach = useCheckoutDetach(environmentId, thread);
  const { checkouts } = thread;
  // New checkouts start in the same kind of workspace the thread itself runs in.
  const defaultAttachMode: CheckoutAttachMode =
    thread.worktreePath === null ? "local" : "new-worktree";

  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const attachableProjects = useMemo(
    () =>
      environmentProjects.filter(
        (project) =>
          project.id !== thread.projectId &&
          !checkouts.some((checkout) => checkout.projectId === project.id),
      ),
    [checkouts, environmentProjects, thread.projectId],
  );

  return {
    supported,
    checkouts,
    attachableProjects,
    detach,
    projectTitle: (projectId: ProjectId) =>
      environmentProjects.find((project) => project.id === projectId)?.title ?? projectId,
    /** Where a checkout lives on disk, resolved the same way as the thread's own workspace. */
    directory: (checkout: ThreadCheckout) =>
      checkout.worktreePath ??
      environmentProjects.find((project) => project.id === checkout.projectId)?.workspaceRoot ??
      null,
    defaultBranch:
      thread.branch !== null && !isTemporaryWorktreeBranch(thread.branch) ? thread.branch : null,
    defaultAttachMode,
  };
}

function CheckoutAttachModeIcon({ mode }: { mode: CheckoutAttachMode }) {
  if (mode === "local") return <FolderIcon className="size-3" />;
  if (mode === "new-worktree") return <FolderGit2Icon className="size-3" />;
  return <FolderGitIcon className="size-3" />;
}

export function AttachCheckoutDialog({
  environmentId,
  threadId,
  projects,
  defaultBranch,
  defaultMode,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projects: ReadonlyArray<EnvironmentProject>;
  defaultBranch: string | null;
  defaultMode: CheckoutAttachMode;
  onClose: () => void;
}) {
  const attach = useAtomCommand(vcsEnvironment.attachThreadCheckout);
  const [projectId, setProjectId] = useState<ProjectId | null>(projects[0]?.id ?? null);
  const [mode, setMode] = useState<CheckoutAttachMode>(defaultMode);
  const [existingPath, setExistingPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branch, setBranch] = useState(defaultBranch ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const targetComplete =
    mode === "local" || (mode === "existing" ? existingPath.trim() !== "" : branch.trim() !== "");

  const submit = async () => {
    if (project === null || pending || !targetComplete) return;
    setPending(true);
    setError(null);
    const target: ThreadCheckoutAttachTarget =
      mode === "local"
        ? { type: "local" }
        : mode === "existing"
          ? { type: "existing", path: existingPath.trim() }
          : {
              type: "new-worktree",
              branch: branch.trim(),
              ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
              runSetupScript: true,
            };
    const result = await attach({
      environmentId,
      input: { threadId, projectId: project.id, target },
    });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not attach the checkout.");
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
          <DialogTitle>Attach checkout</DialogTitle>
          <DialogDescription>
            Work on another project from this thread. The agent gets access to the checkout on its
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
            <span className="text-xs font-medium text-foreground">Workspace</span>
            <Select
              modal={false}
              value={mode}
              onValueChange={(value: string | null) => {
                if (value !== null) setMode(value as CheckoutAttachMode);
              }}
              items={CHECKOUT_ATTACH_MODE_ITEMS}
            >
              <SelectTrigger size="sm" aria-label="Workspace">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {CHECKOUT_ATTACH_MODE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    <span className="inline-flex items-center gap-1.5">
                      <CheckoutAttachModeIcon mode={item.value} />
                      {item.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          {mode === "new-worktree" ? (
            <>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">New branch</span>
                <Input
                  value={branch}
                  placeholder="Branch to create in the new worktree"
                  onChange={(event) => setBranch(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Base branch</span>
                <Input
                  value={baseBranch}
                  placeholder="Defaults to the project's current branch"
                  onChange={(event) => setBaseBranch(event.target.value)}
                />
              </label>
            </>
          ) : null}
          {mode === "existing" ? (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Checkout path</span>
              <Input
                value={existingPath}
                placeholder="Path to a checkout of the project's repository"
                onChange={(event) => setExistingPath(event.target.value)}
              />
            </label>
          ) : null}
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={project === null || pending || !targetComplete}
            onClick={() => void submit()}
          >
            {pending ? "Attaching..." : mode === "new-worktree" ? "Create and attach" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
