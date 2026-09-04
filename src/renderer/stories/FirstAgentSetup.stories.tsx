import { createEffect, createSignal } from "solid-js";
import { expect, fireEvent, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  DEFAULT_FIRST_AGENT_DRAFT,
  FIRST_AGENT_SUGGESTIONS,
  type FirstAgentDraft,
  FirstAgentSetup,
  type FirstAgentSetupProps,
  type FirstAgentSuggestion,
} from "../src/components/FirstAgentSetup";

function draftFromSuggestion(suggestion: FirstAgentSuggestion): FirstAgentDraft {
  return {
    name: suggestion.name,
    purpose: suggestion.purpose,
    avatarSeed: suggestion.avatarSeed,
    avatarHue: suggestion.avatarHue,
    suggestionId: suggestion.id,
  };
}

function ControlledFirstAgentSetup(props: FirstAgentSetupProps) {
  const [draft, setDraft] = createSignal<FirstAgentDraft>({ ...props.value });

  createEffect(
    () => props.value,
    (value) => {
      setDraft({ ...value });
    },
  );

  return (
    <FirstAgentSetup
      {...props}
      value={draft()}
      onChange={(value) => {
        setDraft(value);
        props.onChange(value);
      }}
    />
  );
}

const args: FirstAgentSetupProps = {
  value: DEFAULT_FIRST_AGENT_DRAFT,
  suggestions: FIRST_AGENT_SUGGESTIONS,
  submitting: false,
  onChange: fn(),
  onSubmit: fn(),
};

const meta = {
  title: "Setup/FirstAgentSetup",
  component: FirstAgentSetup,
  args,
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        firstAgentSmall: {
          name: "First agent — 700 × 720",
          styles: { width: "700px", height: "720px" },
        },
      },
    },
  },
  render: (storyArgs) => <ControlledFirstAgentSetup {...storyArgs} />,
} satisfies Meta<typeof FirstAgentSetup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    const createButton = canvas.getByRole("button", { name: "Create agent" });
    await expect(canvas.getAllByRole("listitem")).toHaveLength(6);
    await expect(createButton).toBeDisabled();
    await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue("New agent");
    await expect(canvas.getByRole("textbox", { name: "What should this agent help with?" })).toHaveValue("");
    await expect(canvas.getAllByRole("button", { name: /agent color$/ })).toHaveLength(9);
    await expect(canvas.queryByRole("button", { name: "Lime agent color" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Violet agent color" })).not.toBeInTheDocument();

    const suggestionViewport = canvasElement.querySelector<HTMLElement>(".first-bot-suggestion-viewport");
    const suggestionList = canvasElement.querySelector<HTMLElement>(".first-bot-suggestion-list");
    if (!suggestionViewport || !suggestionList) throw new Error("The agent suggestion scroller is missing.");
    await expect(getComputedStyle(suggestionList).scrollSnapType).toBe("none");
    await expect(suggestionViewport).toHaveClass("can-scroll-forward");
    await expect(suggestionViewport).not.toHaveClass("can-scroll-back");
    const suggestionAvatars = Array.from(
      canvasElement.querySelectorAll<HTMLElement>(".first-bot-suggestion-card .bot-avatar-motion-always"),
    );
    await expect(suggestionAvatars).toHaveLength(6);
    const suggestionCards = Array.from(canvasElement.querySelectorAll<HTMLElement>(".first-bot-suggestion-card"));
    await expect(new Set(suggestionCards.map((card) => card.dataset.animationCycleOffset)).size).toBe(6);
    await expect(new Set(suggestionCards.map((card) => card.dataset.animationOffset)).size).toBe(6);
    await expect(canvasElement.querySelector(".first-bot-live-avatar .bot-avatar-motion-idle")).toBeInTheDocument();
    await expect(canvasElement.querySelector(".first-bot-live-avatar")).toHaveAttribute(
      "data-avatar-seed",
      DEFAULT_FIRST_AGENT_DRAFT.avatarSeed,
    );

    suggestionList.scrollLeft = suggestionList.scrollWidth;
    await fireEvent.scroll(suggestionList);
    await expect(suggestionViewport).toHaveClass("can-scroll-back");
    await expect(suggestionViewport).not.toHaveClass("can-scroll-forward");
    suggestionList.scrollLeft = 0;
    await fireEvent.scroll(suggestionList);
  },
};

export const Interactions: Story = {
  play: async ({ args: storyArgs, canvas, canvasElement, userEvent }) => {
    const createButton = canvas.getByRole("button", { name: "Create agent" });

    const tripPlanner = canvas.getByRole("button", {
      name: "Trip Planner. Compares options and builds practical itineraries.",
    });
    await userEvent.click(tripPlanner);

    const suggestion = FIRST_AGENT_SUGGESTIONS[1];
    if (!suggestion) throw new Error("The Trip Planner suggestion is missing.");
    await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(suggestion.name);
    await expect(canvas.getByRole("textbox", { name: "What should this agent help with?" })).toHaveValue(
      suggestion.purpose,
    );
    await expect(tripPlanner).toHaveAttribute("aria-pressed", "true");
    await expect(createButton).toBeEnabled();

    const liveAvatar = canvasElement.querySelector<HTMLElement>(".first-bot-live-avatar");
    const headerAvatar = canvasElement.querySelector<HTMLElement>(".first-bot-header-identity");
    await expect(liveAvatar).toHaveAttribute("data-avatar-seed", suggestion.avatarSeed);
    await expect(headerAvatar).toHaveAttribute("data-avatar-seed", suggestion.avatarSeed);

    await userEvent.click(canvas.getByRole("button", { name: "Create agent" }));
    await expect(storyArgs.onSubmit).toHaveBeenCalledWith(draftFromSuggestion(suggestion));

    const nameInput = canvas.getByRole("textbox", { name: "Name" });
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Weekend Planner");
    await expect(tripPlanner).toHaveAttribute("aria-pressed", "false");
    await expect(storyArgs.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Weekend Planner", suggestionId: null }),
    );

    await userEvent.click(canvas.getByRole("button", { name: "Blue agent color" }));
    await userEvent.click(canvas.getByRole("button", { name: "Agent face 2" }));
    await expect(canvas.getByRole("button", { name: "Blue agent color" })).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: "Agent face 2" })).toHaveAttribute("aria-pressed", "true");
  },
};

