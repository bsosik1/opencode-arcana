import type { Config } from "@opencode-ai/plugin"

export const COMMAND_NAMES = ["quick-fix", "quick-check", "validate", "cross-validate"] as const

export function configureCommands(config: Config) {
  config.command = {
    ...config.command,
    "quick-fix": command(
      "Run an explicitly authorized narrow fix through Fast",
      [
        "EXPLICIT_ARCANA_MODE: QUICK_FIX",
        "The marker fixes QUICK_FIX mode. Treat REQUEST as write authorization only for its named result and boundary.",
        "Delegate narrow diagnosis and implementation to knight-of-swords through native task, then inspect the diff and run only necessary in-scope verification.",
        "Do not start a broad audit or fix unrelated discoveries.",
        "",
        "REQUEST",
        "$ARGUMENTS",
      ].join("\n"),
    ),
    "quick-check": command(
      "Run a focused Fast read-only audit",
      [
        "EXPLICIT_ARCANA_MODE: QUICK_CHECK",
        "The marker fixes QUICK_CHECK mode. Use only page-of-swords for one read-only audit; do not add justice or cross validation.",
        "Return filtered findings, evidence, uncertainties, test gaps, and a bounded plan. This command grants no write authorization, implementation, remediation, or second audit.",
        "",
        "REQUEST",
        "$ARGUMENTS",
      ].join("\n"),
    ),
    validate: command(
      "Run a thorough Deep read-only audit",
      [
        "EXPLICIT_ARCANA_MODE: VALIDATE",
        "The marker fixes VALIDATE mode. Use only justice for one read-only audit; do not add page-of-swords or cross validation.",
        "Return filtered findings, evidence, uncertainties, test gaps, and a bounded plan. This command grants no write authorization, implementation, remediation, or second audit.",
        "",
        "REQUEST",
        "$ARGUMENTS",
      ].join("\n"),
    ),
    "cross-validate": command(
      "Run independent Fast and Deep read-only audits and fuse the reports",
      [
        "EXPLICIT_ARCANA_MODE: CROSS_VALIDATE",
        "The marker fixes CROSS_VALIDATE mode. Launch exactly page-of-swords and justice as independent native tasks with the same read-only contract and background: true on both before processing either result.",
        "Fuse only after both complete. Return filtered findings, evidence, uncertainties, test gaps, and a bounded plan. This command grants no write authorization; do not substitute, downgrade, implement, remediate, or start a second audit.",
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
