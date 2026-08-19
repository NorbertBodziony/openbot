import type { Preview } from "storybook-solidjs-vite";
import "./preview.css";
import "../src/renderer/src/styles.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    controls: {
      expanded: true,
    },
  },
};

export default preview;
