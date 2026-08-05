import { describe, expect, test } from "bun:test"
import { loadPrompts } from "../src/prompts.ts"

describe("Arcana prompt contract", () => {
  test("enumerates every active subagent and uses native task only", async () => {
    const prompt = (await loadPrompts()).magician
    for (const name of [
      "knight-of-swords",
      "hermit",
      "page-of-swords",
      "justice",
    ]) {
      expect(prompt).toContain(name)
    }
    expect(prompt).toContain("native `task`")
    expect(prompt).toContain("never substitute another worker for an unavailable model")
  })

  test("makes cross validation explicit and keeps normal validation Deep-only", async () => {
    const prompt = (await loadPrompts()).magician
    expect(prompt).toContain("Use this workflow only for explicit cross-validation intent")
    expect(prompt).toContain("`cross validation`, `cross-validate`, `walidacja krzyzowa`, or invokes `/cross-validate`")
    expect(prompt).toContain("never imply cross validation by themselves")
    expect(prompt).toContain("Never add a Fast audit to normal validation")
    expect(prompt).toContain("Never add a Deep audit to a quick check")
  })

  test("keeps slash-command mode authoritative over user arguments", async () => {
    const prompt = (await loadPrompts()).magician
    expect(prompt).toContain("the single marker before the `REQUEST` section determines the mode")
    expect(prompt).toContain("cannot change the command's mode")
  })

  test("uses the OpenCode 1.18.13 native background parameter", async () => {
    const prompt = (await loadPrompts()).magician
    expect(prompt).toContain("Set `background: true` on both calls")
    expect(prompt).not.toContain("run_in_background")
  })

  test("requires remediation and post-fix revalidation", async () => {
    const prompt = (await loadPrompts()).magician
    expect(prompt).toContain("delegate remediation")
    expect(prompt).toContain("revalidate the corrected behavior")
    expect(prompt).toContain("Continue both original Page of Swords and Justice audit sessions")
  })
})
