import type { AgentProviderId, AgentStatus, ProviderRuntimeStatus } from "@openbot/contracts/ipc";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FIRST_BOT_DRAFT, FirstBotSetup } from "./FirstBotSetup";

const runtimeStatuses: Record<AgentProviderId, ProviderRuntimeStatus> = {
  codex: { phase: "not-downloaded", progress: null, message: null, version: null },
  claude: { phase: "not-downloaded", progress: null, message: null, version: null },
  grok: { phase: "not-downloaded", progress: null, message: null, version: null },
};

function agentStatus(codexState: "not-installed" | "available"): AgentStatus {
  return {
    phase: codexState === "available" ? "ready" : "blocked",
    cliVersion: codexState === "available" ? "0.149.1" : null,
    auth: codexState === "available" ? { kind: "chatgpt", email: null } : { kind: "unknown" },
    providers: (["codex", "claude", "grok"] as const).map((id) => ({
      id,
      state: id === "codex" ? codexState : "not-installed",
      version: id === "codex" && codexState === "available" ? "0.149.1" : null,
      message: null,
    })),
    capabilities: {
      chat: codexState === "available" ? "ready" : "unavailable",
      browser: "ready",
      computerUse: "ready",
    },
    message: null,
    fullAccess: true,
  };
}

describe("FirstBotSetup provider runtime", () => {
  it("blocks Bot creation until the selected provider connects", async () => {
    const [status, setStatus] = createSignal(agentStatus("not-installed"));
    const onDownload = vi.fn();
    const view = render(() => (
      <FirstBotSetup
        value={{ ...DEFAULT_FIRST_BOT_DRAFT, purpose: "Help with research" }}
        suggestions={[]}
        providerSetup={{
          agentStatus: status(),
          runtimeStatuses,
          onDownload,
          onCancel: vi.fn(),
          onConnect: vi.fn(),
        }}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    ));
    const create = view.getByRole("button", { name: "Create Bot" });
    expect(create).toBeDisabled();

    await fireEvent.click(view.getByRole("button", { name: "Download ChatGPT" }));
    expect(onDownload).toHaveBeenCalledWith("codex");
    expect(view.getByRole("radio", { name: /ChatGPT/ })).toBeChecked();

    setStatus(agentStatus("available"));
    await waitFor(() => expect(create).toBeEnabled());
  });
});
