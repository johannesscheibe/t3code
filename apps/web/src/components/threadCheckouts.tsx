import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ProjectId,
  ThreadCheckout,
  ThreadCheckoutAttachTarget,
  ThreadId,
  VcsRef,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useDeferredValue, useMemo, useState } from "react";

import {
  readEnvironmentThreadRefs,
  readProject,
  readProjects,
  readThreadShell,
  useProjects,
  useServerConfigs,
} from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { formatWorktreePathForDisplay, getOrphanedCheckoutWorktrees } from "~/worktreeCleanup";
import { type EnvMode, resolveEnvModeLabel } from "./BranchToolbar.logic";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { toastManager } from "./ui/toast";

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
  const defaultAttachMode: EnvMode = thread.worktreePath === null ? "local" : "worktree";

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
    defaultAttachMode,
  };
}

const ATTACH_ENV_MODES: ReadonlyArray<EnvMode> = ["local", "worktree"];

/**
 * Attach a checkout of another project, chosen the way a new thread's starting
 * point is: the project's current checkout or a new worktree, plus a ref. A ref
 * that already lives in a worktree attaches that worktree; any other ref is
 * switched to in the current checkout, or becomes the new worktree's base.
 */
export function AttachCheckoutDialog({
  environmentId,
  threadId,
  projects,
  defaultMode,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projects: ReadonlyArray<EnvironmentProject>;
  defaultMode: EnvMode;
  onClose: () => void;
}) {
  const attach = useAtomCommand(vcsEnvironment.attachThreadCheckout);
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const settings = useEnvironmentSettings(environmentId);
  const [projectId, setProjectId] = useState<ProjectId | null>(projects[0]?.id ?? null);
  const [mode, setMode] = useState<EnvMode>(defaultMode);
  const [pickedBranch, setPickedBranch] = useState<VcsRef | null>(null);
  const [refQuery, setRefQuery] = useState("");
  const deferredRefQuery = useDeferredValue(refQuery).trim();
  const [startFromOriginOverride, setStartFromOriginOverride] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const projectCwd = project?.workspaceRoot ?? null;
  const startFromOrigin =
    startFromOriginOverride ??
    resolveProjectSettings(settings, project?.id ?? null, project ?? undefined).settings
      .newWorktreesStartFromOrigin;

  const allRefsQuery = useEnvironmentQuery(
    projectCwd === null
      ? null
      : vcsEnvironment.listRefs({ environmentId, input: { cwd: projectCwd, limit: 100 } }),
  );
  // The server filters refs, so a search reaches refs beyond the first page.
  const matchingRefsQuery = useEnvironmentQuery(
    projectCwd === null || deferredRefQuery.length === 0
      ? null
      : vcsEnvironment.listRefs({
          environmentId,
          input: { cwd: projectCwd, query: deferredRefQuery, limit: 100 },
        }),
  );
  const allRefs = allRefsQuery.data?.refs ?? [];
  const refs = deferredRefQuery.length === 0 ? allRefs : (matchingRefsQuery.data?.refs ?? []);
  const statusQuery = useEnvironmentQuery(
    projectCwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd: projectCwd } }),
  );
  const currentBranch = statusQuery.data?.refName ?? null;
  // Until a ref is picked, a new worktree starts from the default branch and the
  // current checkout stays on the branch it has.
  const defaultBaseBranch = allRefs.find((refName) => refName.isDefault)?.name ?? currentBranch;
  const selectedRefName =
    pickedBranch?.name ?? (mode === "worktree" ? defaultBaseBranch : currentBranch);
  const reusedWorktreePath =
    mode === "local" && pickedBranch?.worktreePath && pickedBranch.worktreePath !== projectCwd
      ? pickedBranch.worktreePath
      : null;

  const submit = async () => {
    if (project === null || pending) return;
    setPending(true);
    setError(null);
    const fail = (result: Parameters<typeof isAtomCommandInterrupted>[0], fallback: string) => {
      setPending(false);
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : fallback);
    };
    const switchesRef =
      mode === "local" &&
      pickedBranch !== null &&
      reusedWorktreePath === null &&
      !pickedBranch.current &&
      pickedBranch.worktreePath !== project.workspaceRoot;
    if (switchesRef) {
      const switched = await switchRef({
        environmentId,
        input: { cwd: project.workspaceRoot, refName: pickedBranch.name },
      });
      if (switched._tag === "Failure") {
        fail(switched, "Could not switch the ref.");
        return;
      }
    }
    const target: ThreadCheckoutAttachTarget =
      mode === "worktree"
        ? {
            type: "new-worktree",
            ...(selectedRefName ? { baseBranch: selectedRefName } : {}),
            ...(startFromOrigin ? { startFromOrigin: true } : {}),
            runSetupScript: true,
          }
        : reusedWorktreePath !== null
          ? { type: "existing", path: reusedWorktreePath }
          : { type: "local" };
    const result = await attach({
      environmentId,
      input: { threadId, projectId: project.id, target },
    });
    if (result._tag === "Success") {
      onClose();
      return;
    }
    fail(result, "Could not attach the checkout.");
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
              onValueChange={(value: string | null) => {
                setProjectId(value as ProjectId | null);
                setPickedBranch(null);
              }}
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
                if (value === null) return;
                setMode(value as EnvMode);
                setPickedBranch(null);
              }}
              items={ATTACH_ENV_MODES.map((value) => ({
                value,
                label: resolveEnvModeLabel(value),
              }))}
            >
              <SelectTrigger size="sm" aria-label="Workspace">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {ATTACH_ENV_MODES.map((value) => (
                  <SelectItem key={value} value={value}>
                    <span className="inline-flex items-center gap-1.5">
                      {value === "local" ? (
                        <FolderIcon className="size-3" />
                      ) : (
                        <FolderGit2Icon className="size-3" />
                      )}
                      {resolveEnvModeLabel(value)}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">
              {mode === "worktree" ? "Base ref" : "Ref"}
            </span>
            <Combobox
              items={refs.map((refName) => refName.name)}
              filteredItems={refs.map((refName) => refName.name)}
              value={selectedRefName}
              onOpenChange={(open) => {
                if (!open) setRefQuery("");
              }}
              onValueChange={(value) => {
                const picked = refs.find((candidate) => candidate.name === value);
                if (picked) setPickedBranch(picked);
              }}
            >
              <ComboboxTrigger
                render={<Button variant="outline" size="sm" />}
                className="min-w-0 justify-start font-normal"
                disabled={projectCwd === null || pending}
              >
                <GitBranchIcon className="size-3 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {selectedRefName === null
                    ? "Select ref"
                    : mode === "worktree"
                      ? `From ${selectedRefName}`
                      : selectedRefName}
                </span>
                {reusedWorktreePath !== null ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">worktree</span>
                ) : null}
                <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
              </ComboboxTrigger>
              <ComboboxPopup align="start" className="w-80 min-w-0 overflow-hidden">
                <div className="min-w-0 shrink-0 px-3 pt-2.5">
                  <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
                    <SearchIcon
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
                    />
                    <ComboboxInput
                      className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
                      inputClassName="rounded-none bg-transparent text-sm"
                      placeholder="Search refs..."
                      showTrigger={false}
                      size="sm"
                      unstyled
                      value={refQuery}
                      onChange={(event) => setRefQuery(event.target.value)}
                    />
                  </div>
                </div>
                <ComboboxEmpty>No refs found.</ComboboxEmpty>
                <ComboboxList className="max-h-56 min-w-0 overflow-x-hidden">
                  {refs.map((refName) => {
                    const badge = refName.current
                      ? "current"
                      : refName.worktreePath && refName.worktreePath !== projectCwd
                        ? "worktree"
                        : refName.isRemote
                          ? "remote"
                          : refName.isDefault
                            ? "default"
                            : null;
                    return (
                      <ComboboxItem
                        hideIndicator
                        key={refName.name}
                        value={refName.name}
                        className="pe-1.5"
                      >
                        <div className="flex w-full min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate">{refName.name}</span>
                          {badge ? (
                            <span className="shrink-0 text-[10px] text-muted-foreground/45">
                              {badge}
                            </span>
                          ) : null}
                        </div>
                      </ComboboxItem>
                    );
                  })}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </div>
          {mode === "worktree" ? (
            <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-foreground">Start from origin</span>
                <span className="text-muted-foreground">
                  Creates the worktree from the latest matching branch on origin instead of your
                  local branch.
                </span>
              </span>
              <Switch
                checked={startFromOrigin}
                size="sm"
                aria-label="Start worktree from origin"
                onCheckedChange={(checked) => setStartFromOriginOverride(Boolean(checked))}
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
            disabled={project === null || pending}
            onClick={() => void submit()}
          >
            {pending ? "Attaching..." : mode === "worktree" ? "Create and attach" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
