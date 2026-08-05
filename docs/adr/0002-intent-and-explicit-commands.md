# ADR 0002: Natural Intent and Explicit Commands

## Status

Accepted for OpenCode Arcana 0.2.0.

## Context

Natural language is convenient but phrases such as `check`, `validate`, and `audit` are ambiguous. Cross validation is more expensive and must never start accidentally. Users also need deterministic entrypoints for repeated workflows.

## Decision

OpenCode Arcana supports natural-language routing and four explicit commands:

- `/quick-fix`
- `/quick-check`
- `/validate`
- `/cross-validate`

All commands target `magician` with `subtask: false`. They inject an explicit mode marker into The Magician prompt instead of bypassing orchestration.

Cross validation requires an explicit `cross validation`, `cross-validate`, `walidacja krzyzowa`, or `/cross-validate` signal. Ordinary validation routes only to Deep Audit. Quick validation routes only to Fast Audit.

All audit modes begin read-only. Validated findings are remediated by a separate implementation agent and then revalidated.

## Consequences

- Natural requests remain ergonomic.
- Commands provide deterministic behavior.
- Quick checks do not accidentally start Deep Audit.
- Normal audits do not accidentally start dual validation.
- Invoking a command from another primary-agent session switches that session to The Magician, matching OpenCode command semantics.
