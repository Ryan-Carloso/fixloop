import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

const RepositoryCommandsSchema = z.object({
  install: z.string().min(1),
  test: z.string().min(1),
  lint: z.string().optional(),
  typecheck: z.string().optional(),
  build: z.string().optional(),
});

const RepositorySchema = z.object({
  /** BugSink project name (payload field `project_name`) this entry repairs. */
  providerProject: z.string().min(1),
  github: z.object({
    repository: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/repo"),
    defaultBranch: z.string().default("main"),
  }),
  commands: RepositoryCommandsSchema,
});

const ConfigSchema = z.object({
  repositories: z.record(z.string(), RepositorySchema).default({}),
});

export type FixLoopConfig = z.infer<typeof ConfigSchema>;
export type RepositoryConfig = z.infer<typeof RepositorySchema>;

export function loadConfig(filePath: string): FixLoopConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`config file not found: ${filePath}`);
  }
  const result = ConfigSchema.safeParse(YAML.parse(raw));
  if (!result.success) {
    throw new Error(
      `invalid config ${filePath}: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/** Map an incoming provider project name to a configured repository. */
export function findRepository(
  config: FixLoopConfig,
  project?: string,
): { key: string; config: RepositoryConfig } | undefined {
  if (!project) return undefined;
  for (const [key, repo] of Object.entries(config.repositories)) {
    if (repo.providerProject === project) return { key, config: repo };
  }
  return undefined;
}
