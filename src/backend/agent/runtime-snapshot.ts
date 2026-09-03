import {
  AGENT_RUNTIME_PERMISSION_PATHS_LIMIT,
  AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT,
  AGENT_RUNTIME_QUESTION_HEADER_LIMIT,
  AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT,
  AGENT_RUNTIME_TEXT_LIMIT,
  type AgentApproval,
  type AgentPromptQuestion,
  type AgentRuntimeSnapshot,
} from "@openbot/contracts/ipc";

export function compactRuntimeQuestion(
  question: AgentPromptQuestion,
): AgentRuntimeSnapshot["pendingPrompts"][number]["questions"][number] {
  return {
    id: question.id,
    header: question.header.slice(0, AGENT_RUNTIME_QUESTION_HEADER_LIMIT),
    question: question.question.slice(0, AGENT_RUNTIME_TEXT_LIMIT),
    isSecret: question.isSecret,
    options:
      question.options?.map((option) => ({
        label: option.label,
        description: option.description.slice(0, AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT),
      })) ?? null,
  };
}

export function compactRuntimeApproval(approval: AgentApproval): AgentRuntimeSnapshot["pendingApprovals"][number] {
  const pathTruncated = (path: string) => path.length > AGENT_RUNTIME_TEXT_LIMIT;
  return {
    ...approval,
    truncated:
      [approval.command, approval.cwd, approval.reason, approval.grantRoot].some(
        (value) => value !== null && value.length > AGENT_RUNTIME_TEXT_LIMIT,
      ) ||
      Boolean(
        approval.permissions &&
          (approval.permissions.fileSystem.read.length > AGENT_RUNTIME_PERMISSION_PATHS_LIMIT ||
            approval.permissions.fileSystem.write.length > AGENT_RUNTIME_PERMISSION_PATHS_LIMIT ||
            approval.permissions.fileSystem.read.some(pathTruncated) ||
            approval.permissions.fileSystem.write.some(pathTruncated)),
      ),
    command: approval.command?.slice(0, AGENT_RUNTIME_TEXT_LIMIT) ?? null,
    cwd: approval.cwd?.slice(0, AGENT_RUNTIME_TEXT_LIMIT) ?? null,
    reason: approval.reason?.slice(0, AGENT_RUNTIME_TEXT_LIMIT) ?? null,
    grantRoot: approval.grantRoot?.slice(0, AGENT_RUNTIME_TEXT_LIMIT) ?? null,
    permissions: approval.permissions
      ? {
          fileSystem: {
            read: approval.permissions.fileSystem.read
              .slice(0, AGENT_RUNTIME_PERMISSION_PATHS_LIMIT)
              .map((path) => path.slice(0, AGENT_RUNTIME_TEXT_LIMIT)),
            write: approval.permissions.fileSystem.write
              .slice(0, AGENT_RUNTIME_PERMISSION_PATHS_LIMIT)
              .map((path) => path.slice(0, AGENT_RUNTIME_TEXT_LIMIT)),
          },
          network: approval.permissions.network,
        }
      : null,
  };
}

export function fitRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): AgentRuntimeSnapshot {
  if (runtimeSnapshotBytes(snapshot) <= AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT) return snapshot;

  snapshot.bots = snapshot.bots.map((bot) => ({ ...bot, preview: "", avatarUrl: null }));
  if (runtimeSnapshotBytes(snapshot) <= AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT) return snapshot;

  snapshot.work = [];
  if (runtimeSnapshotBytes(snapshot) <= AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT) return snapshot;

  snapshot.latestMessages = snapshot.latestMessages.map((message) => ({ ...message, text: "" }));
  if (runtimeSnapshotBytes(snapshot) <= AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT) return snapshot;

  snapshot.pendingPrompts = snapshot.pendingPrompts.map((prompt) => ({
    ...prompt,
    questions: prompt.questions.map((question) => ({
      ...question,
      header: question.header.slice(0, 40),
      question: question.question.slice(0, 80),
      options: question.options?.map((option) => ({ label: option.label, description: "" })) ?? null,
    })),
  }));
  snapshot.pendingApprovals = snapshot.pendingApprovals.map((approval) => ({
    ...approval,
    truncated: true,
    command: approval.command?.slice(0, 80) ?? null,
    cwd: approval.cwd?.slice(0, 80) ?? null,
    reason: approval.reason?.slice(0, 80) ?? null,
    grantRoot: approval.grantRoot?.slice(0, 80) ?? null,
    permissions: approval.permissions
      ? { fileSystem: { read: [], write: [] }, network: approval.permissions.network }
      : null,
  }));
  if (runtimeSnapshotBytes(snapshot) <= AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT) return snapshot;

  while (
    runtimeSnapshotBytes(snapshot) > AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT &&
    snapshot.pendingPrompts.length + snapshot.pendingApprovals.length + snapshot.pendingBrowserTakeovers.length > 0
  ) {
    snapshot.attentionComplete = false;
    if (snapshot.pendingBrowserTakeovers.length > 0) snapshot.pendingBrowserTakeovers.pop();
    else if (snapshot.pendingApprovals.length > 0) snapshot.pendingApprovals.pop();
    else snapshot.pendingPrompts.pop();
  }
  if (runtimeSnapshotBytes(snapshot) <= AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT) return snapshot;

  snapshot.bots = snapshot.bots.map((bot) => ({
    ...bot,
    name: bot.name.slice(0, 40),
    preview: "",
    avatarSeed: bot.id,
    avatarUrl: null,
  }));
  return snapshot;
}

export function runtimeSnapshotBytes(snapshot: AgentRuntimeSnapshot): number {
  return Buffer.byteLength(JSON.stringify({ type: "runtime-snapshot", snapshot }));
}
