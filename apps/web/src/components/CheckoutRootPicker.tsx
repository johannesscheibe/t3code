import type { ProjectId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import type { ThreadCheckoutRoot } from "../threadCheckouts";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/menu";

/** Switches a panel between the thread's workspace (null) and its attached checkouts. */
export function CheckoutRootPicker(props: {
  workspaceTitle: string;
  roots: ReadonlyArray<ThreadCheckoutRoot>;
  value: ProjectId | null;
  onValueChange: (projectId: ProjectId | null) => void;
}) {
  const selected = props.roots.find((root) => root.checkout.projectId === props.value);
  const label = selected?.projectTitle ?? props.workspaceTitle;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="xs" variant="ghost-muted" />}
        className="min-w-0 max-w-40 shrink-0"
        aria-label={`Checkout: ${label}`}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={selected?.checkout.projectId ?? ""}
          onValueChange={(value: string) =>
            props.onValueChange(
              props.roots.find((root) => root.checkout.projectId === value)?.checkout.projectId ??
                null,
            )
          }
        >
          <DropdownMenuRadioItem value="" closeOnClick>
            <span className="truncate">{props.workspaceTitle}</span>
          </DropdownMenuRadioItem>
          {props.roots.map((root) => (
            <DropdownMenuRadioItem
              key={root.checkout.id}
              value={root.checkout.projectId}
              disabled={root.cwd === null}
              closeOnClick
            >
              <span className="truncate">{root.projectTitle}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
