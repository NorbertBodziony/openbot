import { render } from "@solidjs/web";
import { App } from "./App";
import { DynamicIslandSurface } from "./DynamicIslandSurface";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root element was not found.");
}

const surface = new URLSearchParams(window.location.search).get("surface");
render(() => (surface === "dynamic-island" ? <DynamicIslandSurface /> : <App />), root);
