#!/usr/bin/env node
import { Command } from "commander";
import { runDoctor } from "./doctor.js";
import { runSetup } from "./setup.js";
import { runSmokeTest } from "./smoke.js";
import { runStatus } from "./status.js";

const program = new Command();

program
  .name("fixloop")
  .description("Turn application errors into tested, verified pull requests.")
  .version("0.1.0");

program
  .command("setup")
  .description("Interactive setup wizard: configure FixLoop on this server")
  .action(async () => {
    try {
      const result = await runSetup({});
      if (result.next === "doctor") {
        const doctor = await runDoctor({});
        process.exitCode = doctor.ok ? 0 : 1;
      } else {
        process.exitCode = result.saved ? 0 : 1;
      }
    } catch (err) {
      console.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("configure")
  .description("Update the existing FixLoop configuration")
  .action(async () => {
    try {
      const result = await runSetup({ assumeUpdate: true });
      process.exitCode = result.saved ? 0 : 1;
    } catch (err) {
      console.error(`Configure failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Diagnose the FixLoop installation (read-only, never changes anything)")
  .option("--probe", "Run a tiny live AI probe (costs a few tokens)")
  .action(async (opts: { probe?: boolean }) => {
    try {
      const result = await runDoctor({ probeAi: opts.probe === true });
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) {
      console.error(`Doctor failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("Show concise FixLoop status (secrets are never printed)")
  .action(async () => {
    try {
      const result = await runStatus({});
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) {
      console.error(`Status failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("test")
  .description("Safely exercise the installation (no fake bugs, no PRs)")
  .action(async () => {
    try {
      const result = await runSmokeTest({});
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) {
      console.error(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
