import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/plugin"
import { ACTIVE_SUBAGENTS, configureAgents } from "../src/configure-agents.ts"
import { DEFAULT_OPTIONS, parseOptions } from "../src/options.ts"
import { loadPrompts } from "../src/prompts.ts"

describe("configureAgents", () => {
  test("registers The Magician and four hidden native-task workers", async () => {
    const config = {} as Config
    configureAgents(config, DEFAULT_OPTIONS, await loadPrompts())

    expect(config.agent?.magician).toMatchObject({
      mode: "primary",
      model: "openai/gpt-5.6-sol",
      variant: "xhigh",
      color: "#F97316",
    })
    for (const name of ACTIVE_SUBAGENTS) expect(config.agent?.[name]).toMatchObject({ mode: "subagent", hidden: true })
  })

  test("reads every model and variant from its nested agent entry", async () => {
    const config = {} as Config
    const options = parseOptions({
      agents: {
        magician: { model: "example/magician", variant: "high" },
        "knight-of-swords": { model: "example/fast", variant: "low" },
        hermit: { model: "example/deep", variant: "max" },
        "page-of-swords": { model: "example/page", variant: "mid" },
        justice: { model: "example/justice", variant: "high" },
      },
    })
    configureAgents(config, options, await loadPrompts())

    expect(config.agent?.magician).toMatchObject(options.agents.magician)
    expect(config.agent?.["knight-of-swords"]).toMatchObject(options.agents["knight-of-swords"])
    expect(config.agent?.hermit).toMatchObject(options.agents.hermit)
    expect(config.agent?.["page-of-swords"]).toMatchObject(options.agents["page-of-swords"])
    expect(config.agent?.justice).toMatchObject(options.agents.justice)
  })

  test("keeps the complete default permissions unchanged without nested overrides", async () => {
    const config = {} as Config
    configureAgents(config, DEFAULT_OPTIONS, await loadPrompts())

    expect((config.agent?.magician?.permission as Record<string, unknown>).task).toEqual({
      "*": "deny",
      "knight-of-swords": "allow",
      hermit: "allow",
      "page-of-swords": "allow",
      justice: "allow",
    })
    for (const name of ["knight-of-swords", "hermit"]) {
      const permission = config.agent?.[name]?.permission as Record<string, unknown>
      expect(permission.todowrite).toBe("allow")
      expect(permission.question).toBe("deny")
      expect(permission.task).toBe("deny")
      expect(permission.edit).toBe("allow")
    }
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
    }

    expect(Object.keys(config.agent?.magician?.permission ?? {})).toEqual(["question", "todowrite", "edit", "task", "bash"])
    expect(Object.keys(config.agent?.hermit?.permission ?? {})).toEqual(["question", "todowrite", "task", "edit", "bash"])
    expect(Object.keys(config.agent?.justice?.permission ?? {})).toEqual([
      "*",
      "read",
      "glob",
      "grep",
      "edit",
      "task",
      "todowrite",
      "question",
      "webfetch",
      "websearch",
      "skill",
      "bash",
    ])
  })

  test("allows every role to technically override permissions, including auditor edit/bash/task/outer star", async () => {
    const config = {} as Config
    const prompts = await loadPrompts()
    const options = parseOptions({
      agents: {
        magician: { permission: { task: { "new-worker": "allow" } } },
        "knight-of-swords": { permission: { task: "allow" } },
        hermit: { permission: { task: { "*": "ask" } } },
        "page-of-swords": {
          permission: { "*": "allow", edit: "allow", task: "allow", bash: { "example-command*": "allow" } },
        },
        justice: { permission: { "*": "allow", edit: "allow", task: "allow", bash: "allow" } },
      },
    })
    configureAgents(config, options, prompts)

    expect((config.agent?.magician?.permission as Record<string, unknown>).task).toEqual({
      "*": "deny",
      "knight-of-swords": "allow",
      hermit: "allow",
      "page-of-swords": "allow",
      justice: "allow",
      "new-worker": "allow",
    })
    expect((config.agent?.["knight-of-swords"]?.permission as Record<string, unknown>).task).toBe("allow")
    expect((config.agent?.hermit?.permission as Record<string, unknown>).task).toEqual({ "*": "ask" })

    for (const name of ["page-of-swords", "justice"]) {
      const permission = config.agent?.[name]?.permission as Record<string, unknown>
      expect(permission["*"]).toBe("allow")
      expect(permission.edit).toBe("allow")
      expect(permission.task).toBe("allow")
    }
    expect(config.agent?.["page-of-swords"]?.permission?.bash).toEqual({
      "*": "deny",
      "Get-Date": "allow",
      "Get-Date -Format o": "allow",
      "get-date": "allow",
      "get-date -format o": "allow",
      "example-command*": "allow",
    })
    expect(config.agent?.["page-of-swords"]?.prompt).toBe(prompts.pageOfSwords)
  })

  test("omits external-directory rules when wikiPath is absent and scopes them when present", async () => {
    const withoutWiki = {} as Config
    configureAgents(withoutWiki, DEFAULT_OPTIONS, await loadPrompts())
    expect((withoutWiki.agent?.hermit?.permission as Record<string, unknown>).external_directory).toBeUndefined()

    const config = {} as Config
    const wikiPath = "C:/data/example-vault"
    configureAgents(config, parseOptions({ wikiPath }), await loadPrompts())
    for (const name of ["magician", "knight-of-swords", "hermit"]) {
      expect((config.agent?.[name]?.permission as Record<string, unknown>).external_directory).toEqual({
        "*": "ask",
        [wikiPath]: "allow",
        [`${wikiPath}/**`]: "allow",
      })
    }
    for (const name of ["page-of-swords", "justice"]) {
      expect((config.agent?.[name]?.permission as Record<string, unknown>).external_directory).toEqual({
        "*": "deny",
        [wikiPath]: "allow",
        [`${wikiPath}/**`]: "allow",
      })
    }
  })

  test("uses static prompts unchanged and preserves exact timestamp and destructive Bash rules", async () => {
    const config = {} as Config
    const prompts = await loadPrompts()
    configureAgents(config, DEFAULT_OPTIONS, prompts)
    expect(config.agent?.magician?.prompt).toBe(prompts.magician)
    expect(config.agent?.hermit?.prompt).toBe(prompts.hermit)

    const magicianBash = config.agent?.magician?.permission?.bash as Record<string, string>
    expect(magicianBash["Get-Date"]).toBe("allow")
    expect(magicianBash["Get-Date -Format o"]).toBe("allow")
    expect(magicianBash["git reset --hard*"]).toBe("deny")
    expect(magicianBash["Remove-Item *-Recurse*-Force*"]).toBe("deny")
    const auditorBash = config.agent?.justice?.permission?.bash as Record<string, string>
    expect(resolveBashRule(auditorBash, "Get-Date -Format o")).toBe("allow")
    expect(resolveBashRule(auditorBash, "Get-Date -Format o; Write-Output unsafe")).toBe("deny")
  })

  test("applies one nested agent override without changing other agents", async () => {
    const baseline = {} as Config
    const configured = {} as Config
    const prompts = await loadPrompts()
    configureAgents(baseline, DEFAULT_OPTIONS, prompts)
    configureAgents(configured, parseOptions({ agents: { hermit: { permission: { edit: "deny" } } } }), prompts)

    for (const name of ["magician", "knight-of-swords", "page-of-swords", "justice"] as const) {
      expect(configured.agent?.[name]?.permission).toEqual(baseline.agent?.[name]?.permission)
    }
    expect(configured.agent?.hermit?.permission?.edit).toBe("deny")
  })

  test("replaces scalars and lifts scalar baselines to ordered maps", async () => {
    const config = {} as Config
    configureAgents(
      config,
      parseOptions({
        agents: {
          hermit: { permission: { bash: "deny" } },
          "knight-of-swords": { permission: { edit: { "*": "deny", "src/**": "allow" } } },
        },
      }),
      await loadPrompts(),
    )

    expect(config.agent?.hermit?.permission?.bash).toBe("deny")
    expect((config.agent?.["knight-of-swords"]?.permission as Record<string, unknown>).edit).toEqual({
      "*": "deny",
      "src/**": "allow",
    })
  })

  test("retains baseline patterns, appends local declarations, and lets the last match win", async () => {
    const config = {} as Config
    configureAgents(
      config,
      parseOptions({
        agents: {
          magician: {
            permission: { bash: { "*": "deny", "git status*": "allow", "git diff*": "deny" } },
          },
        },
      }),
      await loadPrompts(),
    )

    const bash = config.agent?.magician?.permission?.bash as Record<string, string>
    expect(Object.keys(bash).slice(-3)).toEqual(["*", "git status*", "git diff*"])
    expect(resolveBashRule(bash, "git status feature")).toBe("allow")
    expect(resolveBashRule(bash, "git diff feature")).toBe("deny")
    expect(resolveBashRule(bash, "Write-Output unsafe")).toBe("deny")
  })

  test("merges wikiPath rules after a nested local restriction", async () => {
    const config = {} as Config
    const wikiPath = "C:/data/example-vault"
    configureAgents(
      config,
      parseOptions({ agents: { hermit: { permission: { external_directory: { [wikiPath]: "deny" } } } }, wikiPath }),
      await loadPrompts(),
    )

    expect((config.agent?.hermit?.permission as Record<string, unknown>).external_directory).toEqual({
      "*": "ask",
      [`${wikiPath}/**`]: "allow",
      [wikiPath]: "deny",
    })
  })

  test("does not leak permission state across sequential configure calls", async () => {
    const prompts = await loadPrompts()
    const options = parseOptions({ agents: { hermit: { permission: { bash: { "*": "deny", "bun test*": "allow" } } } } })
    const first = {} as Config
    const second = {} as Config
    configureAgents(first, options, prompts)
    ;(first.agent?.hermit?.permission?.bash as Record<string, string>).mutated = "allow"
    configureAgents(second, options, prompts)

    expect(second.agent?.hermit?.permission?.bash).not.toHaveProperty("mutated")
    expect(second.agent?.magician?.permission).not.toBe(first.agent?.magician?.permission)
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
