import type { Config } from "@opencode-ai/plugin"

export const COMMAND_NAMES = ["quick-fix", "quick-check", "validate", "cross-validate"] as const

export function configureCommands(config: Config) {
  config.command = {
    ...config.command,
    "quick-fix": command(
      "Delegate a quick fix to Fast and perform only a narrow sanity check",
      [
        "EXPLICIT_ARCANA_MODE: QUICK_FIX",
        "Treat the user's arguments as an explicit request for a quick fix.",
        "Delegate the implementation to knight-of-swords through the native task tool.",
        "Afterward, inspect only the resulting diff and run the narrowest relevant test. Do not start an audit unless the user asks for one.",
        "",
        "REQUEST",
        "$ARGUMENTS",
      ].join("\n"),
    ),
    "quick-check": command(
      "Run a focused Fast validation, remediate validated findings, and verify the fix",
      [
        "EXPLICIT_ARCANA_MODE: QUICK_CHECK",
        "Treat the user's arguments as an explicit request for a quick validation.",
        "Use only page-of-swords for the initial read-only audit. Do not run cross validation.",
        "Automatically remediate validated findings through an implementation worker, then revalidate the corrected behavior.",
        "",
        "REQUEST",
        "$ARGUMENTS",
      ].join("\n"),
    ),
    validate: command(
      "Run a thorough Deep validation, remediate validated findings, and verify the fix",
      [
        "EXPLICIT_ARCANA_MODE: VALIDATE",
        "Treat the user's arguments as an explicit request for a normal thorough validation.",
        "Use only justice for the initial read-only audit. Do not run cross validation.",
        "Automatically remediate validated findings through an implementation worker, then revalidate the corrected behavior.",
        "",
        "REQUEST",
        "$ARGUMENTS",
      ].join("\n"),
    ),
    "cross-validate": command(
      "Run independent Fast and Deep validation, fuse evidence, remediate findings, and revalidate",
      [
        "EXPLICIT_ARCANA_MODE: CROSS_VALIDATE",
        "Treat the user's arguments as an explicit request for cross validation.",
        "Launch page-of-swords and justice as independent native background tasks with the same read-only contract.",
        "Fuse both reports, remediate validated findings through an implementation worker, then continue both audit sessions to revalidate the fix.",
        "",
        "REQUEST",
        "$ARGUMENTS",
      ].join("\n"),
    ),
  }
}

function command(description: string, template: string) {
  return {
    description,
    agent: "magician",
    subtask: false,
    template,
  }
}
