import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import "../../src/renderer/src/styles.css";
import "../../.storybook/preview.css";
import { App } from "../../src/renderer/src/App";
import { HostPanel } from "../../src/renderer/src/components/HostPanel";
import { ProviderModelPicker } from "../../src/renderer/src/components/ProviderModelPicker";
import {
  Badge,
  Button,
  Card,
  Field,
  Heading,
  IconButton,
  Input,
  NativeSelect,
  Search,
  Switch,
  Text,
  Textarea,
} from "../../src/renderer/src/components/ui";
import {
  STORY_AGENT_STATUS,
  STORY_HOST_STATUS,
  STORY_INVITES,
  STORY_MODELS,
  STORY_PRESENCE,
  STORY_SESSIONS,
  STORY_TEAM_MEMBERS,
} from "../../src/renderer/stories/fixtures";
import { createMockOpenBot } from "../../src/renderer/stories/mock-openbot";

afterEach(() => cleanup());

test("foundation gallery is visually stable", async () => {
  render(() => (
    <main class="foundation-story" data-testid="foundation-gallery">
      <Heading as="h1" size="display">
        OpenBot UI foundation
      </Heading>

      <section class="foundation-story-stack">
        <Heading as="h2" size="md">
          Type and status
        </Heading>
        <Text>Compact, readable controls for focused desktop work.</Text>
        <div class="foundation-story-row">
          <Badge tone="neutral">Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="success" dot>
            Connected
          </Badge>
          <Badge tone="warning" dot>
            Waiting
          </Badge>
          <Badge tone="danger" dot>
            Failed
          </Badge>
        </div>
      </section>

      <Card class="foundation-story-stack">
        <Heading as="h2" size="md">
          Controls
        </Heading>
        <div class="foundation-story-row">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button loading loadingLabel="Saving">
            Save
          </Button>
          <IconButton label="Search">
            <Search />
          </IconButton>
        </div>
        <Switch defaultChecked label="Desktop notifications" description="Notify when an agent finishes." />
      </Card>

      <form class="foundation-form">
        <Field label="Agent name" htmlFor="visual-agent-name" description="Visible to the workspace." required>
          <Input id="visual-agent-name" value="Research agent" required />
        </Field>
        <Field label="Provider" htmlFor="visual-provider">
          <NativeSelect id="visual-provider">
            <option>OpenAI</option>
            <option>Anthropic</option>
          </NativeSelect>
        </Field>
        <Field label="Instructions" htmlFor="visual-instructions">
          <Textarea id="visual-instructions" value="Find reliable sources and summarize the result." />
        </Field>
      </form>
    </main>
  ));

  await expect(page.getByTestId("foundation-gallery")).toMatchScreenshot("foundations");
});

test("representative application screens are visually stable", async () => {
  const previousApi = window.openbot;
  const mock = createMockOpenBot();
  window.openbot = mock.api;

  try {
    render(() => (
      <div data-testid="application-screen">
        <App />
      </div>
    ));

    await expect.element(page.getByRole("heading", { name: "Chief" })).toBeVisible();
    expect(document.querySelector(".search-field > svg")?.getBoundingClientRect().width).toBe(16);
    await expect(page.getByTestId("application-screen")).toMatchScreenshot("application");

    await page.getByRole("button", { name: "Add remote server" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("application-screen")).toMatchScreenshot("join-server-dialog");
  } finally {
    cleanup();
    mock.dispose();
    window.openbot = previousApi;
  }
});

test("advanced panels and pickers are visually stable", async () => {
  render(() => (
    <HostPanel
      platform="darwin"
      status={STORY_HOST_STATUS}
      members={STORY_TEAM_MEMBERS}
      invites={STORY_INVITES}
      sessions={STORY_SESSIONS}
      presence={STORY_PRESENCE}
      accountEmail="person@example.com"
      onClose={() => undefined}
      onConfigure={async () => undefined}
      onConfigureRemoteDesktop={async () => undefined}
      onStart={async () => undefined}
      onStop={async () => undefined}
      onCreateInvite={async (input) => ({
        id: "visual-invite",
        role: input.role,
        expiresAt: "2026-09-19T10:00:00.000Z",
        usedAt: null,
        inviteUrl: "openbot://invite/visual",
        email: input.email ?? null,
      })}
      onUpdateMember={async () => undefined}
      onRemoveMember={async () => undefined}
      onRevokeSession={async () => undefined}
      onRevokeInvite={async () => undefined}
      onCopyAddressUpdate={async () => undefined}
    />
  ));

  const hostPanel = page.getByRole("dialog");
  await expect.element(hostPanel).toBeVisible();
  await expect(hostPanel).toMatchScreenshot("host-panel");

  cleanup();
  render(() => (
    <main class="foundation-story">
      <ProviderModelPicker
        value="gpt-5.6-luna"
        modelOptions={STORY_MODELS}
        agentStatus={STORY_AGENT_STATUS}
        onChange={() => undefined}
      />
    </main>
  ));

  await page.getByRole("button", { name: /Agent model: Luna/ }).click();
  const picker = page.getByRole("dialog", { name: "Choose agent model" });
  await expect.element(picker).toBeVisible();
  await expect(picker).toMatchScreenshot("provider-model-picker");
});
