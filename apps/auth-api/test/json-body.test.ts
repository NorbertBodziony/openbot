import { describe, expect, it } from "vitest";
import { JSON_BODY_LIMIT, readJsonObject } from "../src/server/json-body";

describe("readJsonObject", () => {
  it("reads a JSON object within the request limit", async () => {
    const request = new Request("https://openbot.run/test", {
      method: "POST",
      body: JSON.stringify({ email: "owner@example.com" }),
    });

    await expect(readJsonObject(request)).resolves.toEqual({ email: "owner@example.com" });
  });

  it("rejects non-object JSON", async () => {
    const request = new Request("https://openbot.run/test", {
      method: "POST",
      body: "[]",
    });

    await expect(readJsonObject(request)).rejects.toMatchObject({
      status: 400,
      code: "invalid_json",
    });
  });

  it("rejects a streamed body above the request limit", async () => {
    const request = new Request("https://openbot.run/test", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(JSON_BODY_LIMIT) }),
    });

    await expect(readJsonObject(request)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
  });
});
