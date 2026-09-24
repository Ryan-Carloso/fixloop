import type { SelectChoice } from "./prompts.js";

export type ProviderStatus = "supported" | "experimental" | "coming-soon";

export interface ProviderSetupDefinition {
  /** Stable id; must match the runtime ErrorProvider name for supported providers. */
  id: string;
  /** Display name. */
  name: string;
  status: ProviderStatus;
  /**
   * Webhook path segment. FixLoop owns the endpoint:
   * {publicUrl}/webhooks/{webhookPath}.
   */
  webhookPath: string;
  /** Env var holding the shared webhook secret for this provider. */
  webhookSecretEnvVar: string;
  /** Concise instructions shown after setup (where to paste the webhook URL). */
  setupInstructions: (webhookUrl: string) => string;
}

/**
 * The single source of truth for provider capability.
 *
 * Only providers with a real, tested runtime implementation may be
 * "supported". Everything else is "coming-soon" (or "experimental" once an
 * adapter exists but is unverified). The wizard renders this list directly,
 * so it can never claim support the code doesn't have.
 *
 * To add a provider: implement the ErrorProvider, add an entry here with
 * status "supported", and the wizard picks it up — no wizard rewrite needed.
 */
export const ERROR_PROVIDERS: ProviderSetupDefinition[] = [
  {
    id: "bugsink",
    name: "BugSink",
    status: "supported",
    webhookPath: "bugsink",
    webhookSecretEnvVar: "FIXLOOP_WEBHOOK_SECRET",
    setupInstructions: (webhookUrl) =>
      [
        "In your BugSink project, add a custom webhook (outbound integration)",
        "pointing at:",
        ``,
        `  ${webhookUrl}`,
        ``,
        "and configure the same webhook token you entered during setup",
        "as the X-FixLoop-Webhook-Token header (or ?token= query parameter).",
      ].join("\n"),
  },
  {
    id: "sentry",
    name: "Sentry",
    status: "coming-soon",
    webhookPath: "sentry",
    webhookSecretEnvVar: "FIXLOOP_WEBHOOK_SECRET",
    setupInstructions: () => "Sentry support is coming soon.",
  },
  {
    id: "bugsnag",
    name: "Bugsnag",
    status: "coming-soon",
    webhookPath: "bugsnag",
    webhookSecretEnvVar: "FIXLOOP_WEBHOOK_SECRET",
    setupInstructions: () => "Bugsnag support is coming soon.",
  },
  {
    id: "sentry-compatible",
    name: "Sentry-compatible",
    status: "coming-soon",
    webhookPath: "sentry",
    webhookSecretEnvVar: "FIXLOOP_WEBHOOK_SECRET",
    setupInstructions: () => "Sentry-compatible support is coming soon.",
  },
];

const STATUS_LABEL: Record<ProviderStatus, string> = {
  supported: "Supported",
  experimental: "Experimental",
  "coming-soon": "Coming soon",
};

/** Choices for the provider prompt; non-supported entries are disabled. */
export function selectableProviders(): Array<SelectChoice<string>> {
  return ERROR_PROVIDERS.map((p) => ({
    value: p.id,
    name: `${p.name}`,
    description: STATUS_LABEL[p.status],
    disabled: p.status === "supported" ? false : STATUS_LABEL[p.status],
  }));
}

export function getProvider(id: string): ProviderSetupDefinition {
  const p = ERROR_PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown error provider: ${id}`);
  return p;
}

/** FixLoop owns the webhook endpoint: {publicUrl}/webhooks/{provider}. */
export function webhookUrlFor(publicUrl: string, providerId: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}/webhooks/${getProvider(providerId).webhookPath}`;
}

/**
 * Validate the public FixLoop URL. Returns true when valid, otherwise an
 * error message. Paths are rejected because webhook routing is fixed at
 * /webhooks/{provider}.
 */
export function validatePublicUrl(value: string): true | string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a valid URL, e.g. https://fixloop.example.com";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL must start with http:// or https://";
  }
  if (!url.hostname) {
    return "URL must include a hostname, e.g. https://fixloop.example.com";
  }
  if (url.pathname !== "/") {
    return "Enter the base URL without a path (webhooks live at /webhooks/<provider>)";
  }
  return true;
}

/** Non-blocking warning, e.g. for plain HTTP. */
export function publicUrlWarning(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol === "http:") {
      return "Warning: plain HTTP — webhook payloads travel unencrypted. Use HTTPS in production.";
    }
  } catch {
    // Invalid URLs are reported by validatePublicUrl.
  }
  return undefined;
}
