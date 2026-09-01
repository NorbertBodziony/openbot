import { Button } from "./button";
import { X } from "./icons";
import { cx } from "./utils";

export interface ImageRemoveButtonProps {
  label: string;
  class?: string;
  disabled?: boolean;
  onClick: () => void;
}

export function ImageRemoveButton(props: ImageRemoveButtonProps) {
  return (
    <Button
      type="button"
      variant="destructive-ghost"
      size="icon-xs"
      class={cx("ui-image-remove-button", props.class)}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <X aria-hidden="true" />
    </Button>
  );
}
