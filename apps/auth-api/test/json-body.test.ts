import { describe, expect, it } from "vitest";
import { JSON_BODY_LIMIT, readJsonObject, readMultipartFormData } from "../src/server/json-body";

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

describe("readMultipartFormData", () => {
  it("parses a multipart request within the request limit", async () => {
    const form = new FormData();
    form.set("category", "productivity");
    form.set("bundle", new File(["bundle"], "skill.zip", { type: "application/zip" }));
    const request = new Request("https://openbot.run/v1/skills/", { method: "POST", body: form });

    const parsed = await readMultipartFormData(request, 4_096);

    expect(parsed.get("category")).toBe("productivity");
    expect(parsed.get("bundle")).toBeInstanceOf(File);
  });

  it("rejects multipart bodies above the request limit", async () => {
    const request = new Request("https://openbot.run/v1/skills/", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=test" },
      body: '--test\r\nContent-Disposition: form-data; name="value"\r\n\r\nlarge\r\n--test--\r\n',
    });

    await expect(readMultipartFormData(request, 8)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
  });
});
