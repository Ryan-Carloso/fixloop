// Copies src/db/schema.sql next to the compiled output (dist/db/) so the
// Postgres job store can load it at runtime. Plain node with no shell
// builtins (mkdir/cp), so the build stays cross-platform.
//
// Usage: node scripts/copy-schema.mjs [src] [dest]
// Defaults to the repo's src/db/schema.sql -> dist/db/schema.sql.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2] ?? resolve(repoRoot, "src/db/schema.sql");
const dest = process.argv[3] ?? resolve(repoRoot, "dist/db/schema.sql");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`copied ${src} -> ${dest}`);
