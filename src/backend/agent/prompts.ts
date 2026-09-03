import { randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentApprovalPermissions,
  AgentPromptQuestion,
  AgentPromptResolution,
  RespondToBrowserTakeoverInput,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { type DynamicToolResult, getArray, getRecord, getString, isRecord } from "../protocol";

export const MCP_ELICITATION_DECISION_ID = "mcp-elicitation-decision";
export const MCP_ELICITATION_ALLOW_ONCE = "Allow once";
export const MCP_ELICITATION_ALLOW_ALWAYS = "Always allow";
export const MCP_ELICITATION_DECLINE = "Don't allow";

export function commandText(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const command = params.command;
  if (isString(command)) return command;
  if (Array.isArray(command) && command.every(isString)) return command.join(" ");
  return null;
}

export function promptQuestions(params: unknown): AgentPromptQuestion[] {
  return getArray(params, "questions")
    .filter(isRecord)
    .map((question) => ({
      id: getString(question, "id") ?? randomUUID(),
      header: getString(question, "header") ?? "Question",
      question: getString(question, "question") ?? "The agent needs more information.",
      isSecret: question.isSecret === true,
      options: Array.isArray(question.options)
        ? question.options.filter(isRecord).map((option) => ({
            label: getString(option, "label") ?? "Option",
            description: getString(option, "description") ?? "",
          }))
        : null,
    }));
}

export function mcpElicitationQuestion(params: unknown): AgentPromptQuestion | null {
  const serverName = getString(params, "serverName");
  const mode = getString(params, "mode") ?? "form";
  const message = getString(params, "message")?.trim();
  const requestedSchema = getRecord(params, "requestedSchema");
  const properties = getRecord(requestedSchema, "properties");
  if (
    serverName !== "computer-use" ||
    (mode !== "form" && mode !== "openai/form") ||
    !message ||
    !requestedSchema ||
    !properties ||
    Object.keys(properties).length > 0
  ) {
    return null;
  }

  const persistence = getArray(getRecord(params, "_meta"), "persist").filter(isString);
  const options = [
    {
      label: MCP_ELICITATION_ALLOW_ONCE,
      description: "Allow this Computer Use request.",
    },
    ...(persistence.includes("always")
      ? [
          {
            label: MCP_ELICITATION_ALLOW_ALWAYS,
            description: "Remember this access for future Computer Use requests.",
          },
        ]
      : []),
    {
      label: MCP_ELICITATION_DECLINE,
      description: "Keep access blocked.",
    },
  ];
  const question: AgentPromptQuestion = {
    id: MCP_ELICITATION_DECISION_ID,
    header: "Computer Use",
    question: message.slice(0, INPUT_LIMITS.promptQuestion),
    isSecret: false,
    options,
  };
  return validPromptQuestions([question]) ? question : null;
}

export function mcpElicitationResult(
  params: unknown,
  answers: Record<string, string[]>,
): { action: "accept" | "cancel" | "decline"; content: DynamicRecord | null; _meta: DynamicRecord | null } {
  const selected = answers[MCP_ELICITATION_DECISION_ID]?.[0];
  if (selected === MCP_ELICITATION_ALLOW_ONCE) {
    return { action: "accept", content: {}, _meta: null };
  }
  if (selected === MCP_ELICITATION_ALLOW_ALWAYS && getArray(getRecord(params, "_meta"), "persist").includes("always")) {
    return { action: "accept", content: {}, _meta: { persist: "always" } };
  }
  if (selected === MCP_ELICITATION_DECLINE) {
    return { action: "decline", content: null, _meta: null };
  }
  return { action: "cancel", content: null, _meta: null };
}

export function validPromptQuestions(questions: AgentPromptQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.length <= INPUT_LIMITS.promptQuestions &&
    new Set(questions.map((question) => question.id)).size === questions.length &&
    questions.every(
      (question) =>
        question.id.length > 0 &&
        question.id.length <= INPUT_LIMITS.identifier &&
        question.header.length <= INPUT_LIMITS.promptHeader &&
        question.question.length > 0 &&
        question.question.length <= INPUT_LIMITS.promptQuestion &&
        (question.options === null ||
          (question.options.length <= INPUT_LIMITS.promptOptions &&
            question.options.every(
              (option) =>
                option.label.length > 0 &&
                option.label.length <= INPUT_LIMITS.promptOptionLabel &&
                option.description.length <= INPUT_LIMITS.promptOptionDescription,
            ))),
    )
  );
}

export function questionPromptText(questions: AgentPromptQuestion[], resolution: AgentPromptResolution | null): string {
  const responses = resolution?.status === "answered" ? resolution.responses : null;
  return questions
    .map((question) => {
      const lines = [`Question: ${question.question}`];
      if (!responses) return lines.join("\n");
      const response = responses[question.id];
      if (!response || response.status === "skipped") lines.push("Answer: Skipped");
      else if (question.isSecret || !response.answers) lines.push("Answer: Private answer");
      else lines.push(`Answer: ${response.answers.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function promptResolution(
  questions: AgentPromptQuestion[],
  answers: Record<string, string[]>,
): AgentPromptResolution {
  if (Object.keys(answers).length === 0) return { status: "cancelled" };
  return {
    status: "answered",
    responses: Object.fromEntries(
      questions.map((question) => {
        const values = answers[question.id] ?? [];
        if (values.length === 0) return [question.id, { status: "skipped" }];
        return [question.id, question.isSecret ? { status: "answered" } : { status: "answered", answers: [...values] }];
      }),
    ),
  };
}

export function dynamicPromptResult(answers: Record<string, string[]>): DynamicToolResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(answers) }],
  };
}

export function browserTakeoverResult(decision: RespondToBrowserTakeoverInput["decision"]): DynamicToolResult {
  return {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({
          status: decision === "complete" ? "completed" : "cancelled",
          ...(decision === "complete" ? { next: "Take a fresh snapshot and continue the task." } : {}),
        }),
      },
    ],
  };
}

export function browserTakeoverError(): DynamicToolResult {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: "OpenBot could not create a browser takeover request." }],
  };
}

export function approvalPermissions(params: unknown): AgentApprovalPermissions {
  const permissions = getRecord(params, "permissions");
  const fileSystem = getRecord(permissions, "fileSystem");
  const network = getRecord(permissions, "network");
  const read = getArray(fileSystem, "read").filter(isString);
  const write = getArray(fileSystem, "write").filter(isString);
  return {
    fileSystem: { read, write },
    network: network?.enabled === true,
  };
}
