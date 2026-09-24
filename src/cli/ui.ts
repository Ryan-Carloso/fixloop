import type { Check } from "./preflight.js";

/** Render one diagnostic check as human-readable lines. */
export function renderCheck(check: Check): string[] {
  const lines = [
    `${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`,
  ];
  if (!check.ok && check.hint) lines.push(`  ${check.hint}`);
  return lines;
}

/** Render a list of checks, each on its own lines. */
export function renderChecks(checks: Check[]): string[] {
  return checks.flatMap(renderCheck);
}