const selectedSuggestion = FIRST_AGENT_SUGGESTIONS[1];

export const SuggestionSelected: Story = {
  args: {
    value: selectedSuggestion ? draftFromSuggestion(selectedSuggestion) : DEFAULT_FIRST_AGENT_DRAFT,
  },
};

export const Submitting: Story = {
  args: {
    value: selectedSuggestion ? draftFromSuggestion(selectedSuggestion) : DEFAULT_FIRST_AGENT_DRAFT,
    mode: "additional",
    submitting: true,
    onCancel: fn(),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Creating agent…" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(canvas.getByRole("textbox", { name: "Name" })).toBeDisabled();
    await expect(canvas.getByRole("textbox", { name: "What should this agent help with?" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: /^Inbox Helper\./ })).toBeDisabled();
  },
};

export const SmallWindow: Story = {
  parameters: { viewport: { defaultViewport: "firstAgentSmall" } },
  play: async ({ canvas, canvasElement }) => {
    const suggestionList = canvasElement.querySelector<HTMLElement>(".first-bot-suggestion-list");
    if (!suggestionList) throw new Error("The agent suggestion list is missing.");
    await expect(suggestionList.scrollWidth).toBeGreaterThan(suggestionList.clientWidth);

    const selectedFace = canvas.getByRole("button", { name: "Agent face 1" });
    const faceBody = selectedFace.querySelector<SVGRectElement>("svg rect");
    if (!faceBody) throw new Error("The selected agent face body is missing.");
    const buttonBounds = selectedFace.getBoundingClientRect();
    const bodyBounds = faceBody.getBoundingClientRect();
    await expect(
      Math.abs(buttonBounds.left + buttonBounds.width / 2 - (bodyBounds.left + bodyBounds.width / 2)),
    ).toBeLessThan(1);
    await expect(
      Math.abs(buttonBounds.top + buttonBounds.height / 2 - (bodyBounds.top + bodyBounds.height / 2)),
    ).toBeLessThan(1);
  },
};
