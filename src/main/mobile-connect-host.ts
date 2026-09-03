import type { MobileConnectTicket } from "@openbot/contracts/mobile-connect";
import type { CentralAuthManager } from "./central-auth-manager";

interface MobileConnectHostDependencies {
  centralAuth: Pick<CentralAuthManager, "createMobileConnect">;
  host: {
    configure(input: { serverName: string }): Promise<unknown>;
    getStatus(): { configured: boolean };
    start(): Promise<{
      phase: string;
      apiOnline: boolean;
      apiUrl: string | null;
      message: string | null;
    }>;
  };
}

export async function createHostedMobileConnect({
  centralAuth,
  host,
}: MobileConnectHostDependencies): Promise<MobileConnectTicket> {
  if (!host.getStatus().configured) await host.configure({ serverName: "OpenBot" });
  const status = await host.start();
  if (!isPublishedHost(status)) {
    throw new Error(status.message ?? "This OpenBot could not be published for Mobile Connect.");
  }
  return centralAuth.createMobileConnect();
}

function isPublishedHost(status: { phase: string; apiOnline: boolean; apiUrl: string | null }): boolean {
  if (status.phase !== "online" || !status.apiOnline || !status.apiUrl) return false;
  try {
    const protocol = new URL(status.apiUrl).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}
