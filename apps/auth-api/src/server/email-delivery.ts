import { type SmtpEmailConfig, sendPrivateEmailCode, sendPrivateTeamInvite } from "./smtp-email-delivery";
import type { EmailCodeDelivery, TeamInviteEmailDelivery, WorkerBindings } from "./types";

type EmailDeliveryBindings = Pick<
  WorkerBindings,
  | "EMAIL_SMTP_HOST"
  | "EMAIL_SMTP_PORT"
  | "EMAIL_SMTP_USERNAME"
  | "EMAIL_SMTP_PASSWORD"
  | "EMAIL_FROM"
  | "EMAIL_DELIVERY_WEBHOOK_URL"
  | "EMAIL_DELIVERY_WEBHOOK_SECRET"
>;

export function createEmailCodeDelivery(bindings: EmailDeliveryBindings): EmailCodeDelivery | null {
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
      }).catch(() => {
        throw new Error("email_delivery_unknown");
      });
      if (!response.ok) throw new Error("email_delivery_webhook_failed");
    },
  };
}

export function createTeamInviteEmailDelivery(bindings: EmailDeliveryBindings): TeamInviteEmailDelivery | null {
  const smtp = readSmtpConfig(bindings);
  return smtp ? { send: (message) => sendPrivateTeamInvite(smtp, message) } : null;
}

function readSmtpConfig(bindings: EmailDeliveryBindings): SmtpEmailConfig | null {
  const values = {
    host: bindings.EMAIL_SMTP_HOST?.trim(),
    port: bindings.EMAIL_SMTP_PORT?.trim(),
    username: bindings.EMAIL_SMTP_USERNAME?.trim(),
    password: bindings.EMAIL_SMTP_PASSWORD,
    from: bindings.EMAIL_FROM?.trim(),
  };
  const configuredCount = Object.values(values).filter((value) => value !== undefined && value !== "").length;
  if (configuredCount === 0) return null;
  if (
    configuredCount !== Object.keys(values).length ||
    !values.host ||
    !values.port ||
    !values.username ||
    !values.password ||
    !values.from
  ) {
    throw new Error("SMTP email delivery configuration is incomplete.");
  }
  return {
    host: values.host,
    port: Number(values.port),
    username: values.username,
    password: values.password,
    from: values.from,
  };
}
