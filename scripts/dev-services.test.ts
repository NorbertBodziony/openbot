import { describe, expect, it, vi } from "vitest";
import {
  configureMobileConnectDevelopmentNetwork,
  createDevelopmentServiceSpec,
  developmentEnvironmentForTarget,
  parseDevelopmentTarget,
  projectRoot,
  selectMobileConnectLanAddress,
  servicesForTarget,
  signalOwnedProcess,
  stopOwnedProcesses,
} from "./dev-services";

describe("development service runner", () => {
  it("runs the normal API and app in a stable order", () => {
    expect(servicesForTarget("all")).toEqual(["api", "app"]);
    expect(servicesForTarget("app")).toEqual(["api", "app"]);
  });

  it("starts a complete isolated two-client harness on demand", () => {
    expect(servicesForTarget("test-client")).toEqual(["api", "app", "test-client"]);
    expect(servicesForTarget("api")).toEqual(["api"]);
  });

  it("provisions the technical remote member only for the test-client harness", () => {
    expect(developmentEnvironmentForTarget("app", {}).OPENBOT_DEV_TEST_CLIENT_ENABLED).toBe("0");
    expect(developmentEnvironmentForTarget("test-client", {}).OPENBOT_DEV_TEST_CLIENT_ENABLED).toBe("1");
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

  it("keeps selected development ports in the child environment", () => {
    const api = createDevelopmentServiceSpec("api", { OPENBOT_API_PORT: "3110" });
    const app = createDevelopmentServiceSpec("app", {
      OPENBOT_API_PORT: "3110",
      OPENBOT_AUTH_API_URL: "http://127.0.0.1:3110",
      OPENBOT_DEV_RENDERER_PORT: "5180",
      OPENBOT_DEV_REMOTE_DEBUGGING_PORT: "9340",
    });

    expect(api.env.OPENBOT_API_PORT).toBe("3110");
    expect(app.env.OPENBOT_AUTH_API_URL).toBe("http://127.0.0.1:3110");
    expect(app.env.OPENBOT_DEV_RENDERER_PORT).toBe("5180");
    expect(app.env.OPENBOT_DEV_REMOTE_DEBUGGING_PORT).toBe("9340");
  });

  it("advertises the preferred private LAN address for Mobile Connect development", () => {
    const interfaces = {
      utun3: [{ address: "10.8.0.2", family: "IPv4" as const, internal: false }],
      en0: [{ address: "192.168.1.143", family: "IPv4" as const, internal: false }],
      lo0: [{ address: "127.0.0.1", family: "IPv4" as const, internal: true }],
    };
    expect(selectMobileConnectLanAddress(interfaces)).toBe("192.168.1.143");
    const environment = { OPENBOT_API_PORT: "3100", OPENBOT_AUTH_API_URL: "http://127.0.0.1:3100" };

    configureMobileConnectDevelopmentNetwork(["api", "app"], environment, interfaces);

    expect(environment).toMatchObject({
      OPENBOT_API_HOST: "0.0.0.0",
      OPENBOT_MOBILE_AUTH_API_URL: "http://192.168.1.143:3100",
    });
  });

  it("keeps API-only and explicitly loopback development private", () => {
    const interfaces = {
      en0: [{ address: "192.168.1.143", family: "IPv4" as const, internal: false }],
    };
    const apiOnly = { OPENBOT_API_PORT: "3100" };
    configureMobileConnectDevelopmentNetwork(["api"], apiOnly, interfaces);
    expect(apiOnly).not.toHaveProperty("OPENBOT_API_HOST");

    const loopback = { OPENBOT_API_PORT: "3100", OPENBOT_API_HOST: "127.0.0.1" };
    configureMobileConnectDevelopmentNetwork(["api", "app"], loopback, interfaces);
    expect(loopback).not.toHaveProperty("OPENBOT_MOBILE_AUTH_API_URL");
  });

  it("keeps an explicit development remote role override", () => {
    const app = createDevelopmentServiceSpec("app", { OPENBOT_DEV_REMOTE_ROLE: "none" });

    expect(app.env.OPENBOT_DEV_REMOTE_ROLE).toBe("none");
  });

  it("rejects unknown targets and options", () => {
    expect(() => parseDevelopmentTarget(["other"])).toThrow("Unknown development target");
    expect(() => parseDevelopmentTarget(["all", "--watch"])).toThrow("Unknown option");
  });

  it("signals a detached POSIX process group after its launcher exits", () => {
    const kill = vi.fn<typeof process.kill>(() => true);
    const child = { pid: 321, exitCode: 0, kill: vi.fn(() => true) };

    signalOwnedProcess(child, "SIGTERM", "darwin", kill);

    expect(kill).toHaveBeenCalledWith(-321, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("gives a surviving POSIX process group time to exit cleanly", async () => {
    let time = 0;
    let probes = 0;
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        probes += 1;
        if (probes > 2) throw Object.assign(new Error("missing process"), { code: "ESRCH" });
      }
      return true;
    });
    const child = { pid: 321, exitCode: 0, kill: vi.fn(() => true) };

    await stopOwnedProcesses([child], "SIGTERM", {
      platform: "darwin",
      killProcess: kill,
      timeoutMs: 100,
      pollIntervalMs: 25,
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(kill).toHaveBeenCalledWith(-321, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-321, "SIGKILL");
    expect(time).toBe(50);
  });

  it("escalates only after a surviving process group misses the deadline", async () => {
    let time = 0;
    const kill = vi.fn(() => true);
    const child = { pid: 321, exitCode: 0, kill: vi.fn(() => true) };

    await stopOwnedProcesses([child], "SIGTERM", {
      platform: "darwin",
      killProcess: kill,
      timeoutMs: 100,
      pollIntervalMs: 25,
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(time).toBe(100);
    expect(kill).toHaveBeenCalledWith(-321, "SIGKILL");
  });
});
