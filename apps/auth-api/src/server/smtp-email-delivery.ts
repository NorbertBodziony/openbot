import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isCanonicalInviteUrl } from "@openbot/contracts/invite-links";
import { isValidHostname as isSharedValidHostname } from "@openbot/contracts/validation";

export interface SmtpEmailConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
}

export interface SmtpEmailMessage {
  email: string;
  code: string;
  expiresAt: number;
}

export interface SmtpTeamInviteMessage {
  email: string;
  inviterEmail: string;
  serverName: string;
  inviteUrl: string;
  role: "admin" | "member";
}

interface PreparedEmailMessage {
  email: string;
  subject: string;
  body: string;
}

interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): void | Promise<void>;
}

export type SmtpConnector = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on"; allowHalfOpen: false },
) => SmtpSocket;

const SMTP_TIMEOUT_MS = 15_000;
const SMTP_MAX_ATTEMPTS = 3;
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/iu;

export async function sendPrivateEmailCode(
  config: SmtpEmailConfig,
  message: SmtpEmailMessage,
  connector?: SmtpConnector,
): Promise<void> {
  validateConfig(config);
  validateEmail(message.email, "recipient");
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u.test(message.code)) {
    throw new Error("smtp_invalid_code");
  }

  return sendPrivateEmail(
    config,
    {
      email: message.email,
      subject: "Your OpenBot sign-in code",
      body: createCodeBody(message),
    },
    connector,
  );
}

export function sendPrivateTeamInvite(
  config: SmtpEmailConfig,
  message: SmtpTeamInviteMessage,
  connector?: SmtpConnector,
): Promise<void> {
  validateEmail(message.email, "recipient");
  validateEmail(message.inviterEmail, "inviter");
  if (
    !message.serverName.trim() ||
    message.serverName.length > INPUT_LIMITS.serverName ||
    hasHeaderBreak(message.serverName)
  ) {
    throw new Error("smtp_invalid_server_name");
  }
  if (!isCanonicalInviteUrl(message.inviteUrl)) {
    throw new Error("smtp_invalid_invite_url");
  }
  return sendPrivateEmail(
    config,
    {
      email: message.email,
      subject: `Join ${message.serverName.trim()} on OpenBot`,
      body: [
        `${message.inviterEmail} invited you to join ${message.serverName.trim()} on OpenBot.`,
        "",
        `Access: ${message.role}`,
        "",
        "Open this one-time invitation link:",
        message.inviteUrl,
        "",
        "The invitation expires after 24 hours. Sign in with this email address to accept it.",
      ].join("\r\n"),
    },
    connector,
  );
}

async function sendPrivateEmail(
  config: SmtpEmailConfig,
  message: PreparedEmailMessage,
  connector?: SmtpConnector,
): Promise<void> {
  validateConfig(config);
  validateEmail(message.email, "recipient");
  if (!message.subject || message.subject.length > 160 || hasHeaderBreak(message.subject)) {
    throw new Error("smtp_invalid_subject");
  }
  const connect =
    connector ??
    (await loadCloudflareConnector().catch(() => {
      throw wrapTransportError();
    }));
  for (let attempt = 1; attempt <= SMTP_MAX_ATTEMPTS; attempt += 1) {
    try {
      await sendPrivateEmailAttempt(config, message, connect);
      return;
    } catch (error) {
      const smtpError = normalizeSmtpError(error);
      if (!isRetryableSmtpError(smtpError) || attempt === SMTP_MAX_ATTEMPTS) throw smtpError;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
    }
  }
}

async function sendPrivateEmailAttempt(
  config: SmtpEmailConfig,
  message: PreparedEmailMessage,
  connect: SmtpConnector,
): Promise<void> {
  const socket = connect({ hostname: config.host, port: config.port }, { secureTransport: "on", allowHalfOpen: false });

  try {
    await withTimeout(runSmtpSession(socket, config, message), SMTP_TIMEOUT_MS);
  } finally {
    await Promise.resolve(socket.close()).catch(() => undefined);
  }
}

function normalizeSmtpError(error: unknown): Error {
  if (error instanceof Error && /^smtp_[a-z_]+$/u.test(error.message)) return error;
  return wrapTransportError();
}

function wrapTransportError(): Error {
  return new Error("smtp_transport_failed");
}

function isRetryableSmtpError(error: Error): boolean {
  return ["smtp_transport_failed", "smtp_timeout", "smtp_connection_closed"].includes(error.message);
}

