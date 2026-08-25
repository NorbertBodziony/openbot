import * as AlertDialogPrimitive from "@kobalte/core/alert-dialog";
import * as ComboboxPrimitive from "@kobalte/core/combobox";
import * as ContextMenuPrimitive from "@kobalte/core/context-menu";
import * as DialogPrimitive from "@kobalte/core/dialog";
import * as DropdownMenuPrimitive from "@kobalte/core/dropdown-menu";
import * as ListboxPrimitive from "@kobalte/core/listbox";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as PopoverPrimitive from "@kobalte/core/popover";
import * as RadioGroupPrimitive from "@kobalte/core/radio-group";
import * as KobalteSelect from "@kobalte/core/select";
import * as TabsPrimitive from "@kobalte/core/tabs";
import * as TooltipPrimitive from "@kobalte/core/tooltip";
import type { ValidComponent } from "@solidjs/web";

type OpenChangeHandler = (open: boolean) => void;

function actionMenuClass(className: string | undefined): string {
  return className ? `ui-action-menu ${className}` : "ui-action-menu";
}

function focusRestoreHandler(upstream: () => OpenChangeHandler | undefined): OpenChangeHandler {
  let restoreTarget: HTMLElement | null = null;
  return (open) => {
    if (open) {
      restoreTarget =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null;
      queueMicrotask(() => {
        restoreTarget ??=
          Array.from(document.querySelectorAll<HTMLElement>('[aria-haspopup][aria-expanded="true"]')).find(
            (element) => element.isConnected,
          ) ?? null;
      });
    }

    upstream()?.(open);

    if (!open && restoreTarget?.isConnected) {
      const target = restoreTarget;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => target.focus()));
    }
  };
}

function SelectRootAdapter<Option, OptGroup = never, T extends ValidComponent = "div">(
  props: PolymorphicProps<T, KobalteSelect.SelectRootProps<Option, OptGroup, T>>,
) {
  return KobalteSelect.Root<Option, OptGroup, T>(props);
}

function ComboboxRootAdapter<Option, OptGroup = never, T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ComboboxPrimitive.ComboboxRootProps<Option, OptGroup, T>>,
) {
  return ComboboxPrimitive.Root<Option, OptGroup, T>(props);
}

function ListboxRootAdapter<Option, OptGroup = never, T extends ValidComponent = "ul">(
  props: PolymorphicProps<T, ListboxPrimitive.ListboxRootProps<Option, OptGroup, T>>,
) {
  return ListboxPrimitive.Root<Option, OptGroup, T>(props);
}

interface DialogApi {
  Root: typeof DialogPrimitive.Root;
  Portal: typeof DialogPrimitive.Portal;
  Trigger: typeof DialogPrimitive.Trigger;
  Overlay: typeof DialogPrimitive.Overlay;
  Content: typeof DialogPrimitive.Content;
  Title: typeof DialogPrimitive.Title;
  Description: typeof DialogPrimitive.Description;
  CloseButton: typeof DialogPrimitive.CloseButton;
}

export const Dialog: DialogApi = {
  Root: (props) => <DialogPrimitive.Root {...props} onOpenChange={focusRestoreHandler(() => props.onOpenChange)} />,
  Portal: (props) => <DialogPrimitive.Portal {...props} />,
  Trigger: (props) => <DialogPrimitive.Trigger {...props} />,
  Overlay: (props) => <DialogPrimitive.Overlay {...props} />,
  Content: (props) => <DialogPrimitive.Content {...props} />,
  Title: (props) => <DialogPrimitive.Title {...props} />,
  Description: (props) => <DialogPrimitive.Description {...props} />,
  CloseButton: (props) => <DialogPrimitive.CloseButton {...props} />,
};

interface AlertDialogApi {
  Root: typeof AlertDialogPrimitive.Root;
  Portal: typeof AlertDialogPrimitive.Portal;
  Trigger: typeof AlertDialogPrimitive.Trigger;
  Overlay: typeof AlertDialogPrimitive.Overlay;
  Content: typeof AlertDialogPrimitive.Content;
  Title: typeof AlertDialogPrimitive.Title;
  Description: typeof AlertDialogPrimitive.Description;
  CloseButton: typeof AlertDialogPrimitive.CloseButton;
}

