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

  test("uses distinct explicit mode markers", () => {
    const config = {} as Config
    configureCommands(config)

    expect(config.command?.["quick-fix"].template).toContain("EXPLICIT_ARCANA_MODE: QUICK_FIX")
    expect(config.command?.["quick-check"].template).toContain("EXPLICIT_ARCANA_MODE: QUICK_CHECK")
    expect(config.command?.validate.template).toContain("EXPLICIT_ARCANA_MODE: VALIDATE")
    expect(config.command?.["cross-validate"].template).toContain("EXPLICIT_ARCANA_MODE: CROSS_VALIDATE")
  })
})
