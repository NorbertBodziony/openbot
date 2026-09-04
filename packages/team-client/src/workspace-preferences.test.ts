import { describe, expect, it } from "vitest";
import { createWorkspacePreferences } from "./workspace-preferences";

// Persistence boundary: a remounted provider must restore visibility, without
// leaking one account/server's preferences into another workspace.
describe("remote workspace preferences", () => {
  it("restores hidden and pinned chats after restart and keeps scopes independent", () => {
    const values = new Map<string, string>();
    const storage = {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const open = (api = "https://api.example.test", user = "alice") => createWorkspacePreferences(api, user, storage);
    open().write("host-a", { hidden: ["hidden-chat"], pinned: ["pinned-chat"] });
    expect(open().read("host-a")).toEqual({ hidden: ["hidden-chat"], pinned: ["pinned-chat"] });
    expect(open().read("host-b")).toEqual({ hidden: [], pinned: [] });
    expect(open(undefined, "bob").read("host-a")).toEqual({ hidden: [], pinned: [] });
    expect(open("https://other.example.test").read("host-a")).toEqual({ hidden: [], pinned: [] });
    open().write("host-a", { hidden: [], pinned: [] });
    expect(open().read("host-a")).toEqual({ hidden: [], pinned: [] });
  });

  it("reports unreadable preferences and failed writes instead of silently resetting them", () => {
    const preferences = createWorkspacePreferences("https://api.example.test", "alice", {
      get: () => '{"version":1,"hidden":[42],"pinned":[]}',
      set: () => {
        throw new Error("Storage full");
      },
    });
    expect(() => preferences.read("host")).toThrow("The saved chat preferences could not be read.");
    expect(() => preferences.write("host", { hidden: [], pinned: [] })).toThrow("Storage full");
  });
});
