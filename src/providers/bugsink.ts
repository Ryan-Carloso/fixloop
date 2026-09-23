import { z } from "zod";
import {
  ErrorParseError,
  type ErrorContext,
  type ErrorProvider,
} from "./error-provider.js";

/**
 * BugSink error provider.
 *
 * Consumes BugSink's "custom" outbound webhook, which POSTs the canonical
 * issue serialization (IssueSerializer) plus convenience fields:
 *   title, project_name, url, alert_reason (+ optional unmute_reason)
 * with a plain `Content-Type: application/json` header.
 *
 * Verified against bugsink/bugsink source:
 *   alerts/service_backends/custom.py  (payload construction)
 *   alerts/service_backends/base.py    (safe_post: no signing headers)
 *   issues/serializers.py              (IssueSerializer field list)
 *
 * Security note: BugSink does NOT sign these webhooks. FixLoop therefore
 * requires a pre-shared token on the endpoint itself
 * (X-FixLoop-Webhook-Token header or ?token= query param), configured via
 * FIXLOOP_WEBHOOK_SECRET. See the route in src/server.ts.
 *
 * Limitation: this is an *issue-level* payload. It carries the exception
 * type/value but no stacktrace or breadcrumbs, so the coding agent must
 * reproduce the bug from the repository code.
 */
const BugSinkWebhookPayload = z
  .object({
    // IssueSerializer fields
    id: z
      .string({ required_error: "issue id is required" })
      .min(1, "issue id is required"),
    friendly_id: z.string().optional(),
    project: z.union([z.number(), z.string()]).optional(),
    digest_order: z.number().optional(),
    last_seen: z.string().optional(),
    first_seen: z.string().optional(),
    digested_event_count: z.number().optional(),
    stored_event_count: z.number().optional(),
    calculated_type: z.string().optional(),
    calculated_value: z.string().optional(),
    transaction: z.string().nullable().optional(),
    is_resolved: z.boolean().optional(),
    is_resolved_unconditionally: z.boolean().optional(),
    is_resolved_by_next_release: z.boolean().optional(),
    is_muted: z.boolean().optional(),
    // Convenience fields added by the custom webhook backend
    title: z.string().optional(),
    project_name: z.string().optional(),
    url: z.string().optional(),
    alert_reason: z.string().optional(),
    unmute_reason: z.string().optional(),
  })
  .passthrough();

export type BugSinkWebhookPayload = z.infer<typeof BugSinkWebhookPayload>;

export class BugSinkProvider implements ErrorProvider {
  readonly name = "bugsink";

  async parse(payload: unknown): Promise<ErrorContext> {
    const result = BugSinkWebhookPayload.safeParse(payload);
    if (!result.success) {
      throw new ErrorParseError(
        `invalid BugSink webhook payload: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        result.error,
      );
    }
    const p = result.data;
    const type = p.calculated_type?.trim() || "UnknownError";
    const message =
      p.calculated_value?.trim() || p.title?.trim() || "unknown error";

    return {
      provider: this.name,
      issueId: p.id,
      project: p.project_name,
      exception: { type, message },
      metadata: {
        friendlyId: p.friendly_id,
        title: p.title,
        issueUrl: p.url,
        alertReason: p.alert_reason,
        unmuteReason: p.unmute_reason,
        transaction: p.transaction ?? undefined,
        storedEventCount: p.stored_event_count,
        digestedEventCount: p.digested_event_count,
        isResolved: p.is_resolved,
        isMuted: p.is_muted,
        firstSeen: p.first_seen,
        lastSeen: p.last_seen,
      },
    };
  }
}
