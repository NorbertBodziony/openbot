import { render } from "@solidjs/web";
import "blobatar/motion.css";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root element was not found.");
}

render(() => <App />, root);
