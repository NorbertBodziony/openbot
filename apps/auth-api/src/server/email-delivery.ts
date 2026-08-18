import {
  type SmtpEmailConfig,
  sendPrivateEmailCode,
  sendPrivateTeamInvite,
} from "./smtp-email-delivery";
import type { EmailCodeDelivery, TeamInviteEmailDelivery, WorkerBindings } from "./types";

export function createEmailCodeDelivery(bindings: WorkerBindings): EmailCodeDelivery | null {
  const smtp = readSmtpConfig(bindings);
  if (smtp) {
    return {
      send: (message) => sendPrivateEmailCode(smtp, message),
    };
  }

  const webhookUrl = bindings.EMAIL_DELIVERY_WEBHOOK_URL?.trim();
  if (!webhookUrl) return null;
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:") {
    throw new Error("EMAIL_DELIVERY_WEBHOOK_URL must use HTTPS.");
  }
  const secret = bindings.EMAIL_DELIVERY_WEBHOOK_SECRET?.trim();
  return {
    async send(message) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("email_delivery_webhook_failed");
    },
  };
}

export function createTeamInviteEmailDelivery(
  bindings: WorkerBindings,
): TeamInviteEmailDelivery | null {
  const smtp = readSmtpConfig(bindings);
  return smtp ? { send: (message) => sendPrivateTeamInvite(smtp, message) } : null;
}

function readSmtpConfig(bindings: WorkerBindings): SmtpEmailConfig | null {
  const values = {
    host: bindings.EMAIL_SMTP_HOST?.trim(),
    port: bindings.EMAIL_SMTP_PORT?.trim(),
    username: bindings.EMAIL_SMTP_USERNAME?.trim(),
    password: bindings.EMAIL_SMTP_PASSWORD,
    from: bindings.EMAIL_FROM?.trim(),
  };
  const configuredCount = Object.values(values).filter(
    (value) => value !== undefined && value !== "",
  ).length;
  if (configuredCount === 0) return null;
  if (configuredCount !== Object.keys(values).length) {
    throw new Error("SMTP email delivery configuration is incomplete.");
  }
  return {
    host: values.host as string,
    port: Number(values.port),
    username: values.username as string,
    password: values.password as string,
    from: values.from as string,
  };
}
