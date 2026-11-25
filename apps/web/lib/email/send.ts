// Sends email through Azure Communication Services, or, for local development and
// tests, writes it to a local outbox folder instead.
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { EmailClient } from "@azure/communication-email";

/** Longest an email may take to send (task 14). */
export const EMAIL_TIMEOUT_MS = 20_000;

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function outboxDir(): string {
  return process.env["DEV_OUTBOX_DIR"] ?? path.join(process.cwd(), ".dev-outbox");
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const transport = process.env["EMAIL_TRANSPORT"];
  if (transport === "dev-outbox") {
    const host = new URL(process.env["AUTH_URL"] ?? "http://localhost").hostname;
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error("EMAIL_TRANSPORT=dev-outbox is only allowed when AUTH_URL is local.");
    }
    const dir = outboxDir();
    // Written beside the outbox and then moved in, so whoever reads the outbox (the e2e
    // tests, as it fills) never sees a half-written message.
    const drafts = `${dir}.drafts`;
    await mkdir(dir, { recursive: true });
    await mkdir(drafts, { recursive: true });
    const file = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    await writeFile(path.join(drafts, file), JSON.stringify(message, null, 2));
    await rename(path.join(drafts, file), path.join(dir, file));
    return;
  }
  if (transport === "acs") {
    const connectionString = process.env["ACS_CONNECTION_STRING"];
    const from = process.env["EMAIL_FROM"];
    if (!connectionString || !from) {
      throw new Error("EMAIL_TRANSPORT=acs needs ACS_CONNECTION_STRING and EMAIL_FROM.");
    }
    // Gives up after 20 s rather than holding the request (task 14); callers already
    // treat a send that fails as not sent.
    const abortSignal = AbortSignal.timeout(EMAIL_TIMEOUT_MS);
    const poller = await new EmailClient(connectionString).beginSend(
      {
        senderAddress: from,
        content: { subject: message.subject, plainText: message.text },
        recipients: { to: [{ address: message.to }] },
      },
      { abortSignal },
    );
    await poller.pollUntilDone({ abortSignal });
    return;
  }
  throw new Error('EMAIL_TRANSPORT must be "acs" or "dev-outbox".');
}
