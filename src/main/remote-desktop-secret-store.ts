import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const storedSecretSchema = z.object({ version: z.literal(1), value: z.string() });
const runtimeCredentialsSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

interface SecretCipher {
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
}

export async function loadOrCreateRemoteDesktopCredentials(
  path: string,
  cipher: SecretCipher,
): Promise<{ username: string; password: string }> {
  try {
    const stored = storedSecretSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return runtimeCredentialsSchema.parse(JSON.parse(cipher.decrypt(Buffer.from(stored.value, "base64"))));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const credentials = { username: "openbot", password: randomBytes(32).toString("base64url") };
  const encrypted = cipher.encrypt(JSON.stringify(credentials));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ version: 1, value: encrypted.toString("base64") })}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return credentials;
}
