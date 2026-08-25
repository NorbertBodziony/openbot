import { createSignal } from "solid-js";
import { expect, fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  AlertDialog,
  buttonVariants,
  Combobox,
  ContextMenu,
  Copy,
  Dialog,
  DropdownMenu,
  ExternalLink,
  Heading,
  Input,
  Link2,
  Listbox,
  Pencil,
  Popover,
  RadioGroup,
  SelectPrimitive,
  Tabs,
  Tooltip,
  Trash2,
} from "../src/components/ui";

const meta = {
  title: "Foundations/Interactions",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const DialogFocus: Story = {
  render: () => (
    <main class="foundation-story foundation-interaction-stage">
      <Heading as="h1" size="lg">
        Dialog
      </Heading>
      <Dialog.Root>
        <Dialog.Trigger class={buttonVariants({ variant: "outline", size: "sm" })}>Open dialog</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay class="foundation-overlay">
            <Dialog.Content class="foundation-dialog">
              <Dialog.Title as="h2">Create agent</Dialog.Title>
              <Dialog.Description>Choose a short, recognizable name.</Dialog.Description>
              <Input aria-label="Agent name" value="Researcher" />
              <div class="foundation-dialog-actions">
                <Dialog.CloseButton class={buttonVariants({ variant: "outline", size: "sm" })}>
                  Cancel
                </Dialog.CloseButton>
                <Dialog.CloseButton class={buttonVariants({ variant: "default", size: "sm" })}>
                  Create
                </Dialog.CloseButton>
              </div>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  ),
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Open dialog" });
    await userEvent.click(trigger);
    const body = within(document.body);
    const dialog = await body.findByRole("dialog");
    await expect(dialog).toBeVisible();
    await userEvent.keyboard("{Tab}");
    const activeElement = document.activeElement;
    await expect(activeElement).toBeInstanceOf(HTMLElement);
    if (activeElement instanceof HTMLElement) await expect(dialog).toContainElement(activeElement);
    await userEvent.keyboard("{Escape}");
    await expect(body.queryByRole("dialog")).not.toBeInTheDocument();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await expect(trigger).toHaveFocus();
  },
};

