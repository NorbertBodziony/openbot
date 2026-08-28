import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentApproval, BrowserPreview, BrowserTab } from "@openbot/contracts/ipc";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Badge, Button, Check, Input, Monitor, RadioGroup, Skeleton, TriangleAlert, X } from "./ui";

export function ChoiceCard(props: {
  title: string;
  hint?: string;
  choices: string[];
  customChoice?: string;
  pending?: boolean;
  onSubmit: (answer: string) => Promise<boolean>;
}) {
  const [answer, setAnswer] = createSignal("");
  const [customSelected, setCustomSelected] = createSignal(false);
  let customInput: HTMLInputElement | undefined;
  const selectedChoice = () => (customSelected() ? (props.customChoice ?? "") : answer());
  const submit = async () => {
    const value = answer().trim();
    if (value && !props.pending) await props.onSubmit(value);
  };
  return (
    <div class="choice-card">
      <div class="choice-card-heading">
        <div>
          <strong>{props.title}</strong>
          <span>{props.hint ?? "Pick whatever fits, or type your own."}</span>
        </div>
      </div>
      <RadioGroup.Root
        class="choice-options"
        aria-label={props.title}
        value={selectedChoice()}
        disabled={props.pending}
        onChange={(choice) => {
          if (choice === props.customChoice) {
            setAnswer("");
            setCustomSelected(true);
            queueMicrotask(() => customInput?.focus());
            return;
          }
          setCustomSelected(false);
          setAnswer(choice);
          void props.onSubmit(choice);
        }}
      >
        <For each={props.choices}>
          {(choice, index) => (
            <RadioGroup.Item class="choice-option-item" value={choice} disabled={props.pending}>
              <RadioGroup.ItemInput aria-label={choice} />
              <RadioGroup.ItemControl
                class={[
                  "choice-option",
                  {
                    "choice-option-selected": choice === props.customChoice ? customSelected() : answer() === choice,
                  },
                ]}
              >
                <span class="choice-key">{String.fromCharCode(65 + index())}</span>
                <span>{choice}</span>
              </RadioGroup.ItemControl>
            </RadioGroup.Item>
          )}
        </For>
      </RadioGroup.Root>
      <Input
        ref={(element) => (customInput = element)}
        class="choice-input"
        value={answer()}
        placeholder="Type your own answer"
        aria-label="Custom answer"
        maxlength={INPUT_LIMITS.promptAnswerText}
        disabled={props.pending}
        onValueChange={(value) => {
          setCustomSelected(true);
          setAnswer(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
      />
    </div>
  );
}

export function ApprovalCard(props: {
  approval: AgentApproval;
  onApprove: () => Promise<boolean>;
  onReject: () => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = createSignal(false);
  const submit = async (decision: "accept" | "decline") => {
    if (submitting()) return;
    setSubmitting(true);
    const completed = await (decision === "accept" ? props.onApprove() : props.onReject());
    if (!completed) setSubmitting(false);
  };

  return (
    <section class="approval-card approval-card-approval" aria-label="Agent approval">
      <header class="approval-card-header">
        <span class="approval-card-icon" data-kind="approval">
          <ApprovalIcon />
        </span>
        <div>
          <strong>{approvalTitle(props.approval)}</strong>
        </div>
      </header>
      <div class="approval-card-content">
        <Show when={props.approval.command}>
          {(command) => (
            <div class="approval-command-block">
              <Show when={props.approval.cwd}>
                <div class="approval-cwd">{props.approval.cwd}</div>
              </Show>
              <code>{command()}</code>
            </div>
          )}
        </Show>
        <Show when={props.approval.kind === "file-change"}>
          <div class="approval-detail-row">
            <span class="approval-detail-label">Files</span>
            <strong>{props.approval.grantRoot ?? "Agent workspace"}</strong>
          </div>
        </Show>
        <Show when={props.approval.kind === "permissions"}>
          <PermissionDetails permissions={props.approval.permissions} />
        </Show>
        <Show when={props.approval.reason}>{(reason) => <p class="approval-reason">{reason()}</p>}</Show>
      </div>
      <footer class="approval-card-footer approval-card-footer-end">
        <div class="approval-card-actions">
          <Button
            variant="ghost"
            type="button"
            class="approval-button approval-button-ghost"
            disabled={submitting()}
            onClick={() => void submit("decline")}
          >
            {submitting() ? "Waiting…" : "Reject"}
          </Button>
          <Button
            variant="default"
            type="button"
            class="approval-button approval-button-primary"
            disabled={submitting()}
            onClick={() => void submit("accept")}
          >
            {submitting() ? "Sending…" : "Approve"}
            <ReturnIcon />
          </Button>
        </div>
      </footer>
    </section>
  );
}

export function BrowserTakeoverCard(props: {
  botName: string;
  tab: BrowserTab | undefined;
  preview: BrowserPreview | null;
  previewStatus: "idle" | "loading" | "ready" | "failed";
  decision?: "complete" | "cancel" | null;
  onComplete: () => Promise<boolean>;
  onCancel: () => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = createSignal<"complete" | "cancel" | null>(null);
  const pageDetails = createMemo(() => browserPageDetails(props.tab));
  const completed = () => props.decision === "complete";
  const cancelled = () => props.decision === "cancel";
  const accessibleLabel = () =>
    completed() ? "Browser takeover complete" : cancelled() ? "Browser takeover cancelled" : "Browser takeover";
  const submit = async (decision: "complete" | "cancel") => {
    if (submitting() || props.decision) return;
    setSubmitting(decision);
    const completed = await (decision === "complete" ? props.onComplete() : props.onCancel());
    if (!completed) setSubmitting(null);
  };

  return (
    <section
      class="browser-takeover-card"
      data-decision={props.decision ?? undefined}
      aria-label={accessibleLabel()}
      aria-busy={submitting() ? "true" : undefined}
    >
      <header class="browser-takeover-header">
        <span>Browser</span>
        <Show
          when={!props.decision}
          fallback={
            <Badge variant={completed() ? "success-light" : "secondary"} role="status">
              <Show when={completed()} fallback={<X data-icon="inline-start" aria-hidden="true" />}>
                <Check data-icon="inline-start" aria-hidden="true" />
              </Show>
              {completed() ? "Done" : "Cancelled"}
            </Badge>
          }
        >
          <Badge variant="warning-light" role="status">
            <TriangleAlert data-icon="inline-start" aria-hidden="true" />
            Action required
          </Badge>
        </Show>
      </header>
      <div class="browser-takeover-copy">
        <h2>
          {completed()
            ? `Step completed on ${pageDetails().host}`
            : cancelled()
              ? `Step cancelled on ${pageDetails().host}`
              : `Complete the step on ${pageDetails().host}`}
        </h2>
        <p>
          {completed()
            ? `${props.botName} is continuing.`
            : cancelled()
              ? "The browser step was cancelled."
              : `Finish the sign-in, verification, or consent in the open browser. Then let ${props.botName} continue.`}
        </p>
      </div>

      <figure class="browser-takeover-preview">
        <figcaption class="browser-takeover-preview-bar">
          <Monitor aria-hidden="true" />
          <span title={pageDetails().title}>{pageDetails().title}</span>
          <small title={pageDetails().host}>{pageDetails().host}</small>
        </figcaption>
        <div class="browser-takeover-preview-viewport">
          <Show
            when={props.previewStatus === "ready" ? props.preview : null}
            fallback={
              <Show
                when={props.previewStatus === "loading" || props.previewStatus === "idle"}
                fallback={
                  <div class="browser-takeover-preview-fallback">
                    <Monitor aria-hidden="true" />
                    <strong>{pageDetails().title}</strong>
                    <span>{pageDetails().host}</span>
                  </div>
                }
              >
                <Skeleton class="browser-takeover-preview-skeleton" />
              </Show>
            }
          >
            {(preview) => (
              <img
                src={preview().dataUrl}
                width={preview().width}
                height={preview().height}
                alt={`Preview of ${pageDetails().title}`}
              />
            )}
          </Show>
        </div>
      </figure>

      <Show when={!props.decision}>
        <footer class="browser-takeover-actions">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class="approval-button"
            loading={submitting() === "cancel"}
            loadingLabel="Cancelling…"
            disabled={Boolean(submitting())}
            onClick={() => void submit("cancel")}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            type="button"
            class="approval-button"
            loading={submitting() === "complete"}
            loadingLabel="Returning…"
            disabled={Boolean(submitting())}
            onClick={() => void submit("complete")}
          >
            I’m done
          </Button>
        </footer>
      </Show>
    </section>
  );
}

function browserPageDetails(tab: BrowserTab | undefined): { title: string; host: string } {
  const title = tab?.title.trim() || "Browser page";
  if (!tab?.url) return { title, host: "the browser" };
  try {
    return { title, host: new URL(tab.url).hostname || "the browser" };
  } catch {
    return { title, host: tab.url };
  }
}

function approvalTitle(approval: AgentApproval | undefined) {
  if (approval?.kind === "command") return "Run this command?";
  if (approval?.kind === "file-change") return "Approve file changes?";
  return "Grant permissions?";
}

function PermissionDetails(props: { permissions: AgentApproval["permissions"] }) {
  const details = createMemo(() => {
    const permissions = props.permissions;
    if (!permissions) return [];
    return [
      ...(permissions.network ? ["Network access"] : []),
      ...permissions.fileSystem.read.map((path) => `Read ${path}`),
      ...permissions.fileSystem.write.map((path) => `Write ${path}`),
    ];
  });
  return (
    <section class="approval-permissions" aria-label="Requested permissions">
      <For each={details()}>{(detail) => <span>{detail}</span>}</For>
    </section>
  );
}

function ApprovalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M10 2.5 16.2 5v4.3c0 3.8-2.4 6.5-6.2 8.2-3.8-1.7-6.2-4.4-6.2-8.2V5L10 2.5Z" />
      <path d="m7.3 10 1.8 1.8 3.7-4" />
    </svg>
  );
}

function ReturnIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M4 4.5h5.5a2.5 2.5 0 0 1 0 5H6.8M6.8 7.5l-2.8 2 2.8 2" />
    </svg>
  );
}
