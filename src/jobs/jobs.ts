import { randomUUID } from "node:crypto";
import type { ErrorContext } from "../providers/error-provider.js";
import type { DiscordEvent, JobNotifier } from "../notify/discord.js";

export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "REPRODUCING"
  | "FIXING"
  | "VERIFYING"
  | "PR_CREATED"
  | "NEEDS_HUMAN_REVIEW"
  | "FAILED"
  | "TIMED_OUT";

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
  /** URL of the fix PR, set when the job reaches PR_CREATED. */
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

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  updateStatus(
    id: string,
    status: JobStatus,
    patch?: Partial<Job>,
  ): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
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

  constructor(
    private readonly store: JobStore,
    private readonly handler: JobHandler,
    private readonly concurrency = 1,
    private readonly notifier?: JobNotifier,
  ) {}

  enqueue(job: Job): EnqueueResult {
    const existing = this.store.findActiveByDedupKey(job.dedupKey);
    if (existing) return { accepted: false, deduped: true, job: existing };
    this.store.create(job);
    this.pending.push(job.id);
    void this.pump();
    return { accepted: true, deduped: false, job };
  }

  private async pump(): Promise<void> {
    while (this.activeCount < this.concurrency) {
      const id = this.pending.shift();
      if (!id) return;
      this.activeCount++;
      try {
        await this.runOne(id);
      } finally {
        this.activeCount--;
      }
    }
  }

  private async runOne(id: string): Promise<void> {
    const job = this.store.get(id);
    if (!job) return;
    const update: JobUpdate = (status, patch) => {
      const updated = this.store.updateStatus(id, status, patch);
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
