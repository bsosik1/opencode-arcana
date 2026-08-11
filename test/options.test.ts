import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, parseOptions } from "../src/options.ts"

describe("parseOptions", () => {
  test("uses complete defaults and clones them", () => {
    const parsed = parseOptions()

    expect(parsed).toEqual(DEFAULT_OPTIONS)
    expect(parsed).not.toBe(DEFAULT_OPTIONS)
    parsed.agents.magician.model = "example/changed"
    expect(DEFAULT_OPTIONS.agents.magician.model).toBe("openai/gpt-5.6-sol")
  })

  test("accepts an empty partial agents object and wikiPath", () => {
    expect(parseOptions({ agents: {}, wikiPath: "/srv/example-vault" })).toEqual({
      agents: DEFAULT_OPTIONS.agents,
      wikiPath: "/srv/example-vault",
    })
  })

  test("applies model and variant defaults independently for each role", () => {
    expect(
      parseOptions({
        agents: {
          "knight-of-swords": { model: "example/fast-model" },
          hermit: { variant: "low" },
        },
      }),
    ).toEqual({
      agents: {
        magician: DEFAULT_OPTIONS.agents.magician,
        "knight-of-swords": {
          model: "example/fast-model",
          variant: DEFAULT_OPTIONS.agents["knight-of-swords"].variant,
        },
        hermit: { model: DEFAULT_OPTIONS.agents.hermit.model, variant: "low" },
        "page-of-swords": DEFAULT_OPTIONS.agents["page-of-swords"],
        justice: DEFAULT_OPTIONS.agents.justice,
      },
    })
  })

  test("allows every role to declare an independent model, variant, and permission overlay", () => {
    const parsed = parseOptions({
      agents: {
        magician: { model: "example/magician", variant: "high", permission: { task: { "new-worker": "allow" } } },
        "knight-of-swords": { model: "example/fast", variant: "low", permission: { task: "allow" } },
        hermit: { model: "example/deep", variant: "max", permission: { task: { "*": "ask" } } },
        "page-of-swords": {
          model: "example/page",
          variant: "mid",
          permission: { "*": "allow", edit: "allow", bash: { "example-command*": "allow" }, task: "allow" },
        },
        justice: { model: "example/justice", variant: "high", permission: { "*": "allow", bash: "allow", edit: "allow", task: "allow" } },
      },
    })

    expect(parsed.agents.magician.permission).toEqual({ task: { "new-worker": "allow" } })
    expect(parsed.agents["knight-of-swords"].permission).toEqual({ task: "allow" })
    expect(parsed.agents.hermit.permission).toEqual({ task: { "*": "ask" } })
    expect(parsed.agents["page-of-swords"].permission).toEqual({
      "*": "allow",
      edit: "allow",
      bash: { "example-command*": "allow" },
      task: "allow",
    })
    expect(parsed.agents.justice.permission).toEqual({ "*": "allow", bash: "allow", edit: "allow", task: "allow" })
  })

  test("accepts an empty per-agent permission object as a no-op", () => {
    expect(parseOptions({ agents: { justice: { permission: {} } } }).agents.justice.permission).toEqual({})
  })

  test("rejects legacy top-level models and permissions instead of aliasing them", () => {
    expect(() => parseOptions({ models: {} })).toThrow("unknown option: models")
    expect(() => parseOptions({ permissions: {} })).toThrow("unknown option: permissions")
  })

  test("rejects unknown options and roles", () => {
    expect(() => parseOptions({ fallback: true })).toThrow("unknown option: fallback")
    expect(() => parseOptions({ agents: { oracle: { model: "example/model" } } })).toThrow("unknown option: oracle")
    expect(() => parseOptions({ agents: { hermit: { model: "example/model", fast: true } } })).toThrow(
      "unknown option: fast",
    )
  })

  test("rejects invalid model and variant values", () => {
    expect(() => parseOptions({ agents: { hermit: { model: "deepseek-v4-flash" } } })).toThrow("provider/model format")
    expect(() => parseOptions({ agents: { justice: { model: null } } })).toThrow("provider/model format")
    expect(() => parseOptions({ agents: { justice: { variant: null } } })).toThrow("non-empty string")
    expect(parseOptions({ agents: { hermit: { model: "openrouter/openai/gpt-4o" } } }).agents.hermit.model).toBe(
      "openrouter/openai/gpt-4o",
    )
  })

  test("rejects unknown permission tools and invalid actions", () => {
    expect(() => parseOptions({ agents: { magician: { permission: { shell: "ask" } } } })).toThrow(
      "unknown permission: shell",
    )
    expect(() => parseOptions({ agents: { magician: { permission: { bash: "prompt" } } } })).toThrow(
      "exactly allow",
    )
  })

  test("preserves scalar-only and granular permission classifications", () => {
    const invalid: unknown[] = [
      { agents: { magician: { permission: { question: { "*": "deny" } } } } },
      { agents: { magician: { permission: { bash: {} } } } },
      { agents: { magician: { permission: { bash: [] } } } },
      { agents: { magician: { permission: { bash: null } } } },
      { agents: { magician: { permission: null } } },
    ]
    for (const input of invalid) expect(() => parseOptions(input as never)).toThrow()
  })

  test("rejects inherited and dangerous properties at every permission level", () => {
    const inheritedAgent = Object.create({ magician: { permission: { bash: "ask" } } })
    expect(() => parseOptions({ agents: inheritedAgent })).toThrow("plain object")

    const inheritedPattern = Object.create({ "docs/**": "deny" })
    expect(() => parseOptions({ agents: { magician: { permission: { bash: inheritedPattern } } } })).toThrow(
      "plain object",
    )

    for (const level of ["agents", "agent", "permission", "pattern"]) {
      const dangerous = Object.create(null) as Record<string, unknown>
      Object.defineProperty(dangerous, "__proto__", { value: "deny", enumerable: true })
      const input =
        level === "agents"
          ? { agents: dangerous }
          : level === "agent"
            ? { agents: { magician: dangerous } }
            : level === "permission"
              ? { agents: { magician: { permission: dangerous } } }
              : { agents: { magician: { permission: { bash: dangerous } } } }
      expect(() => parseOptions(input)).toThrow("dangerous")
    }
  })

  test("rejects unsafe permission patterns but accepts the maximum array-index name", () => {
    for (const pattern of ["", " docs/**", "docs/** ", "docs\n/**", "0", "4294967294"]) {
      expect(() => parseOptions({ agents: { magician: { permission: { bash: { [pattern]: "deny" } } } } })).toThrow()
    }
    expect(
      parseOptions({ agents: { magician: { permission: { bash: { "4294967295": "deny" } } } } }).agents.magician
        .permission?.bash,
    ).toEqual({ "4294967295": "deny" })
  })

  test("normalizes valid Windows and POSIX wiki paths", () => {
    expect(parseOptions({ wikiPath: "C:\\data\\example-vault\\" }).wikiPath).toBe("C:/data/example-vault")
    expect(parseOptions({ wikiPath: "/srv\\example-vault//wiki/" }).wikiPath).toBe("/srv/example-vault/wiki")
  })

  test("rejects invalid wiki paths before filesystem access", () => {
    const invalidPaths: unknown[] = [
      null,
      "",
      "   ",
      "relative/wiki",
      "C:relative\\wiki",
      "/",
      "C:/",
      "C:\\",
      "\\\\server\\share",
      "C:/wiki/*",
      "C:/wiki/?",
      "C:/wiki/[notes]",
      "C:/wiki/\0notes",
      "C:/wiki/\nnotes",
      "C:/wiki/`notes",
      "C:/wiki/# instructions",
      "C:/wiki/../other",
    ]
    for (const wikiPath of invalidPaths) expect(() => parseOptions({ wikiPath })).toThrow()
  })

  test("clones permission input without mutation or state leakage", () => {
    const bash: Record<string, "allow" | "ask" | "deny"> = { "git status*": "allow" }
    const input = { agents: { hermit: { permission: { bash } } } }
    const parsed = parseOptions(input)
    bash["new command*"] = "deny"
    ;(parsed.agents.hermit.permission?.bash as Record<string, string>)["parsed-only"] = "ask"

    expect(input.agents.hermit.permission.bash).toEqual({ "git status*": "allow", "new command*": "deny" })
    expect(parsed.agents.hermit.permission?.bash).toEqual({ "git status*": "allow", "parsed-only": "ask" })
    expect(DEFAULT_OPTIONS.agents.hermit.permission).toBeUndefined()
  })
})
