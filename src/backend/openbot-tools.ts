import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { ROUTINE_SCHEDULE_JSON_SCHEMA } from "./routine-tool-schema";

export const OPENBOT_DYNAMIC_TOOLS = {
  type: "namespace",
  name: "openbot",
  description: "Attach files to the current response and work with persistent OpenBot teammates.",
  tools: [
    {
      type: "function",
      name: "list_sites",
      description:
        "List static sites hosted by the signed-in OpenBot user. Use this before retrying a hosting mutation.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "publish_site",
      description:
        "Publish a new static site after the user explicitly asks to publish it. The source must be inside this bot's workspace or OpenBot Shared.",
      inputSchema: {
        type: "object",
        properties: {
          sourcePath: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.path },
          title: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", minLength: 1, maxLength: 500 },
          spaFallback: { type: "boolean" },
        },
        required: ["sourcePath", "title", "description"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "replace_site",
      description:
        "Replace an owned static site after the user explicitly asks to replace it. This keeps the URL and resets expiry to 30 days.",
      inputSchema: {
        type: "object",
        properties: {
          siteId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier },
          sourcePath: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.path },
          title: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", minLength: 1, maxLength: 500 },
          spaFallback: { type: "boolean" },
        },
        required: ["siteId", "sourcePath", "title", "description"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "delete_site",
      description: "Delete an owned static site after the user explicitly asks to delete it.",
      inputSchema: {
        type: "object",
        properties: { siteId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier } },
        required: ["siteId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "attach_files_to_response",
      description:
        "Attach existing local files to the current response for the user. Use this after creating screenshots, charts, diagrams, reports, or other files that the user should receive. OpenBot copies each file and shows image previews in the conversation.",
      inputSchema: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.path },
            minItems: 1,
            maxItems: INPUT_LIMITS.attachments,
          },
        },
        required: ["paths"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "list_agents",
      description: "List local OpenBot agents with their name, title, description, and current status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "update_profile",
      description: "Update the name, title, and/or description of a local OpenBot agent.",
      inputSchema: {
        type: "object",
        properties: {
          botId: { type: "string", minLength: 1 },
          name: { type: "string", maxLength: 80 },
          title: { type: "string", maxLength: 120 },
          description: { type: "string", maxLength: 2_000 },
        },
        required: ["botId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "list_routines",
      description:
        "List routines for this agent, or for another local agent when botId is provided. Use this before updating or deleting a routine.",
      inputSchema: {
        type: "object",
        properties: { botId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier } },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "create_routine",
      description:
        "Create a scheduled routine for this agent, or for another local agent when botId is provided. It is active by default and uses the host timezone by default.",
      inputSchema: {
        type: "object",
        properties: {
          botId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier },
          name: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.routineName },
          instruction: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.routineInstruction },
          schedule: ROUTINE_SCHEDULE_JSON_SCHEMA,
          active: { type: "boolean" },
          timezone: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: "IANA timezone such as Europe/Warsaw.",
          },
        },
        required: ["name", "instruction", "schedule"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "update_routine",
      description:
        "Update, pause, or resume an existing routine for this agent, or for another local agent when botId is provided.",
      inputSchema: {
        type: "object",
        properties: {
          botId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier },
          routineId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier },
          name: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.routineName },
          instruction: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.routineInstruction },
          schedule: ROUTINE_SCHEDULE_JSON_SCHEMA,
          active: { type: "boolean" },
        },
        required: ["routineId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "delete_routine",
      description: "Delete an existing routine for this agent, or for another local agent when botId is provided.",
      inputSchema: {
        type: "object",
        properties: {
          botId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier },
          routineId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier },
        },
        required: ["routineId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "test_routine",
      description:
        "Queue one manual test run of an existing routine for this agent, or for another local agent when botId is provided.",
      inputSchema: {
        type: "object",
        properties: {
          botId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier },
          routineId: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.identifier },
        },
        required: ["routineId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "remember",
      description:
        "Stage one short, durable memory for this agent. Use memoryId to correct or consolidate an existing memory. The change commits only if the current turn completes.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.agentMemoryText },
          memoryId: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "forget_memory",
      description:
        "Stage deletion of one saved memory when the user asks you to forget it. The change commits only if the current turn completes.",
      inputSchema: {
        type: "object",
        properties: { memoryId: { type: "string", minLength: 1 } },
        required: ["memoryId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "ask_user",
      description:
        "Ask the user 1–3 short questions and wait for structured answers. Use this instead of asking questions in a normal assistant message whenever clarification or a choice is needed.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                id: { type: "string", maxLength: INPUT_LIMITS.identifier },
                header: { type: "string", maxLength: INPUT_LIMITS.promptHeader },
                question: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.promptQuestion },
                isSecret: { type: "boolean" },
                options: {
                  type: "array",
                  maxItems: INPUT_LIMITS.promptOptions,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.promptOptionLabel },
                      description: { type: "string", maxLength: INPUT_LIMITS.promptOptionDescription },
                    },
                    required: ["label"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["question"],
              additionalProperties: false,
            },
          },
        },
        required: ["questions"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "react_to_user_message",
      description:
        "Add one emoji reaction to the current user message for an obvious positive or negative emotional moment, including wins, affection, gratitude, humor, sadness, disappointment, frustration, empathy, or strong approval. An emoji in the written answer does not count as a reaction. Skip neutral messages and never use the reaction instead of the normal answer.",
      inputSchema: {
        type: "object",
        properties: {
          emoji: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            description: "Exactly one complete Unicode emoji.",
          },
        },
        required: ["emoji"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "send_message",
      description:
        "Queue an asynchronous message and optional local files for one or more OpenBot agents. When replying, pass the original message id as replyToMessageId.",
      inputSchema: {
        type: "object",
        properties: {
          recipientBotIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 32,
          },
          text: { type: "string", minLength: 1, maxLength: 100_000 },
          paths: { type: "array", items: { type: "string" }, maxItems: 10 },
          replyToMessageId: { type: ["string", "null"] },
        },
        required: ["recipientBotIds", "text"],
        additionalProperties: false,
      },
    },
  ],
} as const;
