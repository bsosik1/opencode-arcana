import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/plugin"
import { COMMAND_NAMES, configureCommands } from "../src/configure-commands.ts"

describe("configureCommands", () => {
  test("registers deterministic Arcana entrypoints", () => {
    const config = {} as Config
    configureCommands(config)

    expect(Object.keys(config.command ?? {}).toSorted()).toEqual([...COMMAND_NAMES].toSorted())
    for (const name of COMMAND_NAMES) {
      expect(config.command?.[name]).toMatchObject({ agent: "magician", subtask: false })
      expect(config.command?.[name].template).toContain("$ARGUMENTS")
    }
  })

  test("uses distinct authoritative mode markers", () => {
    const config = {} as Config
    configureCommands(config)

    expect(config.command?.["quick-fix"].template).toContain("EXPLICIT_ARCANA_MODE: QUICK_FIX")
    expect(config.command?.["quick-check"].template).toContain("EXPLICIT_ARCANA_MODE: QUICK_CHECK")
    expect(config.command?.validate.template).toContain("EXPLICIT_ARCANA_MODE: VALIDATE")
    expect(config.command?.["cross-validate"].template).toContain("EXPLICIT_ARCANA_MODE: CROSS_VALIDATE")
  })

  test("keeps audit commands read-only and report-only", () => {
    const config = {} as Config
    configureCommands(config)

    for (const name of ["quick-check", "validate", "cross-validate"] as const) {
      const template = config.command?.[name].template
      expect(template).toContain("read-only")
      expect(template).toContain("no write authorization")
      expect(template).toContain("filtered findings, evidence, uncertainties, test gaps, and a bounded plan")
      expect(template).not.toContain("automatically remediate")
      expect(template).not.toContain("revalidate the corrected behavior")
    }
  })

  test("keeps REQUEST subordinate to every command marker", () => {
    const config = {} as Config
    configureCommands(config)
    const scenarios = [
      ["quick-fix", "EXPLICIT_ARCANA_MODE: QUICK_FIX"],
      ["quick-check", "EXPLICIT_ARCANA_MODE: QUICK_CHECK"],
      ["validate", "EXPLICIT_ARCANA_MODE: VALIDATE"],
      ["cross-validate", "EXPLICIT_ARCANA_MODE: CROSS_VALIDATE"],
    ] as const

    // Template precedence is static contract behavior; it does not execute an LLM.
    for (const [name, marker] of scenarios) {
      const template = config.command?.[name].template ?? ""
      const requestIndex = template.indexOf("\nREQUEST\n")
      expect(template.indexOf(marker)).toBeGreaterThanOrEqual(0)
      expect(template.indexOf(marker)).toBeLessThan(requestIndex)
      expect(template).toContain("marker fixes")

      const rendered = template.replace("$ARGUMENTS", "analyze and fix this")
      expect(rendered).toContain("\nREQUEST\nanalyze and fix this")
    }
  })

  test("preserves exact cross-validation launch requirements", () => {
    const config = {} as Config
    configureCommands(config)
    const template = config.command?.["cross-validate"].template

    expect(template).toContain("exactly page-of-swords and justice")
    expect(template).toContain("independent native tasks")
    expect(template).toContain("background: true on both before processing either result")
    expect(template).toContain("Fuse only after both complete")
    expect(template).toContain("do not substitute, downgrade, implement, remediate, or start a second audit")
  })

  test("keeps quick-fix as the only command write path", () => {
    const config = {} as Config
    configureCommands(config)
    const template = config.command?.["quick-fix"].template

    expect(template).toContain("write authorization only for its named result and boundary")
    expect(template).toContain("narrow diagnosis and implementation")
    expect(template).toContain("necessary in-scope verification")
    expect(template).toContain("Do not start a broad audit")
  })
})