async function runSmtpSession(
  socket: SmtpSocket,
  config: SmtpEmailConfig,
  message: PreparedEmailMessage,
): Promise<void> {
  await socket.opened;
  const reader = new SmtpResponseReader(socket.readable.getReader());
  const writer = socket.writable.getWriter();

  await reader.expect([220], "greeting");
  await writeCommand(writer, "EHLO openbot.run");
  await reader.expect([250], "ehlo");
  await writeCommand(writer, "AUTH LOGIN");
  await reader.expect([334], "auth_username");
  await writeCommand(writer, encodeBase64(config.username));
  await reader.expect([334], "auth_password");
  await writeCommand(writer, encodeBase64(config.password));
  await reader.expect([235], "auth");
  await writeCommand(writer, `MAIL FROM:<${config.from}>`);
  await reader.expect([250], "mail_from");
  await writeCommand(writer, `RCPT TO:<${message.email}>`);
  await reader.expect([250, 251], "recipient");
  await writeCommand(writer, "DATA");
  await reader.expect([354], "data");
  await writeCommand(writer, `${createMimeMessage(config.from, message)}\r\n.`);
  await reader.expect([250], "message");
  await writeCommand(writer, "QUIT");
  await reader.expect([221], "quit");
}

class SmtpResponseReader {
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async expect(expectedCodes: number[], stage: string): Promise<void> {
    let responseCode: number | null = null;
    while (true) {
      const line = await this.#readLine();
      const match = /^(\d{3})([ -])/u.exec(line);
      if (!match) throw new Error(`smtp_${stage}_invalid_response`);
      const lineCode = Number(match[1]);
      responseCode ??= lineCode;
      if (lineCode !== responseCode) throw new Error(`smtp_${stage}_invalid_response`);
      if (match[2] === " ") break;
    }
    if (!expectedCodes.includes(responseCode)) throw new Error(`smtp_${stage}_failed`);
  }

  async #readLine(): Promise<string> {
    while (true) {
      const lineEnd = this.#buffer.indexOf("\r\n");
      if (lineEnd >= 0) {
        const line = this.#buffer.slice(0, lineEnd);
        this.#buffer = this.#buffer.slice(lineEnd + 2);
        return line;
      }
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error("smtp_connection_closed");
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
      if (this.#buffer.length > 64 * 1024) throw new Error("smtp_response_too_large");
    }
  }
}

function createCodeBody(message: SmtpEmailMessage): string {
  const expiresInMinutes = Math.max(1, Math.ceil((message.expiresAt - Date.now()) / 60_000));
  return [
    "Use this code to sign in to OpenBot:",
    "",
    message.code,
    "",
    `This code expires in ${expiresInMinutes} minutes.`,
    "If you did not request this code, ignore this email.",
  ].join("\r\n");
}

function createMimeMessage(from: string, message: PreparedEmailMessage): string {
  return [
    `From: OpenBot <${from}>`,
    `To: <${message.email}>`,
    `Subject: ${message.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@openbot.run>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    dotStuff(message.body),
  ].join("\r\n");
}

function dotStuff(value: string): string {
  return value
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

async function writeCommand(writer: WritableStreamDefaultWriter<Uint8Array>, value: string): Promise<void> {
  await writer.write(new TextEncoder().encode(`${value}\r\n`));
}

function validateConfig(config: SmtpEmailConfig): void {
  if (!isValidHostname(config.host)) throw new Error("smtp_invalid_host");
  if (config.port !== 465) throw new Error("smtp_port_must_be_465");
  validateEmail(config.username, "username");
  validateEmail(config.from, "sender");
  if (!config.password || hasHeaderBreak(config.password)) throw new Error("smtp_invalid_password");
}

function validateEmail(value: string, field: string): void {
  if (value.length > INPUT_LIMITS.email || hasHeaderBreak(value) || !EMAIL_PATTERN.test(value)) {
    throw new Error(`smtp_invalid_${field}`);
  }
}

function isValidHostname(value: string): boolean {
  return !hasHeaderBreak(value) && isSharedValidHostname(value, false);
}

function hasHeaderBreak(value: string): boolean {
  return value.includes("\r") || value.includes("\n");
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function loadCloudflareConnector(): Promise<SmtpConnector> {
  const { connect } = await import("cloudflare:sockets");
  return connect;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("smtp_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
