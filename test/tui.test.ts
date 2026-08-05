import { describe, expect, test } from "bun:test"
import { AGENT_IDENTITIES, formatChildDescription, formatChildTitle, getAgentIdentity } from "../src/tui.ts"

describe("Arcana TUI agent labels", () => {
  test("maps every runtime agent to its card title and functional role", () => {
    expect(Object.keys(AGENT_IDENTITIES).toSorted()).toEqual(
      ["magician", "knight-of-swords", "hermit", "page-of-swords", "justice"].toSorted(),
    )
    expect(AGENT_IDENTITIES["knight-of-swords"]).toEqual({
      displayName: "Knight of Swords",
      role: "Fast implementation",
    })
    expect(AGENT_IDENTITIES.justice).toEqual({ displayName: "Justice", role: "Deep Audit" })
  })

  test("formats readable known-agent titles without repeating the card name", () => {
    expect(formatChildTitle({ id: "ses-1", agent: "knight-of-swords", title: "Fix parser edge case" })).toBe(
      "Knight of Swords — Fix parser edge case",
    )
    expect(formatChildTitle({ id: "ses-2", agent: "knight-of-swords", title: "Knight of Swords — Fix parser" })).toBe(
      "Knight of Swords — Fix parser",
    )
    expect(formatChildDescription("knight-of-swords", "busy")).toBe("Fast implementation · @knight-of-swords · busy")
  })

  test("keeps a sensible fallback for unknown agents", () => {
    expect(getAgentIdentity("custom-worker")).toEqual({ displayName: "Custom Worker", role: "Subagent" })
    expect(formatChildTitle({ id: "ses-3", agent: "custom-worker", title: "Review changes" })).toBe(
      "Custom Worker — Review changes",
    )
    expect(formatChildDescription(undefined)).toBe("Subagent · @unknown · idle")
  })
})
