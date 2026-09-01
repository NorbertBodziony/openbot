import type { ComponentProps, JSX } from "@solidjs/web";
import { Toaster as Sonner, toast } from "solid-sonner";
import { CircleCheck, Info, LoaderCircle, OctagonX, TriangleAlert } from "./icons";
import { cx } from "./utils";

export type ToasterProps = ComponentProps<typeof Sonner>;

export function Toaster(props: ToasterProps): JSX.Element {
  return (
    <Sonner
      {...props}
      class={cx("ui-toaster", (props.closeButton ?? true) && "ui-toaster-closeable", props.class)}
      theme={props.theme ?? "dark"}
      position={props.position ?? "top-right"}
      visibleToasts={props.visibleToasts ?? 3}
      duration={props.duration ?? 6_000}
      gap={props.gap ?? 8}
      richColors={props.richColors ?? false}
      closeButton={props.closeButton ?? true}
      pauseWhenPageIsHidden={props.pauseWhenPageIsHidden ?? true}
      containerAriaLabel={props.containerAriaLabel ?? "Notifications"}
      toastOptions={{ closeButtonAriaLabel: "Close notification", ...props.toastOptions }}
      icons={{
        success: <CircleCheck class="ui-toast-icon" aria-hidden="true" />,
        info: <Info class="ui-toast-icon" aria-hidden="true" />,
        warning: <TriangleAlert class="ui-toast-icon" aria-hidden="true" />,
        error: <OctagonX class="ui-toast-icon" aria-hidden="true" />,
        loading: <LoaderCircle class="ui-toast-icon ui-toast-loading-icon" aria-hidden="true" />,
        ...props.icons,
      }}
    />
  );
}

export type { ExternalToast, ToastT } from "solid-sonner";
export { toast };
