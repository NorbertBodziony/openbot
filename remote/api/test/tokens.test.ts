import { createHmac, generateKeyPairSync } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { RESUME_TTL_SECONDS, RemoteTokenService, verifyWebhookSignature } from "../src/tokens";

const secret = "s".repeat(32);

describe("remote tokens", () => {
  it("verifies ES256 tickets and creates coturn credentials", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "ES256";
    const now = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({
      sessionId: "session-1",
      hostId: "host-1",
      userId: "user-1",
      membershipId: "member-1",
      role: "member",
      authEpoch: 1,
      protocolMinimum: 2,
      protocolMaximum: 2,
      sessionExpiresAt: now + 24 * 60 * 60,
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setAudience("openbot-remote")
      .setJti("ticket-1")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    let remoteValidations = 0;
    const service = new RemoteTokenService(
      {
        ticketJwks: JSON.stringify({ keys: [jwk] }),
        ticketJwksUrl: null,
        sessionSecret: secret,
        turnSecret: "t".repeat(32),
        turnHost: "turn.example.com",
        turnPort: 3478,
        turnTlsPort: 5349,
      },
      async () => {
        remoteValidations += 1;
        return true;
      },
    );
    const claims = await service.verifyTicket(token);
    const servers = service.iceServers(claims, now);
    expect(claims.sessionId).toBe("session-1");
    expect(servers[1]).toMatchObject({ username: `${now + 3_600}:session-1` });
    expect(() => service.iceServers({ ...claims, sessionExpiresAt: now }, now)).toThrow("expired");
    const resume = await service.issueResumeToken(claims, now);
    expect((await service.verifyResumeToken(resume)).hostId).toBe("host-1");
    expect((await service.verifyResumeToken(resume, new Date((now + RESUME_TTL_SECONDS - 1) * 1_000))).sessionId).toBe(
      "session-1",
    );
    expect(remoteValidations).toBe(0);
    const restartedService = new RemoteTokenService(
      {
        ticketJwks: JSON.stringify({ keys: [jwk] }),
        ticketJwksUrl: null,
        sessionSecret: secret,
        turnSecret: "t".repeat(32),
        turnHost: "turn.example.com",
        turnPort: 3478,
        turnTlsPort: 5349,
      },
      async () => {
        remoteValidations += 1;
        return true;
      },
    );
    expect((await restartedService.verifyResumeToken(resume, new Date((now + 60) * 1_000))).sessionId).toBe(
      "session-1",
    );
    expect(remoteValidations).toBe(1);
    await restartedService.verifyResumeToken(resume, new Date((now + 61) * 1_000));
    expect(remoteValidations).toBe(1);
    expect((await service.verifyResumeToken(resume, new Date((now + RESUME_TTL_SECONDS + 1) * 1_000))).sessionId).toBe(
      "session-1",
    );
    expect(remoteValidations).toBe(2);
  });

  it("checks webhook timestamps and signatures", () => {
    const body = '{"type":"remote-auth-changed"}';
    const timestamp = "1000";
    const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
    expect(verifyWebhookSignature(body, timestamp, digest, secret, 1_000_000)).toBe(true);
    expect(verifyWebhookSignature(body, timestamp, "invalid", secret, 1_000_000)).toBe(false);
  });

  it("rejects expired logical sessions and unsupported protocol ranges", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "ES256";
    const service = new RemoteTokenService({
      ticketJwks: JSON.stringify({ keys: [jwk] }),
      ticketJwksUrl: null,
      sessionSecret: secret,
      turnSecret: "t".repeat(32),
      turnHost: "turn.example.com",
      turnPort: 3478,
      turnTlsPort: 5349,
    });
    const now = 1_900_000_000;
    const issue = (sessionExpiresAt: number, protocolMinimum = 2, protocolMaximum = 2) =>
      new SignJWT({
        sessionId: "session-1",
        hostId: "host-1",
        userId: "user-1",
        membershipId: "member-1",
        role: "member",
        authEpoch: 1,
        protocolMinimum,
        protocolMaximum,
        sessionExpiresAt,
      })
        .setProtectedHeader({ alg: "ES256", kid: "test-key" })
        .setAudience("openbot-remote")
        .setJti(crypto.randomUUID())
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);

    await expect(service.verifyTicket(await issue(now - 1), new Date(now * 1_000))).rejects.toThrow("expired");
    await expect(service.verifyTicket(await issue(now + 300, 3, 3), new Date(now * 1_000))).rejects.toThrow("protocol");
  });
});
