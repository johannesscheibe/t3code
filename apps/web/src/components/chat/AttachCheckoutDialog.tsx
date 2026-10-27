import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { Atom } from "effect/reactivity";
import { type ReactNode, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";

type WorkspaceMode = "worktree" | "root";

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "New worktree",
  root: "Use the project checkout as it is",
};

/**
 * Which thread has the attach dialog open. The chat view renders it once, so the dialog
 * outlives the thread details popover that opened it.
 */
const attachCheckoutDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-checkouts:attach-dialog-thread"),
);

export function openAttachCheckoutDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(attachCheckoutDialogThreadAtom, threadRef);
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function AttachCheckoutDialogHost() {
  const threadRef = useAtomValue(attachCheckoutDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <AttachCheckoutDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(attachCheckoutDialogThreadAtom, null)}
    />
  );
}

function Field(props: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
    </div>
  );
}

function AttachCheckoutDialog(props: { threadRef: ScopedThreadRef; onClose: () => void }) {
  const { environmentId, threadId } = props.threadRef;
  const thread = useThreadShell(props.threadRef);
  const projects = useProjects();
  const settings = useEnvironmentSettings(environmentId);
  const attachCheckout = useAtomCommand(threadEnvironment.attachCheckout, {
    reportFailure: false,
  });
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>("worktree");
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [startFromOrigin, setStartFromOrigin] = useState<boolean | null>(null);
  const [branch, setBranch] = useState("");
  const [pending, setPending] = useState(false);

  const attachedProjectIds = new Set(
    thread?.attachedCheckouts.map((checkout) => checkout.projectId),
  );
  const candidates = projects.filter(
    (project) =>
      project.environmentId === environmentId &&
      project.id !== thread?.projectId &&
      !attachedProjectIds.has(project.id),
  );
  const project = candidates.find((candidate) => candidate.id === projectId) ?? null;
  // The base defaults to the project's current branch, like a new thread's worktree.
  const status = useEnvironmentQuery(
    project && mode === "worktree"
      ? vcsEnvironment.status({ environmentId, input: { cwd: project.workspaceRoot } })
      : null,
  );
  const resolvedBaseRef = baseRef ?? status.data?.refName ?? "";
  const resolvedStartFromOrigin =
    startFromOrigin ??
    (project
      ? resolveProjectSettings(settings, project.id, project).settings.newWorktreesStartFromOrigin
      : false);
  const canSubmit = !pending && project !== null && (mode === "root" || resolvedBaseRef.length > 0);

  const submit = async () => {
    if (!canSubmit || project === null) return;
    setPending(true);
    const trimmedBranch = branch.trim();
    const result = await attachCheckout({
      environmentId,
      input: {
        threadId,
        projectId: project.id,
        workspace:
          mode === "root"
            ? { type: "root" }
            : {
                type: "worktree",
                baseRef: resolvedBaseRef,
                ...(trimmedBranch ? { branch: trimmedBranch } : {}),
                ...(resolvedStartFromOrigin ? { startFromOrigin: true } : {}),
              },
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      props.onClose();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not attach checkout",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? props.onClose() : undefined)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach checkout</DialogTitle>
          <DialogDescription>
            Let this thread's agent also work in another project. If the agent is working, it sees
            the checkout in its next turn.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending} className="space-y-4">
            <Field label="Project" htmlFor="attach-checkout-project">
              <Select
                value={project?.id ?? ""}
                onValueChange={(value) => {
                  setProjectId(candidates.find((candidate) => candidate.id === value)?.id ?? null);
                  setBaseRef(null);
                  setStartFromOrigin(null);
                }}
              >
                <SelectTrigger size="sm" id="attach-checkout-project">
                  <SelectValue
                    placeholder={candidates.length > 0 ? "Select a project" : "No other projects"}
                  >
                    {project?.title}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Checkout" htmlFor="attach-checkout-mode">
              <Select
                value={mode}
                onValueChange={(value) => {
                  if (value === "worktree" || value === "root") setMode(value);
                }}
              >
                <SelectTrigger size="sm" id="attach-checkout-mode">
                  <SelectValue>{WORKSPACE_MODE_LABELS[mode]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="worktree">{WORKSPACE_MODE_LABELS.worktree}</SelectItem>
                  <SelectItem value="root">{WORKSPACE_MODE_LABELS.root}</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
            {mode === "worktree" ? (
              <>
                <Field label="Base branch" htmlFor="attach-checkout-base-ref">
                  <WorktreeBaseBranchPicker
                    key={project?.id ?? "none"}
                    id="attach-checkout-base-ref"
                    environmentId={environmentId}
                    cwd={project?.workspaceRoot ?? null}
                    value={resolvedBaseRef}
                    onValueChange={setBaseRef}
                    startFromOrigin={resolvedStartFromOrigin}
                    onStartFromOriginChange={setStartFromOrigin}
                    disabled={pending}
                  />
                </Field>
                <Field label="Branch name" htmlFor="attach-checkout-branch">
                  <Input
                    id="attach-checkout-branch"
                    placeholder="Optional"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void submit();
                    }}
                  />
                </Field>
              </>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            {pending ? "Attaching..." : "Attach"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
