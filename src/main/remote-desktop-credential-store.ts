import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

interface CredentialCipher {
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
}

interface StoredRemoteDesktopCredential {
  version: 1;
  encryptedPassword: string;
}

export class RemoteDesktopCredentialStore {
  readonly #path: string;
  readonly #cipher: CredentialCipher;
  #password: string | null = null;

  constructor(path: string, cipher: CredentialCipher) {
    this.#path = path;
    this.#cipher = cipher;
  }

  async initialize(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#path, "utf8"));
      if (
        !isDynamicRecord(value) ||
        !isNumber(value.version) ||
        value.version !== 1 ||
        !isString(value.encryptedPassword)
      ) {
        throw new Error("The Remote Desktop credential file is invalid.");
      }
      const password = this.#cipher.decrypt(Buffer.from(value.encryptedPassword, "base64"));
      validateRemoteDesktopPassword(password);
      this.#password = password;
      await chmod(this.#path, 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  get configured(): boolean {
    return this.#password !== null;
  }

  getPassword(): string | null {
    return this.#password;
  }

  async setPassword(password: string): Promise<void> {
    validateRemoteDesktopPassword(password);
    const stored: StoredRemoteDesktopCredential = {
      version: 1,
      encryptedPassword: this.#cipher.encrypt(password).toString("base64"),
    };
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
    this.#password = password;
  }
}

export function validateRemoteDesktopPassword(password: string): void {
  if (
    password.length < 1 ||
    password.length > INPUT_LIMITS.remoteDesktopPassword ||
    [...password].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error(
      `The dedicated VNC password must contain 1 to ${INPUT_LIMITS.remoteDesktopPassword} printable characters.`,
    );
  }
}
