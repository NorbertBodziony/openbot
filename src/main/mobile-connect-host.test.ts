import { describe, expect, it, vi } from "vitest";

import { createHostedMobileConnect } from "./mobile-connect-host";

describe("createHostedMobileConnect", () => {
  it("creates and starts a local server before issuing the pairing code", async () => {
    const operations: string[] = [];
    const ticket = { qrData: "openbot://mobile-connect?ticket=test", expiresAt: Date.now() + 60_000 };

    await expect(
      createHostedMobileConnect({
        centralAuth: {
          createMobileConnect: async () => {
            operations.push("ticket");
            return ticket;
          },
        },
        host: {
          getStatus: () => ({ configured: false }),
          configure: async () => {
            operations.push("configure");
            return { configured: true };
          },
          start: async () => {
            operations.push("start");
            return {
              apiOnline: true,
              apiUrl: "wss://signal.openbot.run/v1/signal",
              message: null,
              phase: "online" as const,
            };
          },
        },
      }),
    ).resolves.toEqual(ticket);
    expect(operations).toEqual(["configure", "start", "ticket"]);
  });

  it("preserves the existing server identity", async () => {
    const operations: string[] = [];

    await createHostedMobileConnect({
      centralAuth: {
        createMobileConnect: async () => {
          operations.push("ticket");
          return { qrData: "openbot://mobile-connect?ticket=test", expiresAt: Date.now() + 60_000 };
        },
      },
      host: {
        getStatus: () => ({ configured: true }),
        configure: async () => {
          operations.push("configure");
          return { configured: true };
        },
        start: async () => {
          operations.push("start");
          return {
            apiOnline: true,
            apiUrl: "wss://signal.openbot.run/v1/signal",
            message: null,
            phase: "online" as const,
          };
        },
      },
    });

    expect(operations).toEqual(["start", "ticket"]);
  });

  it("does not issue a pairing code while only the local development API is online", async () => {
    const createMobileConnect = vi.fn();

    await expect(
      createHostedMobileConnect({
        centralAuth: { createMobileConnect },
        host: {
          getStatus: () => ({ configured: true }),
          configure: async () => ({ configured: true }),
          start: async () => ({
            apiOnline: true,
            apiUrl: "http://localhost:49231",
            message: "Local development host is ready.",
            phase: "online" as const,
          }),
        },
      }),
    ).rejects.toThrow("Local development host is ready.");
    expect(createMobileConnect).not.toHaveBeenCalled();
  });
});
