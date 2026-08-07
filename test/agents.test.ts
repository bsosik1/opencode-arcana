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

  test("gives every agent its own exact model selection", async () => {
    const config = {} as Config
    const options = {
      models: {
        magician: { model: "example/magician", variant: "high" },
        "knight-of-swords": { model: "example/fast", variant: "low" },
        hermit: { model: "example/deep", variant: "max" },
        "page-of-swords": { model: "example/page", variant: "mid" },
        justice: { model: "example/justice", variant: "high" },
      },
    }
    configureAgents(config, options, await loadPrompts())

    expect(config.agent?.magician).toMatchObject(options.models.magician)
    expect(config.agent?.["knight-of-swords"]).toMatchObject(options.models["knight-of-swords"])
    expect(config.agent?.hermit).toMatchObject(options.models.hermit)
    expect(config.agent?.["page-of-swords"]).toMatchObject(options.models["page-of-swords"])
    expect(config.agent?.justice).toMatchObject(options.models.justice)
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
      expect(permission.edit).toBe("deny")
      expect(permission.task).toBe("deny")
      expect(permission.todowrite).toBe("deny")
      expect(permission.question).toBe("deny")
      expect(permission.webfetch).toBe("allow")
      expect(permission.websearch).toBe("allow")
      expect(permission.skill).toBe("allow")
      expect(permission.bash).toEqual({
        "*": "deny",
        "Get-Date": "allow",
        "Get-Date -Format o": "allow",
        "get-date": "allow",
        "get-date -format o": "allow",
      })
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

  test("omits external-directory rules when the wiki is not configured", async () => {
    const config = {} as Config
    configureAgents(config, DEFAULT_OPTIONS, await loadPrompts())

    for (const name of ["magician", ...ACTIVE_SUBAGENTS]) {
      const permission = config.agent?.[name]?.permission as Record<string, unknown>
      expect(permission.external_directory).toBeUndefined()
    }
  })

  test("allows only the configured wiki root for external-directory access", async () => {
    const config = {} as Config
    const wikiPath = "C:/data/example-vault"
    configureAgents(config, { ...DEFAULT_OPTIONS, wikiPath }, await loadPrompts())

    for (const name of ["magician", "knight-of-swords", "hermit"]) {
      const permission = config.agent?.[name]?.permission as Record<string, unknown>
      expect(permission.external_directory).toEqual({
        "*": "ask",
        [wikiPath]: "allow",
        [`${wikiPath}/**`]: "allow",
      })
    }
    for (const name of ["page-of-swords", "justice"]) {
      const permission = config.agent?.[name]?.permission as Record<string, unknown>
      expect(permission.external_directory).toEqual({
        "*": "deny",
        [wikiPath]: "allow",
        [`${wikiPath}/**`]: "allow",
      })
    }
  })

  test("uses the loaded static prompts unchanged, without runtime wiki injection", async () => {
    const config = {} as Config
    const wikiPath = "C:/data/example-vault"
    const prompts = await loadPrompts()
    configureAgents(config, { ...DEFAULT_OPTIONS, wikiPath }, prompts)

    expect(config.agent?.magician?.prompt).toBe(prompts.magician)
    expect(config.agent?.["knight-of-swords"]?.prompt).toBe(prompts.knightOfSwords)
    expect(config.agent?.hermit?.prompt).toBe(prompts.hermit)
    expect(config.agent?.["page-of-swords"]?.prompt).toBe(prompts.pageOfSwords)
    expect(config.agent?.justice?.prompt).toBe(prompts.justice)
  })

  test("keeps timestamp permissions exact and preserves destructive denials", async () => {
    const config = {} as Config
    configureAgents(config, DEFAULT_OPTIONS, await loadPrompts())

    const magicianBash = config.agent?.magician?.permission?.bash as Record<string, string>
    expect(magicianBash["Get-Date"]).toBe("allow")
    expect(magicianBash["Get-Date -Format o"]).toBe("allow")
    expect(magicianBash["get-date"]).toBe("allow")
    expect(magicianBash["get-date -format o"]).toBe("allow")
    expect(Object.keys(magicianBash).filter((key) => /date/i.test(key) && key.includes("*")).length).toBe(0)
    expect(magicianBash["git reset --hard*"]).toBe("deny")
    expect(magicianBash["Remove-Item *-Recurse*-Force*"]).toBe("deny")

    for (const name of ["page-of-swords", "justice"]) {
      const bash = config.agent?.[name]?.permission?.bash as Record<string, string>
      expect(Object.keys(bash).filter((key) => /date/i.test(key) && key.includes("*")).length).toBe(0)
      expect(resolveBashRule(bash, "Get-Date")).toBe("allow")
      expect(resolveBashRule(bash, "Get-Date -Format o")).toBe("allow")
      expect(resolveBashRule(bash, "get-date")).toBe("allow")
      expect(resolveBashRule(bash, "get-date -format o")).toBe("allow")
      expect(resolveBashRule(bash, "Get-Date -Format o; Write-Output unsafe")).toBe("deny")
      expect(resolveBashRule(bash, "Get-Date -Format o | Out-File unsafe")).toBe("deny")
      expect(resolveBashRule(bash, "Get-Date -Format")).toBe("deny")
      expect(resolveBashRule(bash, "Write-Output unsafe")).toBe("deny")
    }
  })
})

function resolveBashRule(rules: Record<string, string>, command: string): string | undefined {
  return Object.entries(rules)
    .filter(([pattern]) => wildcardMatches(pattern, command))
    .at(-1)?.[1]
}

function wildcardMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${expression}$`).test(value)
}
