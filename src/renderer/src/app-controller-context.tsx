import { createContext, type ParentProps, useContext } from "solid-js";
import type { createAppController } from "./App";

/**
 * The controller context lives outside `App.tsx` so the shell views can read it without importing
 * `App.tsx` back: `App.tsx` imports the view, the view imports this module, and nothing points back.
 * Only the controller's *type* is borrowed from `App.tsx`, which the compiler erases.
 */
export type AppController = ReturnType<typeof createAppController>;

const AppControllerContext = createContext<AppController>();

export function useAppController(): AppController {
  const controller = useContext(AppControllerContext);
  if (!controller) throw new Error("App controller is unavailable outside App.");
  return controller;
}

/** @internal Test seam for remounting shell views without remounting their controller. */
export function AppControllerProvider(props: ParentProps<{ controller: AppController }>) {
  return <AppControllerContext value={props.controller}>{props.children}</AppControllerContext>;
}
