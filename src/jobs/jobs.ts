import { randomUUID } from "node:crypto";
import { sanitizeForPr } from "../redact.js";
import type { ErrorContext } from "../providers/error-provider.js";
import type { DiscordEvent, JobNotifier } from "../notify/discord.js";

export const JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "REPRODUCING",
  "FIXING",
  "VERIFYING",
  "PR_CREATED",
  "NEEDS_HUMAN_REVIEW",
  "FAILED",
  "TIMED_OUT",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** True when the value is a known job status (used to validate ?status=). */
export function isJobStatus(value: unknown): value is JobStatus {
  return (
    typeof value === "string" &&
    (JOB_STATUSES as readonly string[]).includes(value)
  );
}

export interface Job {
  id: string;
  /** provider:repository:issueId — used to deduplicate simultaneous repairs. */
  dedupKey: string;
  provider: string;
  /** Key into the repositories map in fixloop.config.yaml. */
  repository: string;
  issueId: string;
  status: JobStatus;
  errorContext: ErrorContext;
  note?: string;
  /** URL of the fix PR, set when the repair produces a pull request. */
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/** Statuses that block a new repair for the same dedup key. */
export const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set([
  "QUEUED",
  "RUNNING",
  "REPRODUCING",
  "FIXING",
  "VERIFYING",
  "PR_CREATED",
]);

/**
 * Statuses a job never leaves. The pipeline is over; a late transition
 * (e.g. a handler throwing after it already recorded PR_CREATED) is a
 * bug, not an update. updateStatus ignores it and returns undefined, so
 * no contradictory notification fires and dedup is never unblocked by
 * accident.
 */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "PR_CREATED",
  "NEEDS_HUMAN_REVIEW",
  "FAILED",
  "TIMED_OUT",
]);

export function dedupKey(
  provider: string,
  repository: string,
  issueId: string,
): string {
  return `${provider}:${repository}:${issueId}`;
}

export function newJobId(): string {
  return randomUUID();
}

export class JobStore {
  private jobs = new Map<string, Job>();

  create(job: Job): Job {
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(status?: JobStatus): Job[] {
    const jobs = [...this.jobs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return status ? jobs.filter((job) => job.status === status) : jobs;
  }

  updateStatus(
    id: string,
    status: JobStatus,
    patch?: Partial<Job>,
  ): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (TERMINAL_STATUSES.has(job.status)) {
      // Late transition out of a terminal state: ignore it (see
      // TERMINAL_STATUSES). Returning undefined keeps the caller's
      // no-change path (no notification, no write-behind). Include the
      // note when present: a handler that throws after reaching a
      // terminal state would otherwise lose its error entirely. Notes
      // are sanitized at capture (JobQueue.runOne), so this is safe to log.
      const note =
        typeof patch?.note === "string" && patch.note.length > 0
          ? `: ${patch.note}`
          : "";
      console.warn(
        `ignoring transition of job ${id} from terminal status ${job.status} to ${status}${note}`,
      );
      return undefined;
    }
    job.status = status;
    job.updatedAt = new Date().toISOString();
    if (patch) Object.assign(job, patch);
    return job;
  }

  findActiveByDedupKey(key: string): Job | undefined {
    for (const job of this.jobs.values()) {
      if (job.dedupKey === key && ACTIVE_STATUSES.has(job.status)) return job;
    }
    return undefined;
  }
}

export type JobUpdate = (status: JobStatus, patch?: Partial<Job>) => void;
export type JobHandler = (job: Job, update: JobUpdate) => Promise<void>;

export interface EnqueueResult {
  accepted: boolean;
  deduped: boolean;
  job: Job;
}

/**
 * Minimal in-process job queue. Concurrency defaults to 1: one repair runs
 * at a time, the rest wait. No Redis, no BullMQ — by design for the MVP.
 * The actual repair work is injected as a JobHandler so the queue itself
 * stays dumb and testable.
 */
export class JobQueue {
  private pending: string[] = [];
  private activeCount = 0;
  /** Promises of the currently executing runOne() calls. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Set by stop(): no new repairs start after this. */
  private stopped = false;