export const AlertDialogConfirmation: Story = {
  render: () => (
    <main class="foundation-story foundation-interaction-stage">
      <Heading as="h1" size="lg">
        Alert dialog
      </Heading>
      <AlertDialog.Root>
        <AlertDialog.Trigger class={buttonVariants({ variant: "destructive", size: "sm" })}>
          Delete agent
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="foundation-overlay">
            <AlertDialog.Content class="foundation-dialog">
              <AlertDialog.Title>Delete Researcher?</AlertDialog.Title>
              <AlertDialog.Description>This action cannot be undone.</AlertDialog.Description>
              <div class="foundation-dialog-actions">
                <AlertDialog.CloseButton class={buttonVariants({ variant: "outline", size: "sm" })} aria-label="Cancel">
                  Cancel
                </AlertDialog.CloseButton>
                <AlertDialog.CloseButton
                  class={buttonVariants({ variant: "destructive", size: "sm" })}
                  aria-label="Delete"
                >
                  Delete
                </AlertDialog.CloseButton>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Overlay>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </main>
  ),
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Delete agent" });
    await userEvent.click(trigger);
    const body = within(document.body);
    await expect(await body.findByRole("alertdialog")).toBeVisible();
    await userEvent.click(body.getByRole("button", { name: "Cancel" }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await expect(body.queryByRole("alertdialog")).not.toBeInTheDocument();
    await expect(trigger).toHaveFocus();
  },
};

export const MenuPopoverTooltip: Story = {
  render: () => (
    <main class="foundation-story foundation-interaction-stage">
      <Heading as="h1" size="lg">
        Anchored interactions
      </Heading>
      <div class="foundation-story-row">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger class={buttonVariants({ variant: "outline", size: "sm" })}>
            Agent actions
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="foundation-menu">
              <DropdownMenu.Item>
                <Pencil aria-hidden="true" />
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled>
                <Copy aria-hidden="true" />
                Duplicate
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item class="ui-action-menu-danger">
                <Trash2 aria-hidden="true" />
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <Popover.Root>
          <Popover.Trigger class={buttonVariants({ variant: "outline", size: "sm" })}>Show details</Popover.Trigger>
          <Popover.Portal>
            <Popover.Content class="foundation-popover">
              <Popover.Title>Agent details</Popover.Title>
              <Popover.Description>Compact information anchored to its trigger.</Popover.Description>
              <Popover.CloseButton class={buttonVariants({ variant: "ghost", size: "sm" })} aria-label="Close">
                Close
              </Popover.CloseButton>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <Tooltip.Root openDelay={0} closeDelay={0}>
          <Tooltip.Trigger class={buttonVariants({ variant: "ghost", size: "sm" })}>Hover or focus</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="foundation-tooltip">Keyboard shortcut: ⌘K</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <ContextMenu.Root>
          <ContextMenu.Trigger class="foundation-context-target">Right-click for actions</ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content class="foundation-menu">
              <ContextMenu.Item>
                <ExternalLink aria-hidden="true" />
                Open
              </ContextMenu.Item>
              <ContextMenu.Item>
                <Link2 aria-hidden="true" />
                Copy link
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      </div>
    </main>
  ),
  play: async ({ canvas, userEvent }) => {
    const body = within(document.body);
    const menuTrigger = canvas.getByRole("button", { name: "Agent actions" });
    await userEvent.click(menuTrigger);
    const menu = await body.findByRole("menu");
    const menuItems = within(menu).getAllByRole("menuitem");
    const menuStyle = getComputedStyle(menu);
    const firstItemStyle = getComputedStyle(menuItems[0]);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveClass("ui-action-menu");
    await expect(menu.getBoundingClientRect().width).toBe(160);
    await expect(menuStyle.padding).toBe("4px");
    await expect(menuStyle.borderRadius).toBe("8px");
    await expect(menuItems[0].getBoundingClientRect().height).toBe(32);
    await expect(firstItemStyle.padding).toBe("6px 8px");
    await expect(firstItemStyle.gap).toBe("8px");
    await expect(firstItemStyle.borderRadius).toBe("6px");
    await expect(firstItemStyle.fontSize).toBe("14px");
    await expect(firstItemStyle.lineHeight).toBe("20px");
    await expect(firstItemStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    await expect(menuItems[0].querySelector("svg")?.getBoundingClientRect().width).toBe(16);
    await expect(body.getByRole("menuitem", { name: "Duplicate" })).toHaveAttribute("data-disabled");
    const deleteItem = body.getByRole("menuitem", { name: "Delete" });
    const deleteIcon = deleteItem.querySelector("svg");
    const menuSeparator = within(menu).getByRole("separator");
    const subtleDividerColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--openbot-shadow-ring")
      .trim();
    await expect(deleteItem).toHaveClass("ui-action-menu-danger");
    await expect(getComputedStyle(deleteItem).color).not.toBe(firstItemStyle.color);
    await expect(getComputedStyle(menuSeparator).backgroundColor).toBe(subtleDividerColor);
    await expect(getComputedStyle(menuSeparator).margin).toBe("4px 0px");
    if (!(deleteIcon instanceof SVGElement)) throw new Error("Delete icon was not found.");
    await expect(getComputedStyle(deleteIcon).color).toBe(getComputedStyle(deleteItem).color);
    await userEvent.keyboard("{ArrowDown}{End}");
    await expect(body.getByRole("menuitem", { name: "Delete" })).toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Escape}");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await expect(menuTrigger).toHaveFocus();

    const tooltipTrigger = canvas.getByRole("button", { name: "Hover or focus" });
    tooltipTrigger.focus();
    await expect(await body.findByRole("tooltip")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(body.queryByRole("tooltip")).not.toBeInTheDocument();

    const popoverTrigger = canvas.getByRole("button", { name: "Show details" });
    await userEvent.click(popoverTrigger);
    await expect(await body.findByRole("dialog", { name: "Agent details" })).toBeVisible();
    await userEvent.click(body.getByRole("button", { name: "Close" }));
    await expect(body.queryByRole("dialog", { name: "Agent details" })).not.toBeInTheDocument();

    const contextTrigger = canvas.getByText("Right-click for actions");
    await userEvent.pointer({ keys: "[MouseRight]", target: contextTrigger });
    await expect(await body.findByRole("menu")).toHaveClass("ui-action-menu");
    await userEvent.keyboard("{Home}");
    await expect(body.getByRole("menuitem", { name: "Open" })).toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Escape}");
  },
};

export const TabsAndRadioGroup: Story = {
  render: () => {
    const [channel, setChannel] = createSignal("general");
    return (
      <main class="foundation-story foundation-interaction-stage">
        <Heading as="h1" size="lg">
          Selection groups
        </Heading>
        <Tabs.Root defaultValue="models" class="foundation-tabs">
          <Tabs.List class="foundation-tabs-list" aria-label="Agent settings">
            <Tabs.Trigger class="foundation-tab" value="models">
              Models
            </Tabs.Trigger>
            <Tabs.Trigger class="foundation-tab" value="tools">
              Tools
            </Tabs.Trigger>
            <Tabs.Trigger class="foundation-tab" value="permissions">
              Permissions
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content class="foundation-tab-panel" value="models">
            Model settings
          </Tabs.Content>
          <Tabs.Content class="foundation-tab-panel" value="tools">
            Tool settings
          </Tabs.Content>
          <Tabs.Content class="foundation-tab-panel" value="permissions">
            Permission settings
          </Tabs.Content>
        </Tabs.Root>
        <RadioGroup.Root
          class="foundation-radio-group"
          value={channel()}
          onChange={setChannel}
          aria-label="Default channel"
        >
          {[
            ["general", "General"],
            ["research", "Research"],
            ["support", "Support"],
          ].map(([value, label]) => (
            <RadioGroup.Item class="foundation-radio-item" value={value}>
              <RadioGroup.ItemInput />
              <RadioGroup.ItemControl class="foundation-radio-control" />
              <RadioGroup.ItemLabel>{label}</RadioGroup.ItemLabel>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </main>
    );
  },
  play: async ({ canvas, userEvent }) => {
    const models = canvas.getByRole("tab", { name: "Models" });
    models.focus();
    await userEvent.keyboard("{End}");
    await expect(canvas.getByRole("tab", { name: "Permissions" })).toHaveFocus();
    await expect(canvas.getByRole("tabpanel")).toHaveTextContent("Permission settings");

    const general = canvas.getByRole("radio", { name: "General" });
    general.focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(canvas.getByRole("radio", { name: "Research" })).toBeChecked();
  },
};

const pickerOptions = ["GPT-5", "Claude Sonnet", "Gemini Pro"];

export const Pickers: Story = {
  render: () => (
    <main class="foundation-story foundation-interaction-stage">
      <Heading as="h1" size="lg">
        Pickers
      </Heading>
      <div class="foundation-story-stack">
        <SelectPrimitive.Root<string>
          options={pickerOptions}
          placeholder="Choose a model"
          itemComponent={(props) => (
            <SelectPrimitive.Item class="foundation-listbox-item" item={props.item}>
              <SelectPrimitive.ItemLabel>{props.item.rawValue}</SelectPrimitive.ItemLabel>
            </SelectPrimitive.Item>
          )}
        >
          <SelectPrimitive.Trigger class="ui-input foundation-picker-trigger" aria-label="Model">
            <SelectPrimitive.Value<string>>{(state) => state.selectedOption()}</SelectPrimitive.Value>
          </SelectPrimitive.Trigger>
          <SelectPrimitive.Portal>
            <SelectPrimitive.Content class="foundation-picker-content">
              <SelectPrimitive.Listbox class="foundation-listbox" />
            </SelectPrimitive.Content>
          </SelectPrimitive.Portal>
        </SelectPrimitive.Root>

        <Combobox.Root<string>
          options={pickerOptions}
          placeholder="Search models"
          itemComponent={(props) => (
            <Combobox.Item class="foundation-listbox-item" item={props.item}>
              <Combobox.ItemLabel>{props.item.rawValue}</Combobox.ItemLabel>
            </Combobox.Item>
          )}
        >
          <Combobox.Control class="foundation-combobox-control">
            <Combobox.Label>Search model</Combobox.Label>
            <Combobox.Input class="ui-input foundation-combobox-input" />
          </Combobox.Control>
          <Combobox.Portal>
            <Combobox.Content class="foundation-picker-content">
              <Combobox.Listbox class="foundation-listbox" />
            </Combobox.Content>
          </Combobox.Portal>
        </Combobox.Root>

        <Listbox.Root<string>
          options={pickerOptions}
          aria-label="Available models"
          class="foundation-listbox foundation-picker-content"
          renderItem={(item) => (
            <Listbox.Item class="foundation-listbox-item" item={item}>
              <Listbox.ItemLabel>{item.rawValue}</Listbox.ItemLabel>
            </Listbox.Item>
          )}
          onChange={fn()}
        />
      </div>
    </main>
  ),
  play: async ({ canvas, userEvent }) => {
    const select = canvas.getByRole("button", { name: /Model/ });
    select.focus();
    await userEvent.keyboard("{ArrowDown}");
    const body = within(document.body);
    await expect((await body.findAllByRole("listbox")).at(-1)).toBeVisible();
    await userEvent.keyboard("{End}{Enter}");
    await expect(select).toHaveTextContent("Gemini Pro");

    const combobox = canvas.getByRole("combobox", { name: "Search model" });
    await userEvent.click(combobox);
    await userEvent.type(combobox, "Claude");
    await expect(combobox).toHaveValue("Claude");
  },
};
