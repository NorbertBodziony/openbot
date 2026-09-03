import type { AppInfo } from "@openbot/contracts/ipc";
import { createSignal, flush, onSettled } from "solid-js";
import type { AppProps } from "./app-providers";
import { createSimpleContext } from "./simple-context";

/**
 * What the renderer is running inside: which build and OS, whether the window
 * has focus, and the two flags fixed by how the app was mounted.
 *
 * The outermost domain, and deliberately ungated. Gating it on `appInfo` would
 * read well - everything below could treat the build as known - but it would
 * also hold back every provider under it, and with them the bootstrap loads
 * that run in parallel with `getAppInfo` today. The view already gates on
 * `appInfo()` where the null actually matters, so the gate would buy a narrower
 * type nowhere and cost a serialized startup everywhere.
 *
 * `appFocused` is maintained here and read by anything that treats a focused
 * window as "the user is looking at this". Domains that need to *act* when
 * focus returns listen for the event themselves rather than reacting to this
 * signal: the listener registered here runs first, because this provider is
 * created first, so the flag is already true by the time theirs runs.
 */
const Platform = createSimpleContext({
  name: "Platform",
  init: (props: AppProps) => {
    const [appInfo, setAppInfo] = createSignal<AppInfo | null>(null);
    const [appFocused, setAppFocused] = createSignal(document.hasFocus());
    // Whether `appInfo` is what main reported, as opposed to the fallback below.
    // Analytics attribution is only honest about the former.
    let infoFromHost = false;
    let appFrame: HTMLDivElement | undefined;

    onSettled(() => {
      const handleBlur = () => flush(() => setAppFocused(false));
      const handleFocus = () => flush(() => setAppFocused(true));
      window.addEventListener("blur", handleBlur);
      window.addEventListener("focus", handleFocus);
      void window.openbot
        .getAppInfo()
        .then((info) => {
          infoFromHost = true;
          setAppInfo(info);
        })
        .catch(() =>
          setAppInfo({
            name: "OpenBot",
            version: "unavailable",
            platform: "darwin",
            variant: "production",
          }),
        );
      return () => {
        window.removeEventListener("blur", handleBlur);
        window.removeEventListener("focus", handleFocus);
      };
    });

    return {
      appInfo,
      appFocused,
      appInfoLoadedFromHost: () => infoFromHost,
      landingPreview: props.landingPreview === true,
      peopleEnabled: props.peopleEnabled === true,
      /** The element the remote-desktop workspace makes inert while it is up. */
      appFrame: () => appFrame,
      setAppFrameElement: (element: HTMLDivElement) => {
        appFrame = element;
      },
    };
  },
});

export const PlatformProvider = Platform.provider;
export const usePlatform = Platform.use;