  constructor(
    private readonly store: JobStore,
    private readonly handler: JobHandler,
    private readonly concurrency = 1,
    private readonly notifier?: JobNotifier,
  ) {}

  enqueue(job: Job): EnqueueResult {
    const existing = this.store.findActiveByDedupKey(job.dedupKey);
    if (existing) {
      if (this.stopped) {
        // While quiescing, a dedup hit must 503 like a fresh job: the
        // sender's first attempt got 503 (persisted, no repair started in
        // this process), so answering 202 here would end its retry cycle
        // and the repair would be silently lost.
        return { accepted: false, deduped: false, job: existing };
      }
      return { accepted: false, deduped: true, job: existing };
    }
    this.store.create(job);
    if (this.stopped) {
      // The queue is quiescing for shutdown: persist the job so crash
      // recovery picks it up on the next boot, but don't start a repair
      // in this process — pump() won't pick it up, so the caller must
      // not be told it was accepted. (The webhook route maps this to
      // 503.)
      return { accepted: false, deduped: false, job };
    }
    this.pending.push(job.id);
    void this.pump();
    return { accepted: true, deduped: false, job };
  }

  /**
   * Quiesces the queue for shutdown: no new repairs start, and the
   * returned promise settles once the active handlers finish, so their
   * final transitions land in the store before the caller flushes it.
   * Jobs still pending stay queued in the store; crash recovery handles
   * them on the next boot. The wait is bounded by the caller's shutdown
   * timeout — a repair that outlasts it keeps running in the background.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.inFlight]);
  }

  private async pump(): Promise<void> {
    while (!this.stopped && this.activeCount < this.concurrency) {
      const id = this.pending.shift();
      if (!id) return;
      this.activeCount++;
      const run = this.runOne(id);
      this.inFlight.add(run);
      try {
        await run;
      } finally {
        this.activeCount--;
        this.inFlight.delete(run);
      }
    }
  }

  private async runOne(id: string): Promise<void> {
    const job = this.store.get(id);
    if (!job) return;
    const update: JobUpdate = (status, patch) => {
      // Notes can carry raw error text (command output, env dumps) from any
      // call site; sanitize once here so every sink (DB, API, Discord)
      // stays redacted.
      const updated = this.store.updateStatus(
        id,
        status,
        patch?.note === undefined
          ? patch
          : { ...patch, note: sanitizeForPr(patch.note) },
      );
      this.notifyTransition(updated);
    };
    update("RUNNING");
    try {
      await this.handler(job, update);
    } catch (err) {
      update("FAILED", {
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Fire-and-forget Discord notification for the job-lifecycle transitions
   * the user cares about. Never throws and never leaves an unhandled
   * rejection: a broken notifier must not break the queue. JobNotifier is a
   * public interface, so guard both failure modes of a custom
   * implementation — a synchronously throwing notify() and a rejecting one
   * (an unhandled rejection terminates the Node process).
   */
  private notifyTransition(job: Job | undefined): void {
    if (!job || !this.notifier) return;
    let event: DiscordEvent | undefined;
    switch (job.status) {
      case "RUNNING":
        event = { kind: "repair_started", job };
        break;
      case "PR_CREATED":
        event = { kind: "pr_created", job, prUrl: job.prUrl };
        break;
      case "FAILED":
      case "TIMED_OUT":
        event = {
          kind: "repair_failed",
          job,
          reason: job.note ?? "unknown reason",
        };
        break;
      case "NEEDS_HUMAN_REVIEW":
        event = { kind: "needs_review", job, note: job.note };
        break;
      default:
        break;
    }
    if (event) {
      const report = (err: unknown): void => {
        console.warn(
          `notification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      };
      try {
        // A synchronous throw from notify() is caught here; a rejection is
        // caught by the .catch below.
        void Promise.resolve(this.notifier.notify(event)).catch(report);
      } catch (err) {
        report(err);
      }
    }
  }
}
