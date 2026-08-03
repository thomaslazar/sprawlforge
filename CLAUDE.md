# CLAUDE.md

## Main rule
- Be brief.
- Every answer to the user must start by addressing them as **Mr. Johnson**.
  (Shadowrun wink; doubles as a context-rot canary — if answers stop starting
  with "Mr. Johnson", context has degraded.)

## What this is
SprawlForge — free, static web toolkit for cyberpunk TTRPGs (system-agnostic,
Shadowrun-friendly via flavor packs). Core: procedural map generators
(metroplex → sector → battlemap, plus node maps) with deterministic
hierarchical seeding. Client-side only, no backend, no accounts.
See `docs/specs/` for design docs.

## Git conventions
- **Ask before committing** after ad-hoc or exploratory changes — report what
  changed, then ask. Exception: when executing a pre-approved implementation
  plan whose tasks specify commit messages, commit per the plan without
  pausing each task (the plan is the approval). Never autonomous for amends,
  force pushes, or commits to `main`.
- **Conventional Commits**: `type: subject` — `feat`, `fix`, `docs`, `test`,
  `ci`, `refactor`, `chore`.
- Subject: imperative, lowercase, no period, max ~72 chars.
- Body (optional): explain *why*, not *what*. Wrap at 72 chars.
- Do NOT add `Co-Authored-By:` or "Generated with Claude Code" lines to any
  commit message or PR body.
- After `gh pr create`, present the PR URL as a clickable link.
- **Specs and implementation go on a dedicated branch**, merged into `main`
  via PR — never committed to `main` directly. Keep a spec's follow-up edits
  and its implementation on that branch so design and delivery are reviewed
  as one unit. Never autonomous for amends, force pushes, or commits to
  `main`.

## Docs conventions
- **Specs** go in `docs/specs/YYYY-MM-DD-<topic>-design.md`, **plans** in
  `docs/plans/YYYY-MM-DD-<topic>.md` — never `docs/superpowers/…`, whatever a
  skill defaults to.
- `docs/ROADMAP.md` holds deferred features and explicit v1 excludes so they
  don't get lost.
- When an `ARCHITECTURE.md` exists, keep it a **map, not a diary**: bird's-eye
  structure, code map, invariants, deliberate exceptions. No per-feature
  entries, no implementation walkthroughs — those belong in code comments,
  ROADMAP, or the changelog.

## Hard rules
- **Metric only.** Real-world measurements everywhere (km, m). No imperial
  units in code, UI, docs, or exports. Ever.

## Repo layout
- `temp/` is gitignored — put ephemeral/scratch files there, never in the
  repo tree.
