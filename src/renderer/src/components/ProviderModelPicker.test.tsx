import type { AgentStatus } from "@openbot/contracts/ipc";
import { fireEvent, render, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { STORY_MODELS } from "../preview/fixtures";
import { ProviderModelPicker } from "./ProviderModelPicker";

const agentStatus: AgentStatus = {
  phase: "ready",
  cliVersion: "0.144.1",
  auth: { kind: "chatgpt", email: "person@example.com" },
  providers: [
    {
      id: "codex",
      state: "available",
      version: "0.144.1",
      message: null,
      email: "person@example.com",
    },
    {
      id: "claude",
      state: "sign-in-required",
      version: null,
      message: "Run `claude auth login` to use Claude.",
      email: null,
    },
    {
      id: "grok",
      state: "not-installed",
      version: null,
      message: "Run `grok login` or set XAI_API_KEY to use Grok.",
      email: null,
    },
  ],
  capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
  message: null,
  fullAccess: true,
};

describe("ProviderModelPicker", () => {
  it("changes model and effort without closing the combined picker", async () => {
    const onChange = vi.fn();
    const onReasoningEffortChange = vi.fn();
    const [model, setModel] = createSignal("gpt-5.6-luna");
    const [effort, setEffort] = createSignal<"medium" | "xhigh">("medium");
    const view = render(() => (
      <ProviderModelPicker
        provider="codex"
        value={model()}
        reasoningEffort={effort()}
        modelOptions={STORY_MODELS}
        agentStatus={agentStatus}
        onChange={(nextModel, provider) => {
          setModel(nextModel);
          onChange(nextModel, provider);
        }}
        onReasoningEffortChange={(nextEffort) => {
          if (nextEffort === "medium" || nextEffort === "xhigh") setEffort(nextEffort);
          onReasoningEffortChange(nextEffort);
        }}
      />
    ));

    await fireEvent.click(view.getByRole("button", { name: "Agent model: Luna" }));
    const dialog = view.getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(dialog).getByRole("option", { name: "Sol" }));

    expect(onChange).toHaveBeenCalledWith("gpt-5.6-sol", "codex");
    expect(dialog).toBeInTheDocument();
    const effortSelect = within(dialog).getByRole("button", { name: /Agent reasoning effort/ });
    await fireEvent.pointerDown(effortSelect, { pointerType: "mouse", button: 0 });
    const page = within(document.body);
    expect(await page.findByRole("option", { name: "Medium" })).toBeInTheDocument();
    expect(page.getByRole("option", { name: "High" })).toBeInTheDocument();
    expect(page.queryByRole("option", { name: "Low" })).not.toBeInTheDocument();

    await fireEvent.click(page.getByRole("option", { name: "Extra high" }));
    expect(onReasoningEffortChange).toHaveBeenCalledWith("xhigh");
    expect(effortSelect).toHaveTextContent("Extra high");
    expect(dialog).toBeInTheDocument();
  });

  it("shows an unavailable provider without allowing its models", async () => {
    const onChange = vi.fn();
    const view = render(() => (
      <ProviderModelPicker
        provider="codex"
        value="gpt-5.6-luna"
        modelOptions={STORY_MODELS}
        agentStatus={agentStatus}
        onChange={onChange}
      />
    ));

    await fireEvent.click(view.getByRole("button", { name: "Agent model: Luna" }));
    const dialog = view.getByRole("dialog", { name: "Choose agent model" });
    expect(within(dialog).getByRole("tab", { name: /ChatGPT:/ })).toBeInTheDocument();
    const grok = within(dialog).getByRole("tab", { name: /Grok:/ });
    await fireEvent.click(grok);

    expect(grok).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tabpanel", { name: /Grok:/ })).toHaveTextContent(
      "Run `grok login` or set XAI_API_KEY to use Grok.",
    );

    await fireEvent.click(within(dialog).getByRole("tab", { name: /Claude:/ }));
    expect(within(dialog).getByRole("option", { name: "Claude Opus 5, default" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves between providers with the keyboard and closes on Escape or an outside press", async () => {
    const view = render(() => (
      <ProviderModelPicker
        provider="codex"
        value="gpt-5.6-luna"
        modelOptions={STORY_MODELS}
        agentStatus={agentStatus}
        onChange={vi.fn()}
      />
    ));
    const trigger = view.getByRole("button", { name: "Agent model: Luna" });

    await fireEvent.click(trigger);
    const dialog = view.getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.keyDown(within(dialog).getByRole("tab", { name: /^ChatGPT:/ }), { key: "ArrowUp" });
    expect(within(dialog).getByRole("tab", { name: /^Claude:/ })).toHaveAttribute("aria-selected", "true");

    await fireEvent.keyDown(dialog, { key: "Escape" });
    expect(view.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();

    await fireEvent.click(trigger);
    expect(view.getByRole("dialog", { name: "Choose agent model" })).toBeInTheDocument();
    await fireEvent.pointerDown(document.body);
    expect(view.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();
  });
});
