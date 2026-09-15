import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
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

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { AttachWorktreeDialog, useThreadCheckouts } from "../threadCheckouts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";

/**
 * Picks which checkout the Files tab browses: the thread's workspace or an
 * attached worktree. Doubles as the thread's worktree management surface:
 * attach, detach, and open the selected worktree's pull request live here.
 */
export function FileCheckoutSwitcher({
  environmentId,
  thread,
  selectedWorktreePath,
  onSelect,
}: {
  environmentId: EnvironmentId;
  thread: Pick<OrchestrationThreadShell, "id" | "projectId" | "branch" | "worktreePath" | "worktrees">;
  selectedWorktreePath: string | null;
  onSelect: (worktreePath: string | null) => void;
}) {
  const checkouts = useThreadCheckouts(environmentId, thread);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { links, attachableProjects } = checkouts;
  const selectedLink = links.find((link) => link.worktreePath === selectedWorktreePath) ?? null;
  const selectedPullRequest = selectedLink?.pullRequest ?? null;

  if (!checkouts.supported || (links.length === 0 && attachableProjects.length === 0)) return null;

  // Same icons as the composer's workspace selector: a folder for a local checkout,
  // a git folder for a worktree.
  const primaryIsLocalCheckout = thread.worktreePath === null;
  const selectedIsLocalCheckout = selectedLink
    ? checkouts.isLocalCheckout(selectedLink)
    : primaryIsLocalCheckout;
  const primaryTitle = checkouts.projectTitle(thread.projectId);
  const selectedTitle = selectedLink ? checkouts.projectTitle(selectedLink.projectId) : primaryTitle;

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
              className={cn("gap-2", selectedLink === null ? "bg-foreground/[0.08]" : undefined)}
              onClick={() => onSelect(null)}
            >
              {primaryIsLocalCheckout ? (
                <FolderIcon className="size-3.5" />
              ) : (
                <FolderGit2Icon className="size-3.5" />
              )}
              <span className="truncate">{primaryTitle}</span>
            </DropdownMenuItem>
            {links.map((link) => (
              <DropdownMenuItem
                key={link.worktreePath}
                className={cn(
                  "gap-2",
                  link.worktreePath === selectedLink?.worktreePath
                    ? "bg-foreground/[0.08]"
                    : undefined,
                )}
                onClick={() => onSelect(link.worktreePath)}
              >
                {checkouts.isLocalCheckout(link) ? (
                  <FolderIcon className="size-3.5" />
                ) : (
                  <FolderGit2Icon className="size-3.5" />
                )}
                <span className="truncate">{checkouts.projectTitle(link.projectId)}</span>
                {link.branch ? (
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {link.branch}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          {selectedLink ? (
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
              <DropdownMenuItem
                onClick={() => void navigator.clipboard.writeText(selectedLink.worktreePath)}
              >
                <CopyIcon className="size-3.5" />
                Copy path
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  onSelect(null);
                  void checkouts.detach(selectedLink);
                }}
              >
                <UnlinkIcon className="size-3.5" />
                Detach worktree
              </DropdownMenuItem>
            </>
          ) : null}
          {attachableProjects.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setDialogOpen(true)}>
                <FolderPlusIcon className="size-3.5" />
                Attach worktree…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogOpen ? (
        <AttachWorktreeDialog
          environmentId={environmentId}
          threadId={thread.id}
          projects={attachableProjects}
          defaultBranch={checkouts.defaultBranch}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  );
}
