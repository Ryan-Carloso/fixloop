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
    case "repair_failed":
      return {
        ...base,
        title: "❌ FixLoop: repair failed",
        // The reason may echo error output; redact secret-looking values
        // before it leaves the machine (same policy as public PR bodies).
        description: `**Reason:** ${sanitizeForPr(event.reason)}`,
        color: COLORS.failed,
      };
    case "needs_review":
      return {
        ...base,
        title: "👀 FixLoop: repair needs human review",
        description: event.note
          ? `**Note:** ${sanitizeForPr(event.note)}`
          : "The repair pipeline did not produce a verified fix.",
        color: COLORS.needsReview,
      };
  }
}

/**
 * Posts job-lifecycle notifications to a Discord webhook.
 *
 * The webhook URL comes from the DISCORD_WEBHOOK_URL environment variable.
 * When it is unset the notifier is a silent no-op (a single warning is
 * logged at startup). notify() never throws: a failing webhook must never
 * break the repair pipeline.
 */
export class DiscordNotifier implements JobNotifier {
  private constructor(private readonly webhookUrl?: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DiscordNotifier {
    const url = env.DISCORD_WEBHOOK_URL?.trim() || undefined;
    if (!url) {
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
    if (!this.webhookUrl) return; // silent no-op
    try {
      const res = await fetch(this.webhookUrl, {
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
      // Notifications must never break the repair pipeline.
      console.warn(
        `Discord notification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
