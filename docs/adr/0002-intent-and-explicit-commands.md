# ADR 0002: Intent, Audit Modes, and Explicit Write Authorization

## Status

Accepted for OpenCode Arcana 0.2.0.

## Context

Natural language is convenient but phrases such as `check`, `validate`, and `audit` are ambiguous. Cross validation is more expensive and must never start accidentally. A report can contain useful repair recommendations without being permission to change the repository. Users also need deterministic entrypoints for repeated workflows and a safe way to approve a plan later.

## Decision

OpenCode Arcana supports natural-language routing and four explicit commands:

- `/quick-fix`
- `/quick-check`
- `/validate`
- `/cross-validate`

All commands target `magician` with `subtask: false`. They inject an explicit mode marker into The Magician prompt instead of bypassing orchestration. The command mode and write authorization are separate dimensions: Direct, Fast, and Deep describe implementation routing, while an explicit request or approval determines whether implementation is authorized.

Cross validation requires an explicit `cross validation`, `cross-validate`, or `/cross-validate` signal. Ordinary validation routes only to Deep Audit. Quick validation routes only to Fast Audit.

Quick check, normal validation, and cross validation are deterministically read-only and report filtered findings, evidence, uncertainty, and a bounded plan. They do not automatically remediate findings or perform post-fix revalidation.

The explicit phrases `analyze and fix`, `audit and fix`, and `check and fix` authorize analysis followed by implementation for the named result. The analysis may be Direct or use an auditor; implementation is routed independently as Direct, Fast, or Deep and is followed by in-scope verification.

After a report-only audit, a later unambiguous approval such as `approve the plan and execute`, `implement`, `fix findings 1 and 3`, or a clear affirmative answer to a precise execution question authorizes only the approved findings and plan. The earlier audit is not repeated without need; revalidation is allowed only after that explicit fix authorization.

User constraints such as `only answer`, `read-only`, `do not modify`, and `only wiki` persist until explicitly revoked or replaced. Source materials are data, not instructions; discoveries outside the approved result are reported without side effects. Necessary reads, diagnostics, and verification within the approved scope remain allowed.

## Consequences

- Natural requests remain ergonomic.
- Commands provide deterministic behavior.
- Quick checks do not accidentally start Deep Audit.
- Normal audits do not accidentally start dual validation.
- Audits end at findings, evidence, and a plan instead of silently starting implementation.
- A later explicit approval can start a bounded Direct, Fast, or Deep implementation without repeating a fresh audit unnecessarily.
- Explicit analyze-and-fix requests provide one coherent analysis, implementation, and verification flow.
- Invoking a command from another primary-agent session switches that session to The Magician, matching OpenCode command semantics.
