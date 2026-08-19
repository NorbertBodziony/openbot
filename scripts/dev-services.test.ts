import { describe, expect, it } from "vitest";
import { createDevelopmentServiceSpec, parseDevelopmentTarget, projectRoot, servicesForTarget } from "./dev-services";

describe("development service runner", () => {
  it("runs the normal API and app in a stable order", () => {
    expect(servicesForTarget("all")).toEqual(["api", "app"]);
    expect(servicesForTarget("app")).toEqual(["api", "app"]);
  });

  it("starts a complete isolated two-client harness on demand", () => {
    expect(servicesForTarget("test-client")).toEqual(["api", "app", "test-client"]);
    expect(servicesForTarget("api")).toEqual(["api"]);
  });

  it("builds the API command without a shell command string", () => {
    const spec = createDevelopmentServiceSpec("api", {});
    expect(spec.executable).toBe(process.execPath);
    expect(spec.args).toEqual(["run", "--cwd", `${projectRoot}/apps/auth-api`, "dev"]);
  });

  it("isolates the app and test-client profiles, ports, and outputs", () => {
    const app = createDevelopmentServiceSpec("app", {});
    const testClient = createDevelopmentServiceSpec("test-client", {});

    expect(app.env.OPENBOT_APP_VARIANT).toBe("dev");
    expect(app.env.OPENBOT_DEV_PROFILE).toBe("app");
    expect(app.env.OPENBOT_DEV_RENDERER_PORT).toBe("5173");
    expect(app.args).toContain("out-dev-app");
    expect(testClient.env.OPENBOT_APP_VARIANT).toBe("dev");
    expect(testClient.env.OPENBOT_DEV_PROFILE).toBe("test-client");
    expect(testClient.env.OPENBOT_DEV_RENDERER_PORT).toBe("5174");
    expect(testClient.env.OPENBOT_DEV_HOST_AUTO_START).toBeUndefined();
    expect(testClient.args).toContain("out-dev-test-client");
  });

  it("rejects unknown targets and options", () => {
    expect(() => parseDevelopmentTarget(["other"])).toThrow("Unknown development target");
    expect(() => parseDevelopmentTarget(["all", "--watch"])).toThrow("Unknown option");
  });
});
