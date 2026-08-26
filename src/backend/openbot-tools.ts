import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { ROUTINE_SCHEDULE_JSON_SCHEMA } from "./routine-tool-schema";

export const OPENBOT_DYNAMIC_TOOLS = {
  type: "namespace",
  name: "openbot",
  description: "Discover and asynchronously message persistent OpenBot teammates.",
  tools: [
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
                id: { type: "string" },
                header: { type: "string" },
                question: { type: "string" },
                isSecret: { type: "boolean" },
                options: {
                  type: "array",
                  maxItems: 5,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
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
