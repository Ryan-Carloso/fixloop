import { sanitizeForPr } from "../fixloop.js";

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

// Tracks whether the "notifications disabled" startup warning was logged,
// so repeated fromEnv() calls (tests, rebuilds) do not spam it.
let disabledWarningLogged = false;

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
    { name: "Job", value: job.id, inline: true },
    { name: "Repository", value: job.repository, inline: true },
    { name: "Issue", value: `${job.provider}:${job.issueId}`, inline: true },
  ];
}

// Discord caps embed descriptions at 4096 characters (6000 total per
// request). Chatty failure reasons (stack traces, git stderr dumps) would
// otherwise yield HTTP 400 and silently drop the notification.
const MAX_DESCRIPTION_LENGTH = 4096;

/** Truncate over-long text so the embed stays within Discord's limits. */
function truncate(text: string): string {
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
  return `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
}

function buildEmbed(event: DiscordEvent): Record<string, unknown> {
  const base = {
    fields: jobFields(event.job),
    timestamp: new Date().toISOString(),
  };
  switch (event.kind) {
    case "repair_started":
      return {
        ...base,
        title: "🔧 FixLoop: repair started",
        description: `Repair pipeline started for **${event.job.provider}** issue **${event.job.issueId}**.`,
        color: COLORS.started,
      };
    case "pr_created":
      return {
        ...base,
        title: "✅ FixLoop: fix PR created",
        description: event.prUrl
          ? `Fix verified and PR opened: ${event.prUrl}`
          : "Fix verified and PR opened (URL not recorded).",
        color: COLORS.prCreated,
      };
    case "repair_failed": {
      // The reason may echo error output; redact secret-looking values
      // before it leaves the machine (same policy as public PR bodies),
      // and truncate so chatty errors stay within Discord's embed limits.
      const description = truncate(`**Reason:** ${sanitizeForPr(event.reason)}`);
      return {
        ...base,
        title: "❌ FixLoop: repair failed",
        description,
        color: COLORS.failed,
      };
    }
    case "needs_review": {
      const description = event.note
        ? truncate(`**Note:** ${sanitizeForPr(event.note)}`)
        : "The repair pipeline did not produce a verified fix.";
      return {
        ...base,
        title: "👀 FixLoop: repair needs human review",
        description,
        color: COLORS.needsReview,
      };
    }
  }
}

/**
 * Posts job-lifecycle notifications to a Discord webhook.
 *
 * The webhook URL comes from the DISCORD_WEBHOOK_URL environment variable
 * (collected by `fixloop setup` and stored in the install .env file).
 * When it is unset the notifier is a silent no-op (a single warning is
 * logged at startup). notify() never throws: a failing webhook must never
 * break the repair pipeline.
 */
export class DiscordNotifier implements JobNotifier {
  private constructor(private readonly webhookUrl?: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DiscordNotifier {
    const url = env.DISCORD_WEBHOOK_URL?.trim() || undefined;
    if (!url && !disabledWarningLogged) {
      disabledWarningLogged = true;
      console.warn(
        "DISCORD_WEBHOOK_URL is not set; Discord notifications are disabled.",
      );
    }
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
      // can reach the logs.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `Discord notification failed: ${message.split(webhookUrl).join("[redacted]")}`,
      );
    }
  }
}
