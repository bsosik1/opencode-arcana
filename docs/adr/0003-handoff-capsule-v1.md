# ADR 0003: HANDOFF_CAPSULE v1

## Status

Accepted for the Arcana v1 handoff and Task Dossier integration.

## Decision

Arcana uses one deterministic fenced JSON `HANDOFF_CAPSULE v1` block as the primary low-token information-transfer protocol. Workers append it after their existing named final-response sections; The Magician brokers and filters capsules but does not emit a worker producer capsule. The capsule is source data only. OpenCode native tasks and Task Dossiers remain the sources of truth; no second task database or continuation wrapper is introduced.

Each capsule is identified by invocation, capsule, topic, and evidence IDs. Ownership is never keyed only by role, so concurrent Knights or Hermits with overlapping descriptions remain independent. The Magician is the only broker and selects exact target-relevant evidence. Page and Justice evidence stays separate until explicit cross-validation fusion.

The wire payload contains an immutable contract snapshot/hash, ownership, bounded evidence, state, structured questions, authorization history, and next action. It targets 4,000 characters, has a hard 6,000-character full-framed cap, and limits ownership to 12, evidence to 8, questions to 6, unique locators to 10, changed files to 20, and checks to 16. Compaction is deterministic and may truncate prose or drop data, but never truncates identity or authority. Non-granted deltas are safely reset to empty `none` with diagnostics; oversized immutable authority returns a typed fail-closed result.

Freshness is conservative: changed locators, changed revisions, missing revisions, and conflict markers require verification or remain stale/conflicted. A capsule cannot authorize writes. Granted authorization history requires explicit provenance and is never sufficient to widen a new target contract. Audit capsules remain report-only unless a separate target contract independently authorizes implementation.

The dossier UI extracts exactly one complete standalone-line capsule from a native result, reports compact health, and renders a neutral report-only generated handoff. It does not call task, session.prompt, clipboard, or an execution API.

## Consequences

- Worker prompts gain an exact canonical Capsule v1 schema, framing contract, enums, and bounds; The Magician receives only broker rules.
- Legacy worker results remain visible and are reported as missing capsules.
- Malformed, duplicate, unsafe, over-budget, or inconsistent payloads are rejected with diagnostics.
- OpenCode API continuation behavior remains irrelevant to the MVP.
