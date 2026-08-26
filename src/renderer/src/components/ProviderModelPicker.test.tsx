import type { AgentStatus } from "@openbot/contracts/ipc";
import { fireEvent, render, within } from "@solidjs/testing-library";
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
  it("shows the status of an unavailable provider when its rail button is selected", async () => {
    const onChange = vi.fn();
    const view = render(() => (
      <ProviderModelPicker
        provider="codex"
        value="gpt-5.6-luna"
        modelOptions={STORY_MODELS.filter((model) => model.provider === "codex")}
        agentStatus={agentStatus}
        onChange={onChange}
      />
    ));

    await fireEvent.click(view.getByRole("button", { name: "Agent model: Luna" }));
    const dialog = view.getByRole("dialog", { name: "Choose agent model" });
    expect(within(dialog).getByRole("tab", { name: /ChatGPT:/ })).toBeInTheDocument();
    const grok = within(dialog).getByRole("tab", { name: /Grok:/ });
    await fireEvent.click(grok);

    expect(grok).toHaveFocus();
    expect(grok).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tabpanel", { name: /Grok:/ })).toHaveTextContent(
      "Run `grok login` or set XAI_API_KEY to use Grok.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
