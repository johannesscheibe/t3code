import type { EnvironmentId, OrchestrationThreadShell, ProjectId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CopyIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  GitPullRequestIcon,
  UnlinkIcon,
} from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { AttachCheckoutDialog, useThreadCheckouts } from "../threadCheckouts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";

/**
 * Picks which checkout the Files tab browses: the thread's workspace or an
 * attached checkout. Doubles as the thread's checkout management surface:
 * attach, detach, and open the selected checkout's pull request live here.
 */
export function FileCheckoutSwitcher({
  environmentId,
  thread,
  selectedProjectId,
  onSelect,
}: {
  environmentId: EnvironmentId;
  thread: Pick<
    OrchestrationThreadShell,
    "id" | "projectId" | "branch" | "worktreePath" | "checkouts"
  >;
  selectedProjectId: ProjectId | null;
  onSelect: (projectId: ProjectId | null) => void;
}) {
  const threadCheckouts = useThreadCheckouts(environmentId, thread);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error.message,
      });
    },
  });
  const { checkouts, attachableProjects } = threadCheckouts;
  const selectedCheckout =
    checkouts.find((checkout) => checkout.projectId === selectedProjectId) ?? null;
  const selectedPullRequest = selectedCheckout?.pullRequest ?? null;
  const selectedDirectory = selectedCheckout ? threadCheckouts.directory(selectedCheckout) : null;

  if (!threadCheckouts.supported || (checkouts.length === 0 && attachableProjects.length === 0)) {
    return null;
  }

  // Same icons as the composer's workspace selector: a folder for a local checkout,
  // a git folder for a worktree.
  const selectedIsLocalCheckout = (selectedCheckout ?? thread).worktreePath === null;
  const primaryTitle = threadCheckouts.projectTitle(thread.projectId);
  const selectedTitle = selectedCheckout
    ? threadCheckouts.projectTitle(selectedCheckout.projectId)
    : primaryTitle;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex h-6 max-w-48 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Checkout: ${selectedTitle}`}
        >
          {selectedIsLocalCheckout ? (
            <FolderIcon className="size-3.5 shrink-0 opacity-70" />
          ) : (
            <FolderGit2Icon className="size-3.5 shrink-0 opacity-70" />
          )}
          <span className="truncate">{selectedTitle}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Checkout</DropdownMenuLabel>
            <DropdownMenuItem
              className={cn(
                "gap-2",
                selectedCheckout === null ? "bg-foreground/[0.08]" : undefined,
              )}
              onClick={() => onSelect(null)}
            >
              {thread.worktreePath === null ? (
                <FolderIcon className="size-3.5" />
              ) : (
                <FolderGit2Icon className="size-3.5" />
              )}
              <span className="truncate">{primaryTitle}</span>
            </DropdownMenuItem>
            {checkouts.map((checkout) => (
              <DropdownMenuItem
                key={checkout.projectId}
                className={cn(
                  "gap-2",
                  checkout.projectId === selectedCheckout?.projectId
                    ? "bg-foreground/[0.08]"
                    : undefined,
                )}
                onClick={() => onSelect(checkout.projectId)}
              >
                {checkout.worktreePath === null ? (
                  <FolderIcon className="size-3.5" />
                ) : (
                  <FolderGit2Icon className="size-3.5" />
                )}
                <span className="truncate">{threadCheckouts.projectTitle(checkout.projectId)}</span>
                {checkout.branch ? (
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {checkout.branch}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          {selectedCheckout ? (
            <>
              <DropdownMenuSeparator />
              {selectedPullRequest ? (
                <DropdownMenuItem
                  onClick={() => void readLocalApi()?.shell.openExternal(selectedPullRequest.url)}
                >
                  <GitPullRequestIcon className="size-3.5" />
                  Open pull request #{selectedPullRequest.number}
                </DropdownMenuItem>
              ) : null}
              {selectedDirectory !== null ? (
                <DropdownMenuItem
                  onClick={() =>
                    copyPathToClipboard(selectedDirectory, { path: selectedDirectory })
                  }
                >
                  <CopyIcon className="size-3.5" />
                  Copy path
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onClick={() => {
                  onSelect(null);
                  void threadCheckouts.detach(selectedCheckout);
                }}
              >
                <UnlinkIcon className="size-3.5" />
                Detach checkout
              </DropdownMenuItem>
            </>
          ) : null}
          {attachableProjects.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setDialogOpen(true)}>
                <FolderPlusIcon className="size-3.5" />
                Attach checkout…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogOpen ? (
        <AttachCheckoutDialog
          environmentId={environmentId}
          threadId={thread.id}
          projects={attachableProjects}
          defaultMode={threadCheckouts.defaultAttachMode}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  );
}
