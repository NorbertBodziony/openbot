// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseAgentRequest,
  parseApprovalResponse,
  parseCancelQueuedMessage,
  parseChooseAttachments,
  parseCreateBot,
  parseImportAttachments,
  parseInterrupt,
  parseMarkConversationRead,
  parseMessageReaction,
  parseOpenAttachment,
  parseOpenSharedFile,
  parseOpenWorkspaceFile,
  parsePromptResponse,
  parseReorderQueue,
  parseSendMessage,
  parseSteerQueuedMessage,
  parseUpdateBot,
  parseUpdateQueuedMessage,
} from "./agent-inputs";
import { parseMacPermission, parseProvider } from "./app-inputs";
import { parseBrowserOpen, parseVisibility } from "./browser-inputs";
import {
  parseCreateTeamInvite,
  parseHostConfig,
  parseJoinServer,
  parseLoginServer,
  parseMarkDirectRead,
  parseReorderServers,
  parseUpdateTeamMember,
} from "./server-inputs";
import { requireString } from "./validation";
import { parseVoiceTranscription } from "./voice-inputs";

describe("app IPC input parsing", () => {
  it("parses setup and permission values", () => {
    expect(parseProvider({ preferredProvider: "codex" })).toBe("codex");
    expect(parseProvider({ preferredProvider: "claude" })).toBe("claude");
    expect(parseMacPermission("screen-recording")).toBe("screen-recording");
    expect(parseMacPermission("accessibility")).toBe("accessibility");
  });

  it("keeps setup and permission error messages", () => {
    expect(() => parseProvider(null)).toThrowError("Setup input is required.");
    expect(() => parseProvider({ preferredProvider: "other" })).toThrowError("Unknown provider.");
    expect(() => parseMacPermission("camera")).toThrowError("Unknown macOS permission.");
  });
});

describe("voice IPC input parsing", () => {
  it("accepts canonical 16 kHz mono PCM WAV audio", () => {
    const audio = voiceWav(8);
    expect(parseVoiceTranscription({ audio })).toEqual({ audio });
  });

  it("rejects malformed and oversized voice audio", () => {
    expect(() => parseVoiceTranscription({ audio: new Uint8Array(44) })).toThrowError(
      "Voice audio must be a 16 kHz mono PCM WAV file.",
    );
    const wrongRate = voiceWav(8);
    new DataView(wrongRate.buffer).setUint32(24, 44_100, true);
    expect(() => parseVoiceTranscription({ audio: wrongRate })).toThrowError(
      "Voice audio must be a 16 kHz mono PCM WAV file.",
    );
    expect(() => parseVoiceTranscription({ audio: new Uint8Array(3_840_045) })).toThrowError(
      "Voice audio has an invalid length.",
    );
  });
});

function voiceWav(sampleBytes: number): Uint8Array {
  const audio = new Uint8Array(44 + sampleBytes);
  const view = new DataView(audio.buffer);
  audio.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, audio.byteLength - 8, true);
  audio.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  audio.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, sampleBytes, true);
  return audio;
}

describe("server IPC input parsing", () => {
  it("parses host and connection values", () => {
    expect(parseHostConfig({ serverName: "My server" })).toEqual({ serverName: "My server" });
    expect(parseJoinServer({ inviteUrl: "https://openbot.run/invite" })).toEqual({
      inviteUrl: "https://openbot.run/invite",
    });
    expect(parseLoginServer({ serverId: "server-1" })).toEqual({ serverId: "server-1" });
    expect(parseReorderServers({ serverIds: ["server-2", "server-1"] })).toEqual({
      serverIds: ["server-2", "server-1"],
    });
    expect(parseMarkDirectRead({ memberId: "member-1", throughSequence: 42 })).toEqual({
      memberId: "member-1",
      throughSequence: 42,
    });
  });

  it("requires a six-character host name", () => {
    expect(() => parseHostConfig({ serverName: "short" })).toThrowError("at least 6 characters");
  });

  it("normalizes optional invitation and member fields", () => {
    expect(parseCreateTeamInvite({ role: "member", email: " user@example.com " })).toEqual({
      role: "member",
      email: "user@example.com",
    });
    expect(parseCreateTeamInvite({ role: "admin", email: " " })).toEqual({ role: "admin" });
    expect(parseUpdateTeamMember({ memberId: "member-1", disabled: false })).toEqual({
      memberId: "member-1",
      disabled: false,
    });
  });

  it("keeps server input error messages", () => {
    expect(() => parseHostConfig(null)).toThrowError("Host configuration is required.");
    expect(() => parseJoinServer(null)).toThrowError("Invitation details are required.");
    expect(() => parseLoginServer(null)).toThrowError("Login details are required.");
    expect(() => parseReorderServers({ serverIds: ["server-1", "server-1"] })).toThrowError("Duplicate server ids.");
    expect(() => parseCreateTeamInvite({ role: "owner" })).toThrowError("Unknown team role.");
    expect(() => parseUpdateTeamMember({ memberId: "member-1", disabled: "no" })).toThrowError(
      "Invalid team member state.",
    );
    expect(() => parseMarkDirectRead({ memberId: "member-1", throughSequence: -1 })).toThrowError(
      "Invalid direct-message read boundary.",
    );
  });
});

