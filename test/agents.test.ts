import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/plugin"
import { ACTIVE_SUBAGENTS, configureAgents } from "../src/configure-agents.ts"
import { DEFAULT_OPTIONS } from "../src/options.ts"
import { loadPrompts } from "../src/prompts.ts"

describe("configureAgents", () => {
  test("registers The Magician and four hidden native-task workers", async () => {
    const config = {} as Config
    configureAgents(config, DEFAULT_OPTIONS, await loadPrompts())

    const magician = config.agent?.magician
    expect(magician).toMatchObject({
      mode: "primary",
      model: "openai/gpt-5.6-sol",
      variant: "xhigh",
      color: "#F97316",
    })

    for (const name of ACTIVE_SUBAGENTS) {
      expect(config.agent?.[name]).toMatchObject({ mode: "subagent", hidden: true })
    }
  })

  test("copies Fast and Deep model selections to their read-only auditors", async () => {
    const config = {} as Config
    const options = {
      models: {
        magician: { model: "example/magician", variant: "high" },
        "knight-of-swords": { model: "example/fast", variant: "low" },
        hermit: { model: "example/deep", variant: "max" },
      },
    }
    configureAgents(config, options, await loadPrompts())

    expect(config.agent?.["page-of-swords"]).toMatchObject(options.models["knight-of-swords"])
    expect(config.agent?.justice).toMatchObject(options.models.hermit)
  })

  test("allows The Magician to call exactly the four active subagents", async () => {
    const config = {} as Config
    configureAgents(config, DEFAULT_OPTIONS, await loadPrompts())

    const permission = config.agent?.magician?.permission as Record<string, unknown>
    expect(permission.task).toEqual({
      "*": "deny",
      "knight-of-swords": "allow",
      hermit: "allow",
      "page-of-swords": "allow",
      justice: "allow",
    })
  })

  test("keeps auditors read-only", async () => {
    const config = {} as Config
    configureAgents(config, DEFAULT_OPTIONS, await loadPrompts())

    for (const name of ["page-of-swords", "justice"]) {
      const permission = config.agent?.[name]?.permission as Record<string, unknown>
      expect(permission["*"]).toBe("deny")
      expect(permission.read).toBeDefined()
      expect(permission.glob).toBe("allow")
      expect(permission.grep).toBe("allow")
      expect(permission.bash).toBe("deny")
      expect(permission.read).toMatchObject({
        "**/.git/config": "deny",
        "**/.docker/config.json": "deny",
        "**/.kube/config": "deny",
        "**/*.key": "deny",
        "**/*.p12": "deny",
        "**/*.pfx": "deny",
        "**/credentials": "deny",
      })
    }
  })
})