export const AlertDialog: AlertDialogApi = {
  Root: (props) => (
    <AlertDialogPrimitive.Root {...props} onOpenChange={focusRestoreHandler(() => props.onOpenChange)} />
  ),
  Portal: (props) => <AlertDialogPrimitive.Portal {...props} />,
  Trigger: (props) => <AlertDialogPrimitive.Trigger {...props} />,
  Overlay: (props) => <AlertDialogPrimitive.Overlay {...props} />,
  Content: (props) => <AlertDialogPrimitive.Content {...props} />,
  Title: (props) => <AlertDialogPrimitive.Title {...props} />,
  Description: (props) => <AlertDialogPrimitive.Description {...props} />,
  CloseButton: (props) => <AlertDialogPrimitive.CloseButton {...props} />,
};

interface DropdownMenuApi {
  Root: typeof DropdownMenuPrimitive.Root;
  Portal: typeof DropdownMenuPrimitive.Portal;
  Trigger: typeof DropdownMenuPrimitive.Trigger;
  Content: typeof DropdownMenuPrimitive.Content;
  Item: typeof DropdownMenuPrimitive.Item;
  CheckboxItem: typeof DropdownMenuPrimitive.CheckboxItem;
  RadioGroup: typeof DropdownMenuPrimitive.RadioGroup;
  RadioItem: typeof DropdownMenuPrimitive.RadioItem;
  Separator: typeof DropdownMenuPrimitive.Separator;
}

export const DropdownMenu: DropdownMenuApi = {
  Root: (props) => (
    <DropdownMenuPrimitive.Root {...props} onOpenChange={focusRestoreHandler(() => props.onOpenChange)} />
  ),
  Portal: (props) => <DropdownMenuPrimitive.Portal {...props} />,
  Trigger: (props) => <DropdownMenuPrimitive.Trigger {...props} />,
  Content: (props) => <DropdownMenuPrimitive.Content {...props} class={actionMenuClass(props.class)} />,
  Item: (props) => <DropdownMenuPrimitive.Item {...props} />,
  CheckboxItem: (props) => <DropdownMenuPrimitive.CheckboxItem {...props} />,
  RadioGroup: (props) => <DropdownMenuPrimitive.RadioGroup {...props} />,
  RadioItem: (props) => <DropdownMenuPrimitive.RadioItem {...props} />,
  Separator: (props) => <DropdownMenuPrimitive.Separator {...props} />,
};

interface ContextMenuApi {
  Root: typeof ContextMenuPrimitive.Root;
  Portal: typeof ContextMenuPrimitive.Portal;
  Trigger: typeof ContextMenuPrimitive.Trigger;
  Content: typeof ContextMenuPrimitive.Content;
  Sub: typeof ContextMenuPrimitive.Sub;
  SubTrigger: typeof ContextMenuPrimitive.SubTrigger;
  SubContent: typeof ContextMenuPrimitive.SubContent;
  Item: typeof ContextMenuPrimitive.Item;
  Separator: typeof ContextMenuPrimitive.Separator;
}

export const ContextMenu: ContextMenuApi = {
  Root: (props) => (
    <ContextMenuPrimitive.Root {...props} onOpenChange={focusRestoreHandler(() => props.onOpenChange)} />
  ),
  Portal: (props) => <ContextMenuPrimitive.Portal {...props} />,
  Trigger: (props) => <ContextMenuPrimitive.Trigger {...props} />,
  Content: (props) => <ContextMenuPrimitive.Content {...props} class={actionMenuClass(props.class)} />,
  Sub: ContextMenuPrimitive.Sub,
  SubTrigger: ContextMenuPrimitive.SubTrigger,
  SubContent: ContextMenuPrimitive.SubContent,
  Item: (props) => <ContextMenuPrimitive.Item {...props} />,
  Separator: (props) => <ContextMenuPrimitive.Separator {...props} />,
};

interface PopoverApi {
  Root: typeof PopoverPrimitive.Root;
  Portal: typeof PopoverPrimitive.Portal;
  Trigger: typeof PopoverPrimitive.Trigger;
  Content: typeof PopoverPrimitive.Content;
  Title: typeof PopoverPrimitive.Title;
  Description: typeof PopoverPrimitive.Description;
  CloseButton: typeof PopoverPrimitive.CloseButton;
}

