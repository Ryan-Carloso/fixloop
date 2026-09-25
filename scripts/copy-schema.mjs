// Copies src/db/schema.sql next to the compiled output (dist/db/) so the
// Postgres job store can load it at runtime. Plain node with no shell
// builtins (mkdir/cp), so the build stays cross-platform.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync(new URL("../dist/db", import.meta.url), { recursive: true });
copyFileSync(
  new URL("../src/db/schema.sql", import.meta.url),
  new URL("../dist/db/schema.sql", import.meta.url),
);
console.log("copied src/db/schema.sql -> dist/db/schema.sql");
