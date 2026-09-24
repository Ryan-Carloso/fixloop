import {
  confirm as inqConfirm,
  input as inqInput,
  password as inqPassword,
  select as inqSelect,
} from "@inquirer/prompts";

export interface SelectChoice<T extends string> {
  value: T;
  /** Display name; defaults to value. */
  name?: string;
  description?: string;
  /** Disable the choice with an optional reason shown in the UI. */
  disabled?: boolean | string;
}

/**
 * Thrown when the user cancels a prompt (Ctrl+C). The wizard catches this
 * to exit cleanly without writing partial configuration.
 */
export class PromptCancelled extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "PromptCancelled";
  }
}

/**
 * Prompt abstraction. The wizard talks only to this interface so tests
 * and scripted runs can inject canned answers (FakePrompter) instead of
 * requiring a TTY.
 */
export interface Prompter {
  select<T extends string>(
    message: string,
    choices: Array<SelectChoice<T>>,
  ): Promise<T>;
  input(
    message: string,
    opts?: {
      default?: string;
      validate?: (value: string) => true | string;
    },
  ): Promise<string>;
  password(
    message: string,
    opts?: { validate?: (value: string) => true | string },
  ): Promise<string>;
  confirm(message: string, opts?: { default?: boolean }): Promise<boolean>;
}

/** Real implementation backed by @inquirer/prompts (arrow keys, masking). */
export class InquirerPrompter implements Prompter {
  /** Ctrl+C (ExitPromptError) becomes PromptCancelled so wizards exit cleanly. */
  private static async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && err.name === "ExitPromptError") {
        throw new PromptCancelled("interrupted");
      }
      throw err;
    }
  }

  async select<T extends string>(
    message: string,
    choices: Array<SelectChoice<T>>,
  ): Promise<T> {
    return InquirerPrompter.guard(() => inqSelect({ message, choices }));
  }

  async input(
    message: string,
    opts?: {
      default?: string;
      validate?: (value: string) => true | string;
    },
  ): Promise<string> {
    return InquirerPrompter.guard(() =>
      inqInput({
        message,
        default: opts?.default,
        validate: opts?.validate,
      }),
    );
  }

  async password(
    message: string,
    opts?: { validate?: (value: string) => true | string },
  ): Promise<string> {
    return InquirerPrompter.guard(() =>
      inqPassword({ message, mask: "*", validate: opts?.validate }),
    );
  }

  async confirm(
    message: string,
    opts?: { default?: boolean },
  ): Promise<boolean> {
    return InquirerPrompter.guard(() =>
      inqConfirm({ message, default: opts?.default ?? true }),
    );
  }
}

/**
 * Test/scripted prompter. Answers are consumed in order; every question is
 * recorded in `asked` (password answers are recorded as the question only,
 * never the secret).
 */
export class FakePrompter implements Prompter {
  readonly asked: string[] = [];

  constructor(private answers: Array<string | boolean>) {}

  private next(kind: string): string | boolean {
    const answer = this.answers.shift();
    if (answer === undefined) {
      throw new Error(`FakePrompter: no more queued answers (${kind})`);
    }
    return answer;
  }

  async select<T extends string>(
    message: string,
    _choices: Array<SelectChoice<T>>,
  ): Promise<T> {
    this.asked.push(`select: ${message}`);
    return this.next("select") as T;
  }

  async input(message: string): Promise<string> {
    this.asked.push(`input: ${message}`);
    return String(this.next("input"));
  }

  async password(message: string): Promise<string> {
    // Record the question, never the secret.
    this.asked.push(`password: ${message}`);
    return String(this.next("password"));
  }

  async confirm(message: string): Promise<boolean> {
    this.asked.push(`confirm: ${message}`);
    const answer = this.next("confirm");
    if (typeof answer === "boolean") return answer;
    const normalized = String(answer).trim().toLowerCase();
    return ["y", "yes", "true", "1"].includes(normalized);
  }
}
