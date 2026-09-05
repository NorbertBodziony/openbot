import { render } from "@solidjs/web";
import { App } from "./App";
import { ComputerUseSetupSurface } from "./features/computer-use/ComputerUseSetupSurface";
import { DynamicIslandSurface } from "./features/dynamic-island/DynamicIslandSurface";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root element was not found.");
}

const surface = new URLSearchParams(window.location.search).get("surface");
render(
  () =>
    surface === "dynamic-island" ? (
      <DynamicIslandSurface />
    ) : surface === "computer-use-setup" ? (
      <ComputerUseSetupSurface />
    ) : (
      <App />
    ),
  root,
);
