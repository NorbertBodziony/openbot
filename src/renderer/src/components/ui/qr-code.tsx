import type { JSX } from "@solidjs/web";
import QRCode from "qrcode";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Spinner } from "./surface";
import { cx } from "./utils";

export interface QrCodeProps {
  value: string;
  label?: string;
  size?: number;
  class?: string;
}

export function QrCode(props: QrCodeProps): JSX.Element {
  const size = () => props.size ?? 196;
  const [source, setSource] = createSignal<string | null>(null);
  const [error, setError] = createSignal(false);
  let revision = 0;

  createEffect(
    () => ({ value: props.value, size: size() }),
    ({ value, size: requestedSize }) => {
      const requestedRevision = ++revision;
      setSource(null);
      setError(false);
      void QRCode.toString(value, {
        type: "svg",
        width: requestedSize,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" },
      })
        .then((svg) => {
          if (revision !== requestedRevision) return;
          setSource(`data:image/svg+xml,${encodeURIComponent(svg)}`);
        })
        .catch(() => {
          if (revision === requestedRevision) setError(true);
        });
    },
  );

  onCleanup(() => {
    revision += 1;
  });

  return (
    <div
      class={cx("ui-qr-code", props.class)}
      style={{ width: `${size()}px`, height: `${size()}px` }}
      role="img"
      aria-label={props.label ?? "QR code"}
      aria-busy={!source() && !error() ? "true" : undefined}
    >
      <Show
        when={source()}
        fallback={
          <Show when={error()} fallback={<Spinner size="sm" />}>
            <span class="sr-only">QR code unavailable</span>
          </Show>
        }
      >
        {(url) => <img src={url()} alt="" width={size()} height={size()} />}
      </Show>
    </div>
  );
}
