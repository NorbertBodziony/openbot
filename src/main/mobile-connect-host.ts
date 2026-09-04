import type { MobileConnectHostBinding, MobileConnectTicket } from "@openbot/contracts/mobile-connect";
import type { CentralAuthManager } from "./central-auth-manager";

interface MobileConnectHostDependencies {
  centralAuth: Pick<CentralAuthManager, "createMobileConnect">;
  host: {
    configure(input: { serverName: string }): Promise<unknown>;
    getStatus(): { configured: boolean };
    getMobileConnectHost(): MobileConnectHostBinding | null;
    start(): Promise<{
      serverId: string | null;
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
  const binding = host.getMobileConnectHost();
  if (!binding || binding.hostId !== status.serverId) throw new Error("The Mobile Connect host changed. Try again.");
  return centralAuth.createMobileConnect(binding);
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
