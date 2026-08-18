import { describe, expect, it } from "vitest";
import {
  createDevelopmentServiceSpec,
  parseDevelopmentTarget,
  projectRoot,
  servicesForTarget,
} from "./dev-services";

describe("development service runner", () => {
  it("runs all three services in a stable order", () => {
    expect(servicesForTarget("all")).toEqual(["api", "app", "host"]);
  });

  it("builds the API command without a shell command string", () => {
    const spec = createDevelopmentServiceSpec("api", {});
    expect(spec.executable).toBe(process.execPath);
    expect(spec.args).toEqual(["run", "--cwd", `${projectRoot}/apps/auth-api`, "dev"]);
  });

  it("isolates the app and host profiles, ports, and outputs", () => {
    const app = createDevelopmentServiceSpec("app", {});
    const host = createDevelopmentServiceSpec("host", {});

    expect(app.env.OPENBOT_DEV_PROFILE).toBe("app");
    expect(app.env.OPENBOT_DEV_RENDERER_PORT).toBe("5173");
    expect(app.args).toContain("out-dev-app");
    expect(host.env.OPENBOT_DEV_PROFILE).toBe("host");
    expect(host.env.OPENBOT_DEV_RENDERER_PORT).toBe("5174");
    expect(host.env.OPENBOT_DEV_HOST_AUTO_START).toBe("1");
    expect(host.args).toContain("out-dev-host");
  });

  it("rejects unknown targets and options", () => {
    expect(() => parseDevelopmentTarget(["other"])).toThrow("Unknown development target");
    expect(() => parseDevelopmentTarget(["all", "--watch"])).toThrow("Unknown option");
  });
});