export const Popover: PopoverApi = {
  Root: (props) => <PopoverPrimitive.Root {...props} onOpenChange={focusRestoreHandler(() => props.onOpenChange)} />,
  Portal: (props) => <PopoverPrimitive.Portal {...props} />,
  Trigger: (props) => <PopoverPrimitive.Trigger {...props} />,
  Content: (props) => <PopoverPrimitive.Content {...props} />,
  Title: (props) => <PopoverPrimitive.Title {...props} />,
  Description: (props) => <PopoverPrimitive.Description {...props} />,
  CloseButton: (props) => <PopoverPrimitive.CloseButton {...props} />,
};

interface TooltipApi {
  Root: typeof TooltipPrimitive.Root;
  Portal: typeof TooltipPrimitive.Portal;
  Trigger: typeof TooltipPrimitive.Trigger;
  Content: typeof TooltipPrimitive.Content;
}

export const Tooltip: TooltipApi = {
  Root: (props) => <TooltipPrimitive.Root {...props} />,
  Portal: (props) => <TooltipPrimitive.Portal {...props} />,
  Trigger: (props) => <TooltipPrimitive.Trigger {...props} />,
  Content: (props) => <TooltipPrimitive.Content {...props} />,
};

interface TabsApi {
  Root: typeof TabsPrimitive.Root;
  List: typeof TabsPrimitive.List;
  Trigger: typeof TabsPrimitive.Trigger;
  Content: typeof TabsPrimitive.Content;
  Indicator: typeof TabsPrimitive.Indicator;
}

export const Tabs: TabsApi = {
  Root: (props) => <TabsPrimitive.Root {...props} />,
  List: (props) => <TabsPrimitive.List {...props} />,
  Trigger: (props) => <TabsPrimitive.Trigger {...props} />,
  Content: (props) => <TabsPrimitive.Content {...props} />,
  Indicator: (props) => <TabsPrimitive.Indicator {...props} />,
};

interface RadioGroupApi {
  Root: typeof RadioGroupPrimitive.Root;
  Label: typeof RadioGroupPrimitive.Label;
  Description: typeof RadioGroupPrimitive.Description;
  ErrorMessage: typeof RadioGroupPrimitive.ErrorMessage;
  Item: typeof RadioGroupPrimitive.Item;
  ItemInput: typeof RadioGroupPrimitive.ItemInput;
  ItemControl: typeof RadioGroupPrimitive.ItemControl;
  ItemIndicator: typeof RadioGroupPrimitive.ItemIndicator;
  ItemLabel: typeof RadioGroupPrimitive.ItemLabel;
  ItemDescription: typeof RadioGroupPrimitive.ItemDescription;
}

export const RadioGroup: RadioGroupApi = {
  Root: (props) => <RadioGroupPrimitive.Root {...props} />,
  Label: (props) => <RadioGroupPrimitive.Label {...props} />,
  Description: (props) => <RadioGroupPrimitive.Description {...props} />,
  ErrorMessage: (props) => <RadioGroupPrimitive.ErrorMessage {...props} />,
  Item: (props) => <RadioGroupPrimitive.Item {...props} />,
  ItemInput: (props) => <RadioGroupPrimitive.ItemInput {...props} />,
  ItemControl: (props) => <RadioGroupPrimitive.ItemControl {...props} />,
  ItemIndicator: (props) => <RadioGroupPrimitive.ItemIndicator {...props} />,
  ItemLabel: (props) => <RadioGroupPrimitive.ItemLabel {...props} />,
  ItemDescription: (props) => <RadioGroupPrimitive.ItemDescription {...props} />,
};

interface SelectPrimitiveApi {
  Root: typeof KobalteSelect.Root;
  Label: typeof KobalteSelect.Label;
  Description: typeof KobalteSelect.Description;
  ErrorMessage: typeof KobalteSelect.ErrorMessage;
  Trigger: typeof KobalteSelect.Trigger;
  Value: typeof KobalteSelect.Value;
  HiddenSelect: typeof KobalteSelect.HiddenSelect;
  Portal: typeof KobalteSelect.Portal;
  Content: typeof KobalteSelect.Content;
  Listbox: typeof KobalteSelect.Listbox;
  Item: typeof KobalteSelect.Item;
  ItemLabel: typeof KobalteSelect.ItemLabel;
  ItemIndicator: typeof KobalteSelect.ItemIndicator;
}

