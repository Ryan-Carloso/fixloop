import { sanitizeForPr } from "../redact.js";

/**
 * Minimal job reference carried in Discord notifications. Kept structural
 * (instead of importing the Job type) so the notifier has no dependency
 * on the job store module.
 */
export interface DiscordJobRef {
  id: string;
  repository: string;
  issueId: string;
  provider: string;
}

export type DiscordEvent =
  | { kind: "repair_started"; job: DiscordJobRef }
  | { kind: "pr_created"; job: DiscordJobRef; prUrl?: string }
  | { kind: "repair_failed"; job: DiscordJobRef; reason: string }
  | { kind: "needs_review"; job: DiscordJobRef; note?: string };

/** Anything that can receive job-lifecycle notifications. */
export interface JobNotifier {
  notify(event: DiscordEvent): Promise<void>;
}

// Discord embed sidebar colors.
const COLORS = {
  started: 0x5865f2, // blurple
  prCreated: 0x57f287, // green
  failed: 0xed4245, // red
  needsReview: 0xfee75c, // yellow
} as const;

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

function jobFields(job: DiscordJobRef): EmbedField[] {
  return [
    { name: "Job", value: truncateField(job.id), inline: true },
    { name: "Repository", value: truncateField(job.repository), inline: true },
    {
      name: "Issue",
      // issueId comes from the external webhook payload: escape it so a
      // hostile value cannot render a masked link inside a trusted
      // FixLoop notification (see escapeDiscordMarkdown).
      value: truncateField(
        `${job.provider}:${escapeDiscordMarkdown(job.issueId)}`,
      ),
      inline: true,
    },
  ];
}

// Discord caps embed descriptions at 4096 characters (6000 total per
// request). Chatty failure reasons (stack traces, git stderr dumps) would
// otherwise yield HTTP 400 and silently drop the notification.
const MAX_DESCRIPTION_LENGTH = 4096;

// Discord caps individual field values at 1024 characters; issueId comes
// from the external webhook payload and is unbounded.
const MAX_FIELD_LENGTH = 1024;

/** Truncate over-long text to an explicit character budget. */
function truncateTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Truncate over-long embed field values (1024-char field cap). */
function truncateField(text: string): string {
  return truncateTo(text, MAX_FIELD_LENGTH);
}

/**
 * Backslash-escape Discord markdown metacharacters in externally-
 * controlled strings. Embeds render masked links ([text](url)), so an
 * unescaped issueId from a hostile or spoofed webhook payload could
 * plant a phishing link inside a trusted FixLoop notification.
 * (BugSink generates issueIds server-side, so this is defense in
 * depth.)
 */
function escapeDiscordMarkdown(text: string): string {
  return text.replace(/[\\[\]()]/g, (ch) => `\\${ch}`);
}

// Discord allows 6000 characters per embed in total (title, description
// and fields combined).
const MAX_TOTAL_LENGTH = 6000;

function buildEmbed(event: DiscordEvent): Record<string, unknown> {
  const fields = jobFields(event.job);
  let title: string;
  let rawDescription: string;
  let color: number;
  switch (event.kind) {
    case "repair_started":
      title = "🔧 FixLoop: repair started";
      rawDescription = `Repair pipeline started for **${event.job.provider}** issue **${escapeDiscordMarkdown(event.job.issueId)}**.`;
      color = COLORS.started;
      break;
    case "pr_created":
      title = "✅ FixLoop: fix PR created";
      rawDescription = event.prUrl
        ? `Fix verified and PR opened: ${event.prUrl}`
        : "Fix verified and PR opened (URL not recorded).";
      color = COLORS.prCreated;
      break;
    case "repair_failed":
      // The reason may echo error output; redact secret-looking values
      // before it leaves the machine (same policy as public PR bodies).
      title = "❌ FixLoop: repair failed";
      rawDescription = `**Reason:** ${sanitizeForPr(event.reason)}`;
      color = COLORS.failed;
      break;
    case "needs_review":
      title = "👀 FixLoop: repair needs human review";
      rawDescription = event.note
        ? `**Note:** ${sanitizeForPr(event.note)}`
        : "The repair pipeline did not produce a verified fix.";
      color = COLORS.needsReview;
      break;
  }
  // The description is the largest and most expendable part: give it the
  // 4096-char cap minus whatever the title and fields already consume, so
  // the whole embed always fits Discord's 6000-char total budget.
  const fixedLength =
    title.length +
    fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  const description = truncateTo(
    rawDescription,
    Math.min(MAX_DESCRIPTION_LENGTH, Math.max(0, MAX_TOTAL_LENGTH - fixedLength)),
  );
  return {
    fields,
    timestamp: new Date().toISOString(),
    title,
    description,
    color,
  };
}

/**
 * Posts job-lifecycle notifications to a Discord webhook.
 *
 * The webhook URL comes from the DISCORD_WEBHOOK_URL environment variable
 * (collected by `fixloop setup` and stored in the install .env file).
 * When it is unset the notifier is a silent no-op (a warning is logged once
 * per disabled instance; production builds one at startup). notify() never throws: a failing webhook must never
 * break the repair pipeline.
 */
export class DiscordNotifier implements JobNotifier {
  private constructor(private readonly webhookUrl?: string) {
    if (!webhookUrl) {
      // One warning per disabled instance (production builds a single
      // notifier at startup). Per-instance state keeps tests isolated —
      // no module-global flag to reset between cases.
      console.warn(
        "DISCORD_WEBHOOK_URL is not set; Discord notifications are disabled.",
      );
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DiscordNotifier {
    const url = env.DISCORD_WEBHOOK_URL?.trim() || undefined;
    return new DiscordNotifier(url);
  }

  get enabled(): boolean {
    return this.webhookUrl !== undefined;
  }

  async notify(event: DiscordEvent): Promise<void> {
    const webhookUrl = this.webhookUrl;
    if (!webhookUrl) return; // silent no-op
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Bound the request: a hung webhook connection must not leave the
        // fire-and-forget promise and its socket open indefinitely.
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          username: "FixLoop",
          embeds: [buildEmbed(event)],
        }),
      });
      if (!res.ok) {
        console.warn(
          `Discord webhook POST failed with status ${res.status}; notification dropped.`,
        );
      }
    } catch (err) {
      // Notifications must never break the repair pipeline. fetch() throws
      // with the full request URL in the message when the configured URL is
      // malformed — the URL embeds the secret token, so redact it before it
      // can reach the logs. Redact the exact URL, the /webhooks/ id/token
      // segments (in case an error surfaces just the path), and the
      // percent-encoded form (in case an error surfaces the URL encoded).
      const message = err instanceof Error ? err.message : String(err);
      const scrubbed = message
        .split(webhookUrl)
        .join("[redacted]")
        .replace(/\/webhooks\/[^\s"']+/gi, "/webhooks/[redacted]")
        .replace(/%2Fwebhooks%2F[^\s"']+/gi, "[redacted]");
      console.warn(`Discord notification failed: ${scrubbed}`);
    }
  }
}
