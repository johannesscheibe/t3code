import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadAttachedCheckout,
  type ThreadId,
} from "@t3tools/contracts";
import {
  FileDiffIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";

import { useDiffPanelStore } from "../../diffPanelStore";
import { useOrphanedWorktreeRemoval } from "../../hooks/useOrphanedWorktreeRemoval";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  readEnvironmentThreadRefs,
  readThreadShell,
  useProjects,
  useThreadShell,
} from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadCheckoutRoots } from "../../threadCheckouts";
import { cn } from "../../lib/utils";
import { isWorktreeUsedByOtherThread } from "../../worktreeCleanup";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openAttachCheckoutDialog } from "./AttachCheckoutDialog";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * Checkouts of other projects the thread's agent also works in. Hidden while
 * nothing is attached and the environment has no other project to attach.
 */
export function ThreadCheckoutsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useThreadShell(threadRef);
  const roots = useThreadCheckoutRoots(props.environmentId, thread?.attachedCheckouts);
  const hasOtherProject = useProjects().some(
    (project) => project.environmentId === props.environmentId && project.id !== thread?.projectId,
  );
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const detachCheckout = useAtomCommand(threadEnvironment.detachCheckout, {
    reportFailure: false,
  });
  const { resolveRemovableWorktrees, confirmWorktreeRemoval, removeWorktrees } =
    useOrphanedWorktreeRemoval();
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);

  if (thread === null || (roots.length === 0 && !hasOtherProject)) return null;

  const openFiles = (checkout: ThreadAttachedCheckout) =>
    useRightPanelStore.getState().openFiles(threadRef, checkout.projectId);
  const openChanges = (checkout: ThreadAttachedCheckout) => {
    useDiffPanelStore.getState().selectProject(threadRef, checkout.projectId);
    useRightPanelStore.getState().open(threadRef, "diff");
  };

  const detach = async (checkout: ThreadAttachedCheckout) => {
    if (busyProjectId !== null) return;
    setBusyProjectId(checkout.projectId);
    const result = await detachCheckout({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, projectId: checkout.projectId },
    });
    setBusyProjectId(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not detach checkout",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    // Detaching leaves the files on disk; offer to delete a worktree nothing else uses.
    const worktreePath = checkout.worktreePath;
    if (worktreePath === null) return;
    const threads = readEnvironmentThreadRefs(props.environmentId).flatMap((ref) => {
      const shell = readThreadShell(ref);
      return shell === null ? [] : [shell];
    });
    if (isWorktreeUsedByOtherThread(threads, props.threadId, worktreePath)) return;
    const removable = await resolveRemovableWorktrees(props.environmentId, [
      { projectId: checkout.projectId, path: worktreePath },
    ]);
    if (removable.length === 0) return;
    const confirmation = await confirmWorktreeRemoval(
      "No thread uses this worktree now:",
      removable,
    );
    if (confirmation._tag === "Success" && confirmation.value) {
      await removeWorktrees(props.environmentId, removable);
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-checkouts-heading"
      title="Checkouts"
      data-thread-checkouts-panel
      actions={
        canOperate && hasOtherProject ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="Attach a checkout"
                  onClick={() => openAttachCheckoutDialog(threadRef)}
                >
                  <PlusIcon className="size-3.5" />
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>Attach a checkout of another project</TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      {roots.length === 0 ? (
        <p className="px-2.5 pb-1 text-2xs text-muted-foreground">
          Attach another project so the agent can work in it too.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {roots.map((root) => (
            <li
              key={root.checkout.id}
              className={cn(
                "group flex items-center rounded-lg py-1.5",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <FolderGit2Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <Tooltip>
                <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
                  <span className="block truncate text-sm font-medium text-foreground/80">
                    {root.projectTitle}
                  </span>
                  <p className="truncate text-2xs text-muted-foreground">
                    {root.checkout.branch ??
                      (root.checkout.worktreePath ? "Detached worktree" : "Project checkout")}
                  </p>
                </TooltipTrigger>
                <TooltipPopup>{root.cwd ?? "This project is no longer available."}</TooltipPopup>
              </Tooltip>
              <Menu>
                <MenuTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={`${root.projectTitle} checkout actions`}
                      disabled={busyProjectId !== null}
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem disabled={root.cwd === null} onClick={() => openFiles(root.checkout)}>
                    <FolderOpenIcon className="size-3.5" />
                    Open files
                  </MenuItem>
                  <MenuItem disabled={root.cwd === null} onClick={() => openChanges(root.checkout)}>
                    <FileDiffIcon className="size-3.5" />
                    Show changes
                  </MenuItem>
                  {canOperate ? (
                    <>
                      <MenuSeparator />
                      <MenuItem onClick={() => void detach(root.checkout)}>
                        <UnplugIcon className="size-3.5" />
                        Detach
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </li>
          ))}
        </ul>
      )}
    </ThreadDetailsSection>
  );
}
