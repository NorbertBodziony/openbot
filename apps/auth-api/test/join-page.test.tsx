import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { JoinPage } from "../src/components/landing/JoinPage";

const INVITE_URL =
  "https://openbot.run/join?api=https%3A%2F%2Fstudio-mac-k7m4q2pz-host.openbot.run%2F&server=00000000-0000-4000-8000-000000000000&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&invite=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(cleanup);

describe("invitation landing page", () => {
  it("offers the desktop fallback without displaying the bearer token", async () => {
    window.history.replaceState({}, "", INVITE_URL);
    render(() => <JoinPage />);

    const openButton = await screen.findByRole("link", { name: "Open OpenBot" });
    await waitFor(() => expect(openButton).toHaveAttribute("href", expect.stringMatching(/^openbot:\/\/join\?/u)));
    expect(screen.getByRole("link", { name: "Download OpenBot" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("does not create an app link for an invalid invitation", async () => {
    window.history.replaceState({}, "", "/join?invite=bad");
    render(() => <JoinPage />);

    expect(await screen.findByText("This invitation link is invalid or incomplete.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open OpenBot" })).not.toBeInTheDocument();
  });
});
