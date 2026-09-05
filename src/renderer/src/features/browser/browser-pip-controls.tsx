import { render } from "@solidjs/web";
import { Button, PanelRight, X } from "../../components/ui";
import "../../styles.css";

function BrowserPictureInPictureControls() {
  return (
    <div class="browser-pip-hover-controls" role="toolbar" aria-label="Browser window controls">
      <Button
        variant="ghost"
        type="button"
        class="browser-pip-hover-button"
        aria-label="Reattach browser to right sidebar"
        title="Reattach browser"
        onClick={() => void window.openbot.browser.dockPictureInPicture()}
      >
        <PanelRight class="browser-toolbar-icon" />
      </Button>
      <Button
        variant="ghost"
        type="button"
        class="browser-pip-hover-button"
        aria-label="Close browser popup"
        title="Close browser popup"
        onClick={() => void window.openbot.browser.hidePictureInPicture()}
      >
        <X class="browser-toolbar-icon" />
      </Button>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Browser Picture in Picture controls root was not found.");
render(() => <BrowserPictureInPictureControls />, root);
