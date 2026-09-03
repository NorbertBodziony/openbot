import { render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import { createSimpleContext } from "./simple-context";

describe("createSimpleContext", () => {
  it("initializes a domain once per provider mount, however many consumers read it", () => {
    const init = vi.fn(() => ({ label: () => "ready" })).mockName("domain init");
    const Domain = createSimpleContext({ name: "Test domain", init });
    function Reader() {
      const domain = Domain.use();
      return <output aria-label="reader">{domain.label()}</output>;
    }

    render(() => (
      <Domain.provider>
        <Reader />
        <Reader />
        <Reader />
      </Domain.provider>
    ));

    expect(screen.getAllByRole("status", { name: "reader" })).toHaveLength(3);
    expect(init).toHaveBeenCalledOnce();
  });

  it("keeps a domain initialized when a consumer subtree remounts", async () => {
    const init = vi.fn(() => ({ label: () => "ready" })).mockName("domain init");
    const Domain = createSimpleContext({ name: "Test domain", init });
    const [visible, setVisible] = createSignal(true);
    function Reader() {
      const domain = Domain.use();
      return <output aria-label="reader">{domain.label()}</output>;
    }

    render(() => (
      <Domain.provider>
        <Show when={visible()}>
          <Reader />
        </Show>
      </Domain.provider>
    ));
    await screen.findByRole("status", { name: "reader" });

    setVisible(false);
    await waitFor(() => expect(screen.queryByRole("status", { name: "reader" })).not.toBeInTheDocument());
    setVisible(true);
    await screen.findByRole("status", { name: "reader" });

    expect(init).toHaveBeenCalledOnce();
  });

  it("names the missing provider when a consumer reads the domain from outside it", () => {
    const Domain = createSimpleContext({ name: "Test domain", init: () => ({ label: () => "ready" }) });
    function Orphan() {
      const domain = Domain.use();
      return <output aria-label="orphan">{domain.label()}</output>;
    }

    expect(() => render(() => <Orphan />)).toThrow("Test domain is unavailable outside its provider.");
  });

  it("runs no consumer until a gated domain reports ready", async () => {
    const [loaded, setLoaded] = createSignal(false);
    const Domain = createSimpleContext({
      name: "Test domain",
      init: () => ({ label: () => "ready" }),
      ready: () => loaded(),
    });
    // A consumer, not a plain child: the point of the gate is that nothing
    // below it reads the domain early, and only a consumer can do that.
    const readDomain = vi.fn(Domain.use).mockName("gated consumer");
    function Reader() {
      return <output aria-label="reader">{readDomain().label()}</output>;
    }

    render(() => (
      <Domain.provider>
        <Reader />
      </Domain.provider>
    ));
    expect(readDomain).not.toHaveBeenCalled();

    setLoaded(true);
    await waitFor(() => expect(readDomain).toHaveBeenCalledOnce());
  });

  it("runs consumers of an ungated domain immediately, leaving readiness to them", async () => {
    const Domain = createSimpleContext({ name: "Test domain", init: () => ({ loaded: () => false }) });
    const readDomain = vi.fn(Domain.use).mockName("ungated consumer");
    function Reader() {
      return <output aria-label="reader">{String(readDomain().loaded())}</output>;
    }

    render(() => (
      <Domain.provider>
        <Reader />
      </Domain.provider>
    ));

    expect(readDomain).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status", { name: "reader" })).toHaveTextContent("false");
  });
});
