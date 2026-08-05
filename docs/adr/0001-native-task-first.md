# ADR 0001: Native Task First

## Status

Accepted for OpenCode Arcana 0.2.0.

## Context

OpenCode 1.18.13 owns child permission derivation, task depth, continuation, cancellation, background jobs, result injection, and native TUI cards inside its built-in `task` tool. The public plugin API does not expose these internals for safe wrapping.

## Decision

OpenCode Arcana 0.2.0 uses native `task` for all Knight of Swords, The Hermit, Page of Swords, and Justice delegation.

The plugin does not register `fast_task`, shadow `task`, or provide fallback agents. Provider failure is reported rather than retried through another model. A substantive Knight of Swords `BLOCKED` result may be escalated to The Hermit because that is complexity routing, not availability fallback.

## Consequences

- Every delegated operation has native child-session lifecycle and TUI rendering.
- Fast and Deep models remain configurable through plugin options.
- Cross validation can use two native background tasks.
- Model availability can block work until OpenCode ships native fallback support.
- Only one Arcana implementation should be loaded at a time.

## Acceptance Scenarios

1. Small implementation starts one `knight-of-swords` native task.
2. Complex implementation starts one `hermit` native task.
3. Quick validation starts only `page-of-swords`.
4. Normal validation starts only `justice`.
5. Explicit cross validation starts both auditors in background.
6. Provider failure does not silently start another model.
7. `/subagents` navigates native child sessions.
