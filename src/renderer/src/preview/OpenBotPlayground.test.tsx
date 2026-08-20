import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { createMockOpenBot } from "./mock-openbot";
import { OpenBotPlayground } from "./OpenBotPlayground";

describe("OpenBotPlayground", () => {
  it("installs the mock desktop API and restores the previous API on cleanup", () => {
    const previousMock = createMockOpenBot();
    const activeMock = createMockOpenBot();
    const dispose = vi.spyOn(activeMock, "dispose");
    window.openbot = previousMock.api;

    const view = render(() => (
      <OpenBotPlayground
        dependencies={{
          createMock: () => activeMock,
          renderApp: () => <div data-testid="openbot-app" />,
        }}
      />
    ));
    expect(view.getByTestId("openbot-app")).toBeInTheDocument();
    expect(window.openbot).toBe(activeMock.api);

    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
    expect(window.openbot).toBe(previousMock.api);
    previousMock.dispose();
  });
});
