import { randomUUID } from "node:crypto";
import type { ErrorContext } from "../providers/error-provider.js";

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
  /** Set when the repair produces a pull request (populated by the handler). */
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
    const update: JobUpdate = (status, patch) =>
      this.store.updateStatus(id, status, patch);
    update("RUNNING");
    try {
      await this.handler(job, update);
    } catch (err) {
      update("FAILED", {
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
