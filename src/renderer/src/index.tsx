import { render } from "@solidjs/web";
import { App } from "./App";
import { ComputerUseSetupSurface } from "./ComputerUseSetupSurface";
import { DynamicIslandSurface } from "./DynamicIslandSurface";
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
