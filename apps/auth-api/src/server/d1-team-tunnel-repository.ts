import type { TeamTunnelRecord, TeamTunnelRepository } from "./team-tunnel-service";

interface TeamTunnelRow {
  server_id: string;
  user_id: string;
  tunnel_id: string | null;
  tunnel_name: string;
  api_hostname: string;
  vnc_hostname: string;
  status: "provisioning" | "active";
}

export class D1TeamTunnelRepository implements TeamTunnelRepository {
  constructor(private readonly database: D1Database) {}

  async claim(
    input: Omit<TeamTunnelRecord, "tunnelId" | "status"> & { now: number },
  ): Promise<TeamTunnelRecord> {
    await this.database
      .prepare(
        `INSERT OR IGNORE INTO team_tunnels(
          server_id, user_id, tunnel_name, api_hostname, vnc_hostname, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?)`,
      )
      .bind(
        input.serverId,
        input.userId,
        input.tunnelName,
        input.apiHostname,
        input.vncHostname,
        input.now,
        input.now,
      )
      .run();
    const row = await this.database
      .prepare(
        `SELECT server_id, user_id, tunnel_id, tunnel_name, api_hostname, vnc_hostname, status
         FROM team_tunnels
         WHERE server_id = ? OR user_id = ?
         ORDER BY CASE WHEN server_id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .bind(input.serverId, input.userId, input.serverId)
      .first<TeamTunnelRow>();
    if (!row) throw new Error("The team tunnel claim could not be stored.");
    return mapRow(row);
  }

  async setTunnelId(serverId: string, tunnelId: string, now: number): Promise<void> {
    const result = await this.database
      .prepare("UPDATE team_tunnels SET tunnel_id = ?, updated_at = ? WHERE server_id = ?")
      .bind(tunnelId, now, serverId)
      .run();
    if (result.meta.changes !== 1) throw new Error("The team tunnel ID could not be stored.");
  }

  async markActive(serverId: string, now: number): Promise<void> {
    const result = await this.database
      .prepare("UPDATE team_tunnels SET status = 'active', updated_at = ? WHERE server_id = ?")
      .bind(now, serverId)
      .run();
    if (result.meta.changes !== 1) throw new Error("The team tunnel state could not be stored.");
  }

  async find(serverId: string): Promise<TeamTunnelRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT server_id, user_id, tunnel_id, tunnel_name, api_hostname, vnc_hostname, status
         FROM team_tunnels WHERE server_id = ?`,
      )
      .bind(serverId)
      .first<TeamTunnelRow>();
    return row ? mapRow(row) : null;
  }

  async delete(serverId: string): Promise<void> {
    await this.database
      .prepare("DELETE FROM team_tunnels WHERE server_id = ?")
      .bind(serverId)
      .run();
  }
}

function mapRow(row: TeamTunnelRow): TeamTunnelRecord {
  return {
    serverId: row.server_id,
    userId: row.user_id,
    tunnelId: row.tunnel_id,
    tunnelName: row.tunnel_name,
    apiHostname: row.api_hostname,
    vncHostname: row.vnc_hostname,
    status: row.status,
  };
}
