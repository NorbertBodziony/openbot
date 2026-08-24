import { createEffect, createSignal } from "solid-js";
import { expect, fireEvent, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  DEFAULT_FIRST_BOT_DRAFT,
  FIRST_BOT_SUGGESTIONS,
  type FirstBotDraft,
  FirstBotSetup,
  type FirstBotSetupProps,
  type FirstBotSuggestion,
} from "../src/components/FirstBotSetup";

function draftFromSuggestion(suggestion: FirstBotSuggestion): FirstBotDraft {
  return {
    name: suggestion.name,
    purpose: suggestion.purpose,
    avatarSeed: suggestion.avatarSeed,
    avatarHue: suggestion.avatarHue,
    suggestionId: suggestion.id,
  };
}

function ControlledFirstBotSetup(props: FirstBotSetupProps) {
  const [draft, setDraft] = createSignal<FirstBotDraft>({ ...props.value });

  createEffect(
    () => props.value,
    (value) => {
      setDraft({ ...value });
    },
  );

  return (
    <FirstBotSetup
      {...props}
      value={draft()}
      onChange={(value) => {
        setDraft(value);
        props.onChange(value);
      }}
    />
  );
}

const args: FirstBotSetupProps = {
  value: DEFAULT_FIRST_BOT_DRAFT,
  suggestions: FIRST_BOT_SUGGESTIONS,
  submitting: false,
  onChange: fn(),
  onSubmit: fn(),
};

const meta = {
  title: "Setup/FirstBotSetup",
  component: FirstBotSetup,
  args,
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        firstBotSmall: {
          name: "First Bot — 700 × 720",
          styles: { width: "700px", height: "720px" },
        },
      },
    },
  },
  render: (storyArgs) => <ControlledFirstBotSetup {...storyArgs} />,
} satisfies Meta<typeof FirstBotSetup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    const createButton = canvas.getByRole("button", { name: "Create Bot" });
    await expect(canvas.getAllByRole("listitem")).toHaveLength(6);
    await expect(createButton).toBeDisabled();
    await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue("New Bot");
    await expect(canvas.getByRole("textbox", { name: "What should this Bot help with?" })).toHaveValue("");
    await expect(canvas.getAllByRole("button", { name: /Bot color$/ })).toHaveLength(9);
    await expect(canvas.queryByRole("button", { name: "Lime Bot color" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Violet Bot color" })).not.toBeInTheDocument();

    const suggestionViewport = canvasElement.querySelector<HTMLElement>(".first-bot-suggestion-viewport");
    const suggestionList = canvasElement.querySelector<HTMLElement>(".first-bot-suggestion-list");
    if (!suggestionViewport || !suggestionList) throw new Error("The Bot suggestion scroller is missing.");
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
      DEFAULT_FIRST_BOT_DRAFT.avatarSeed,
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
    const createButton = canvas.getByRole("button", { name: "Create Bot" });

    const tripPlanner = canvas.getByRole("button", {
      name: "Trip Planner. Compares options and builds practical itineraries.",
    });
    await userEvent.click(tripPlanner);

    const suggestion = FIRST_BOT_SUGGESTIONS[1];
    if (!suggestion) throw new Error("The Trip Planner suggestion is missing.");
    await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(suggestion.name);
    await expect(canvas.getByRole("textbox", { name: "What should this Bot help with?" })).toHaveValue(
      suggestion.purpose,
    );
    await expect(tripPlanner).toHaveAttribute("aria-pressed", "true");
    await expect(createButton).toBeEnabled();

    const liveAvatar = canvasElement.querySelector<HTMLElement>(".first-bot-live-avatar");
    const headerAvatar = canvasElement.querySelector<HTMLElement>(".first-bot-header-identity");
    await expect(liveAvatar).toHaveAttribute("data-avatar-seed", suggestion.avatarSeed);
    await expect(headerAvatar).toHaveAttribute("data-avatar-seed", suggestion.avatarSeed);

    await userEvent.click(canvas.getByRole("button", { name: "Create Bot" }));
    await expect(storyArgs.onSubmit).toHaveBeenCalledWith(draftFromSuggestion(suggestion));

    const nameInput = canvas.getByRole("textbox", { name: "Name" });
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Weekend Planner");
    await expect(tripPlanner).toHaveAttribute("aria-pressed", "false");
    await expect(storyArgs.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Weekend Planner", suggestionId: null }),
    );

    await userEvent.click(canvas.getByRole("button", { name: "Blue Bot color" }));
    await userEvent.click(canvas.getByRole("button", { name: "Bot face 2" }));
    await expect(canvas.getByRole("button", { name: "Blue Bot color" })).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: "Bot face 2" })).toHaveAttribute("aria-pressed", "true");
  },
};

const selectedSuggestion = FIRST_BOT_SUGGESTIONS[1];

export const SuggestionSelected: Story = {
  args: {
    value: selectedSuggestion ? draftFromSuggestion(selectedSuggestion) : DEFAULT_FIRST_BOT_DRAFT,
  },
};

export const Submitting: Story = {
  args: {
    value: selectedSuggestion ? draftFromSuggestion(selectedSuggestion) : DEFAULT_FIRST_BOT_DRAFT,
    mode: "additional",
    submitting: true,
    onCancel: fn(),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Creating Bot…" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(canvas.getByRole("textbox", { name: "Name" })).toBeDisabled();
    await expect(canvas.getByRole("textbox", { name: "What should this Bot help with?" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: /^Inbox Helper\./ })).toBeDisabled();
  },
};

export const SmallWindow: Story = {
  parameters: { viewport: { defaultViewport: "firstBotSmall" } },
  play: async ({ canvas, canvasElement }) => {
    const suggestionList = canvasElement.querySelector<HTMLElement>(".first-bot-suggestion-list");
    if (!suggestionList) throw new Error("The Bot suggestion list is missing.");
    await expect(suggestionList.scrollWidth).toBeGreaterThan(suggestionList.clientWidth);

    const selectedFace = canvas.getByRole("button", { name: "Bot face 1" });
    const faceBody = selectedFace.querySelector<SVGRectElement>("svg rect");
    if (!faceBody) throw new Error("The selected Bot face body is missing.");
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
