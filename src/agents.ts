export type ArcanaAgentId = "magician" | "knight-of-swords" | "hermit" | "page-of-swords" | "justice"

export type AgentIdentity = {
  displayName: string
  role: string
}

export const AGENT_IDENTITIES: Record<ArcanaAgentId, AgentIdentity> = {
  magician: { displayName: "The Magician", role: "Primary orchestrator" },
  "knight-of-swords": { displayName: "Knight of Swords", role: "Fast implementation" },
  hermit: { displayName: "The Hermit", role: "Deep implementation" },
  "page-of-swords": { displayName: "Page of Swords", role: "Fast Audit" },
  justice: { displayName: "Justice", role: "Deep Audit" },
}

/** The worker order is shared by the picker-facing labels and the sidebar. */
export const MAGICIAN_ASSISTANTS = [
  { id: "knight-of-swords", displayName: AGENT_IDENTITIES["knight-of-swords"].displayName },
  { id: "hermit", displayName: AGENT_IDENTITIES.hermit.displayName },
  { id: "page-of-swords", displayName: AGENT_IDENTITIES["page-of-swords"].displayName },
  { id: "justice", displayName: AGENT_IDENTITIES.justice.displayName },
] as const

export type MagicianAssistantId = (typeof MAGICIAN_ASSISTANTS)[number]["id"]

export function getAgentIdentity(agent?: string): AgentIdentity {
  const normalized = agent?.trim()
  if (normalized && normalized in AGENT_IDENTITIES) {
    return AGENT_IDENTITIES[normalized as ArcanaAgentId]
  }
  return {
    displayName: normalized ? humanizeAgentId(normalized) : "Unknown agent",
    role: "Subagent",
  }
}

type ChildSession = {
  id: string
  title?: string
  agent?: string
}

export function formatChildTitle(session: ChildSession): string {
  const identity = getAgentIdentity(session.agent)
  const title = session.title?.trim() || (session.agent ? identity.displayName : session.id)
  if (title.toLocaleLowerCase().includes(identity.displayName.toLocaleLowerCase())) return title
  return `${identity.displayName} — ${title}`
}

export function formatChildDescription(agent: string | undefined, status?: string): string {
  const identity = getAgentIdentity(agent)
  const runtimeId = agent?.trim() || "unknown"
  return `${identity.role} · @${runtimeId} · ${status?.trim() || "idle"}`
}

function humanizeAgentId(agent: string): string {
  return agent
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toLocaleUpperCase() + part.slice(1))
    .join(" ") || "Unknown agent"
}
