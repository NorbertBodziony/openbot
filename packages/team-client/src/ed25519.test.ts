import { afterEach, describe, expect, it, vi } from "vitest";

import { createEd25519Identity, signEd25519, verifyEd25519Pem } from "./ed25519";

const SECRET_KEY = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=
-----END PUBLIC KEY-----`;
const EMPTY_MESSAGE_SIGNATURE = hexToBytes(
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
);

describe("portable Ed25519 identities", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates the RFC 8032 identity and signature used by the desktop protocol", async () => {
    const identity = await createEd25519Identity((size) => {
      expect(size).toBe(32);
      return SECRET_KEY;
    });

    expect(identity.publicKeyPem).toBe(PUBLIC_KEY_PEM);
    await expect(signEd25519(new Uint8Array(), identity.secretKey)).resolves.toEqual(EMPTY_MESSAGE_SIGNATURE);
  });

  it("creates, signs, and verifies an identity when Expo DOM does not expose Web Crypto", async () => {
    vi.stubGlobal("crypto", undefined);

    const identity = await createEd25519Identity(() => SECRET_KEY);

    expect(identity.publicKeyPem).toBe(PUBLIC_KEY_PEM);
    await expect(signEd25519(new Uint8Array(), identity.secretKey)).resolves.toEqual(EMPTY_MESSAGE_SIGNATURE);
    await expect(verifyEd25519Pem(EMPTY_MESSAGE_SIGNATURE, new Uint8Array(), identity.publicKeyPem)).resolves.toBe(
      true,
    );
  });

  it("accepts a standard signature and rejects a changed transcript", async () => {
    await expect(verifyEd25519Pem(EMPTY_MESSAGE_SIGNATURE, new Uint8Array(), PUBLIC_KEY_PEM)).resolves.toBe(true);
    await expect(
      verifyEd25519Pem(EMPTY_MESSAGE_SIGNATURE, new TextEncoder().encode("changed transcript"), PUBLIC_KEY_PEM),
    ).resolves.toBe(false);
  });

  it("rejects a key that is not an Ed25519 SPKI public key", async () => {
    await expect(verifyEd25519Pem(new Uint8Array(64), new Uint8Array(), "not a public key")).rejects.toThrow(
      "invalid Ed25519 public key",
    );
  });
});

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