describe("agent IPC input parsing", () => {
  it("parses scoped requests and message actions", () => {
    expect(parseAgentRequest({ serverId: "local", payload: { botId: "bot-1" } })).toEqual({
      serverId: "local",
      payload: { botId: "bot-1" },
    });
    expect(parseSendMessage({ botId: "bot-1", text: "Hello" })).toEqual({
      botId: "bot-1",
      text: "Hello",
      attachmentDraftIds: [],
      replyToMessageId: null,
    });
    expect(parseMessageReaction({ botId: "bot-1", messageId: "message-1", emoji: "👍" })).toEqual({
      botId: "bot-1",
      messageId: "message-1",
      emoji: "👍",
    });
    expect(parseInterrupt({ botId: "bot-1", turnId: "turn-1" })).toEqual({
      botId: "bot-1",
      turnId: "turn-1",
    });
    expect(parseMarkConversationRead({ botId: "bot-1", throughMessageId: "message-1" })).toEqual({
      botId: "bot-1",
      throughMessageId: "message-1",
    });
  });

  it("parses bot, attachment, queue, and prompt values", () => {
    expect(
      parseCreateBot({
        name: "Trip Planner",
        description: "Builds practical itineraries.",
        avatarSeed: "setup:trip",
        avatarHue: 215,
        initialMessage: "Help me plan a trip.",
      }),
    ).toEqual({
      name: "Trip Planner",
      description: "Builds practical itineraries.",
      avatarSeed: "setup:trip",
      avatarHue: 215,
      initialMessage: "Help me plan a trip.",
    });
    expect(parseUpdateBot({ botId: "bot-1", name: "Ada", title: "Coordinator", notifications: true })).toEqual({
      botId: "bot-1",
      name: "Ada",
      title: "Coordinator",
      notifications: true,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      parseImportAttachments({
        paths: ["/tmp/readme.md"],
        data: [{ name: "image.png", mimeType: "image/png", bytes }],
      }),
    ).toEqual({
      paths: ["/tmp/readme.md"],
      data: [{ name: "image.png", mimeType: "image/png", bytes }],
    });
    expect(parseChooseAttachments({ filter: "all" })).toEqual({ filter: "all" });
    expect(parseChooseAttachments({ filter: "images" })).toEqual({ filter: "images" });
    expect(parseOpenAttachment({ attachmentId: "attachment-1", action: "reveal" })).toEqual({
      attachmentId: "attachment-1",
      action: "reveal",
    });
    expect(parseOpenAttachment({ attachmentId: "attachment-1", action: "download" })).toEqual({
      attachmentId: "attachment-1",
      action: "download",
    });
    expect(parseOpenSharedFile({ path: "~/OpenBot/Shared/report.csv" })).toEqual({
      path: "~/OpenBot/Shared/report.csv",
    });
    expect(parseOpenWorkspaceFile({ botId: "bot-1", path: "app/page.tsx" })).toEqual({
      botId: "bot-1",
      path: "app/page.tsx",
    });
    expect(parseCancelQueuedMessage({ botId: "bot-1", deliveryId: "delivery-1" })).toEqual({
      botId: "bot-1",
      deliveryId: "delivery-1",
    });
    expect(
      parseSteerQueuedMessage({
        botId: "bot-1",
        deliveryId: "delivery-1",
        expectedTurnId: "turn-1",
      }),
    ).toEqual({ botId: "bot-1", deliveryId: "delivery-1", expectedTurnId: "turn-1" });
    expect(
      parseUpdateQueuedMessage({
        botId: "bot-1",
        deliveryId: "delivery-1",
        text: "Edited",
        keepAttachmentIds: ["attachment-1"],
        attachmentDraftIds: ["draft-1"],
      }),
    ).toEqual({
      botId: "bot-1",
      deliveryId: "delivery-1",
      text: "Edited",
      keepAttachmentIds: ["attachment-1"],
      attachmentDraftIds: ["draft-1"],
    });
    expect(parseReorderQueue({ botId: "bot-1", deliveryIds: ["delivery-2", "delivery-1"] })).toEqual({
      botId: "bot-1",
      deliveryIds: ["delivery-2", "delivery-1"],
    });
    expect(parsePromptResponse({ requestId: 7, answers: { question: ["answer"] } })).toEqual({
      requestId: 7,
      answers: { question: ["answer"] },
    });
    expect(parseApprovalResponse({ requestId: "approval-1", decision: "accept" })).toEqual({
      requestId: "approval-1",
      decision: "accept",
    });
  });

  it("keeps agent input error messages", () => {
    expect(() =>
      parseCreateBot({
        name: " ",
        description: "Builds practical itineraries.",
        avatarSeed: "setup:trip",
        avatarHue: 215,
        initialMessage: "Help me plan a trip.",
      }),
    ).toThrowError("name is required.");
    expect(() =>
      parseCreateBot({
        name: "Trip Planner",
        description: "Builds practical itineraries.",
        avatarSeed: "setup:trip",
        avatarHue: 215,
        initialMessage: " ",
      }),
    ).toThrowError("initialMessage is required.");
    expect(() => parseUpdateBot({ botId: "bot-1", role: "Coordinator" })).toThrowError("Invalid role.");
    expect(() => parseAgentRequest(null)).toThrowError("Invalid agent request.");
    expect(() => parseSendMessage({ botId: "bot-1", text: " " })).toThrowError("A message or attachment is required.");
    expect(() => parseMessageReaction({ botId: "bot-1", messageId: "message-1", emoji: "invalid" })).toThrowError(
      "Invalid message reaction.",
    );
    expect(() => parseUpdateBot({ botId: "bot-1", notifications: "yes" })).toThrowError("Invalid notifications value.");
    expect(() => parseImportAttachments({ paths: [""], data: [] })).toThrowError("Invalid attachment path.");
    expect(() => parseChooseAttachments({ filter: "documents" })).toThrowError("Invalid attachment picker filter.");
    expect(() => parseOpenAttachment({ attachmentId: "attachment-1", action: "delete" })).toThrowError(
      "Invalid attachment action.",
    );
    expect(() => parseOpenSharedFile({ path: "" })).toThrowError("path is required.");
    expect(() => parseOpenWorkspaceFile({ botId: "bot-1", path: "" })).toThrowError("path is required.");
    expect(() => parseCancelQueuedMessage(null)).toThrowError("Invalid queue cancellation request.");
    expect(() => parseSteerQueuedMessage(null)).toThrowError("Invalid queued steer request.");
    expect(() =>
      parseUpdateQueuedMessage({
        botId: "bot-1",
        deliveryId: "delivery-1",
        text: " ",
        keepAttachmentIds: [],
        attachmentDraftIds: [],
      }),
    ).toThrowError("A message or attachment is required.");
    expect(() => parseReorderQueue({ botId: "bot-1", deliveryIds: ["delivery-1", "delivery-1"] })).toThrowError(
      "Duplicate delivery ids.",
    );
    expect(() => parseInterrupt(null)).toThrowError("Invalid interrupt request.");
    expect(() => parseMarkConversationRead({ botId: "bot-1", throughMessageId: 1 })).toThrowError(
      "Invalid conversation read boundary.",
    );
    expect(() => parsePromptResponse({ requestId: 1, answers: null })).toThrowError("Prompt answers are required.");
    expect(() => parseApprovalResponse({ requestId: "approval-1", decision: "maybe" })).toThrowError(
      "Invalid approval decision.",
    );
    expect(() => parseApprovalResponse({ requestId: 1.5, decision: "accept" })).toThrowError(
      "Invalid approval response.",
    );
  });
});

describe("browser IPC input parsing", () => {
  it("parses URLs, owners, visibility, and bounds", () => {
    expect(parseBrowserOpen({ url: "https://example.com", ownerThreadId: "thread-1" })).toEqual({
      url: "https://example.com",
      ownerThreadId: "thread-1",
      ownerBotId: null,
    });
    expect(parseVisibility({ visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({
      visible: true,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
  });

  it("keeps browser input error messages", () => {
    expect(() => parseBrowserOpen(null)).toThrowError("Invalid browser open request.");
    expect(() => parseVisibility({ visible: "yes" })).toThrowError("Invalid browser visibility request.");
    expect(() => parseVisibility({ visible: true, bounds: { x: 1, y: 2, width: Number.NaN, height: 4 } })).toThrowError(
      "Invalid browser bound: width.",
    );
  });
});

describe("shared IPC validation", () => {
  it("keeps required and length error messages", () => {
    expect(() => requireString(" ", "field")).toThrowError("field is required.");
    expect(() => requireString("long", "field", 3)).toThrowError("field is too long.");
    expect(requireString(" value ", "field")).toBe(" value ");
  });
});