export const SelectPrimitive: SelectPrimitiveApi = {
  Root: SelectRootAdapter,
  Label: (props) => <KobalteSelect.Label {...props} />,
  Description: (props) => <KobalteSelect.Description {...props} />,
  ErrorMessage: (props) => <KobalteSelect.ErrorMessage {...props} />,
  Trigger: (props) => <KobalteSelect.Trigger {...props} />,
  Value: (props) => <KobalteSelect.Value {...props} />,
  HiddenSelect: (props) => <KobalteSelect.HiddenSelect {...props} />,
  Portal: (props) => <KobalteSelect.Portal {...props} />,
  Content: (props) => <KobalteSelect.Content {...props} />,
  Listbox: (props) => <KobalteSelect.Listbox {...props} />,
  Item: (props) => <KobalteSelect.Item {...props} />,
  ItemLabel: (props) => <KobalteSelect.ItemLabel {...props} />,
  ItemIndicator: (props) => <KobalteSelect.ItemIndicator {...props} />,
};

interface ComboboxApi {
  Root: typeof ComboboxPrimitive.Root;
  Label: typeof ComboboxPrimitive.Label;
  Description: typeof ComboboxPrimitive.Description;
  ErrorMessage: typeof ComboboxPrimitive.ErrorMessage;
  Control: typeof ComboboxPrimitive.Control;
  Input: typeof ComboboxPrimitive.Input;
  Trigger: typeof ComboboxPrimitive.Trigger;
  HiddenSelect: typeof ComboboxPrimitive.HiddenSelect;
  Portal: typeof ComboboxPrimitive.Portal;
  Content: typeof ComboboxPrimitive.Content;
  Listbox: typeof ComboboxPrimitive.Listbox;
  Item: typeof ComboboxPrimitive.Item;
  ItemLabel: typeof ComboboxPrimitive.ItemLabel;
  ItemIndicator: typeof ComboboxPrimitive.ItemIndicator;
}

export const Combobox: ComboboxApi = {
  Root: ComboboxRootAdapter,
  Label: (props) => <ComboboxPrimitive.Label {...props} />,
  Description: (props) => <ComboboxPrimitive.Description {...props} />,
  ErrorMessage: (props) => <ComboboxPrimitive.ErrorMessage {...props} />,
  Control: (props) => <ComboboxPrimitive.Control {...props} />,
  Input: (props) => <ComboboxPrimitive.Input {...props} />,
  Trigger: (props) => <ComboboxPrimitive.Trigger {...props} />,
  HiddenSelect: (props) => <ComboboxPrimitive.HiddenSelect {...props} />,
  Portal: (props) => <ComboboxPrimitive.Portal {...props} />,
  Content: (props) => <ComboboxPrimitive.Content {...props} />,
  Listbox: (props) => <ComboboxPrimitive.Listbox {...props} />,
  Item: (props) => <ComboboxPrimitive.Item {...props} />,
  ItemLabel: (props) => <ComboboxPrimitive.ItemLabel {...props} />,
  ItemIndicator: (props) => <ComboboxPrimitive.ItemIndicator {...props} />,
};

interface ListboxApi {
  Root: typeof ListboxPrimitive.Root;
  Item: typeof ListboxPrimitive.Item;
  ItemLabel: typeof ListboxPrimitive.ItemLabel;
  ItemDescription: typeof ListboxPrimitive.ItemDescription;
  ItemIndicator: typeof ListboxPrimitive.ItemIndicator;
  Section: typeof ListboxPrimitive.Section;
}

export const Listbox: ListboxApi = {
  Root: ListboxRootAdapter,
  Item: (props) => <ListboxPrimitive.Item {...props} />,
  ItemLabel: (props) => <ListboxPrimitive.ItemLabel {...props} />,
  ItemDescription: (props) => <ListboxPrimitive.ItemDescription {...props} />,
  ItemIndicator: (props) => <ListboxPrimitive.ItemIndicator {...props} />,
  Section: (props) => <ListboxPrimitive.Section {...props} />,
};
