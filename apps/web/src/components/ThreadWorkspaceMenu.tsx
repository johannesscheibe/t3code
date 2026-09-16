import type { OrchestrationThreadShell, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, FolderGit2Icon, FolderIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { composerFloatingLayerProps } from "./chat/composerEventScope";
import { useThreadCheckouts } from "./threadCheckouts";
import { Button } from "./ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

export interface WorkspaceMenuThread {
  readonly ref: ScopedThreadRef;
  readonly shell: Pick<
    OrchestrationThreadShell,
    "id" | "projectId" | "branch" | "worktreePath" | "checkouts"
  >;
}

/** One checkout row: the same folder icons as the workspace selector, name over detail. */
function CheckoutItem({
  localCheckout,
  title,
  detail,
  onClick,
}: {
  localCheckout: boolean;
  title: string;
  detail: string | null;
  onClick: () => void;
}) {
  return (
    <MenuItem className="items-start py-1.5" onClick={onClick}>
      {localCheckout ? (
        <FolderIcon className="mt-0.5 size-3.5" />
      ) : (
        <FolderGit2Icon className="mt-0.5 size-3.5" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        {detail ? <span className="truncate text-muted-foreground text-xs">{detail}</span> : null}
      </span>
    </MenuItem>
  );
}

/**
 * A started thread's pinned workspace label, turned into a list of its checkouts
 * once checkouts of other projects are attached. Picking one opens it in the Files
 * panel, which also manages them; nothing here moves the agent, whose workspace is
 * fixed once the thread starts. Renders `fallback` when there is nothing to list.
 */
export function ThreadWorkspaceMenu({
  workspaceThread,
  className,
  fallback,
  children,
}: {
  workspaceThread: WorkspaceMenuThread;
  className: string;
  fallback: ReactNode;
  children: ReactNode;
}) {
  const { ref, shell } = workspaceThread;
  const threadCheckouts = useThreadCheckouts(ref.environmentId, shell);
  const { checkouts } = threadCheckouts;

  if (!threadCheckouts.supported || checkouts.length === 0) return fallback;

  const openFiles = (checkoutProjectId: ProjectId | null) =>
    useRightPanelStore.getState().openFilesCheckout(ref, checkoutProjectId);

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className={className}
        title={`${checkouts.length} attached checkout${checkouts.length === 1 ? "" : "s"}`}
        data-composer-context-control
      >
        {children}
        {/* Outside the collapsing label, so a compact strip still shows the count. */}
        <span className="shrink-0 tabular-nums">+{checkouts.length}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-80" {...composerFloatingLayerProps}>
        <MenuGroup>
          <MenuGroupLabel>Open in Files</MenuGroupLabel>
          <CheckoutItem
            localCheckout={shell.worktreePath === null}
            title={threadCheckouts.projectTitle(shell.projectId)}
            detail={shell.branch ? `Agent workspace · ${shell.branch}` : "Agent workspace"}
            onClick={() => openFiles(null)}
          />
          {checkouts.map((checkout) => (
            <CheckoutItem
              key={checkout.projectId}
              localCheckout={checkout.worktreePath === null}
              title={threadCheckouts.projectTitle(checkout.projectId)}
              detail={checkout.branch}
              onClick={() => openFiles(checkout.projectId)}
            />
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
