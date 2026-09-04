import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../apps/mobile", import.meta.url));

describe("mobile OTA compatibility", () => {
  it.each(["ios", "android"] as const)(
    "requires a fingerprinted %s binary instead of the old 1.0.0 runtime",
    (platform) => {
      // Resolve Expo from the app's dependency tree, as the native config tooling does.
      const runtime = execFileSync(
        "node",
        [
          "-e",
          `
        const { getConfig } = require('expo/config');
        const { Updates } = require('expo/config-plugins');
        const { exp } = getConfig(process.cwd(), { skipSDKVersionRequirement: true });
        Updates.getRuntimeVersionAsync(process.cwd(), exp, process.argv[1])
          .then(runtime => process.stdout.write(runtime ?? ''));
      `,
          platform,
        ],
        { cwd: projectRoot, encoding: "utf8" },
      );
      expect(runtime).toBe("file:fingerprint");
    },
  );
});
