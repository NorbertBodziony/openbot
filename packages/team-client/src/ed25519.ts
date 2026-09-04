import { getPublicKeyAsync, hashes, signAsync, verifyAsync } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

hashes.sha512 = sha512;
hashes.sha512Async = async (message) => sha512(message);

const ED25519_SECRET_KEY_BYTES = 32;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const PUBLIC_KEY_HEADER = "-----BEGIN PUBLIC KEY-----";
const PUBLIC_KEY_FOOTER = "-----END PUBLIC KEY-----";

export interface Ed25519Identity {
  secretKey: Uint8Array;
  publicKeyPem: string;
}

export async function createEd25519Identity(randomBytes: (size: number) => Uint8Array): Promise<Ed25519Identity> {
  const generated = randomBytes(ED25519_SECRET_KEY_BYTES);
  if (generated.length !== ED25519_SECRET_KEY_BYTES) {
    throw new Error("The random source returned an invalid Ed25519 secret key.");
  }
  const secretKey = Uint8Array.from(generated);
  const publicKey = await getPublicKeyAsync(secretKey);
  return { secretKey, publicKeyPem: encodePublicKeyPem(publicKey) };
}

export async function signEd25519(message: Uint8Array, secretKey: Uint8Array): Promise<Uint8Array> {
  return signAsync(message, secretKey);
}

export async function verifyEd25519Pem(
  signature: Uint8Array,
  message: Uint8Array,
  publicKeyPem: string,
): Promise<boolean> {
  return verifyAsync(signature, message, decodePublicKeyPem(publicKeyPem), { zip215: false });
}

function encodePublicKeyPem(publicKey: Uint8Array): string {
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) throw new Error("The Ed25519 public key is invalid.");
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + publicKey.length);
  spki.set(ED25519_SPKI_PREFIX);
  spki.set(publicKey, ED25519_SPKI_PREFIX.length);
  const base64 = bytesToBase64(spki);
  const lines = base64.match(/.{1,64}/gu) ?? [base64];
  return `${PUBLIC_KEY_HEADER}\n${lines.join("\n")}\n${PUBLIC_KEY_FOOTER}`;
}

function decodePublicKeyPem(pem: string): Uint8Array {
  const trimmed = pem.trim();
  if (!trimmed.startsWith(PUBLIC_KEY_HEADER) || !trimmed.endsWith(PUBLIC_KEY_FOOTER)) {
    throw new Error("The server returned an invalid Ed25519 public key.");
  }
  const encoded = trimmed
    .slice(PUBLIC_KEY_HEADER.length, -PUBLIC_KEY_FOOTER.length)
    .replaceAll("\n", "")
    .replaceAll("\r", "")
    .replaceAll(" ", "")
    .trim();
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new Error("The server returned an invalid Ed25519 public key.");
  }
  let spki: Uint8Array;
  try {
    spki = base64ToBytes(encoded);
  } catch {
    throw new Error("The server returned an invalid Ed25519 public key.");
  }
  if (spki.length !== ED25519_SPKI_PREFIX.length + ED25519_PUBLIC_KEY_BYTES) {
    throw new Error("The server returned an invalid Ed25519 public key.");
  }
  for (let index = 0; index < ED25519_SPKI_PREFIX.length; index += 1) {
    if (spki[index] !== ED25519_SPKI_PREFIX[index]) {
      throw new Error("The server returned an invalid Ed25519 public key.");
    }
  }
  return spki.slice(ED25519_SPKI_PREFIX.length);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
