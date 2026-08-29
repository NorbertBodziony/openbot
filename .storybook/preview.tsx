import type { Preview } from "storybook-solidjs-vite";
import "../src/renderer/src/styles.css";
import "./preview.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    a11y: {
      test: "error",
    },
    controls: {
      expanded: true,
    },
  },
};

export default preview;
