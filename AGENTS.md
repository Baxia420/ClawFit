# ClawFit development instructions

- Use strict TypeScript and pnpm workspace commands from the repository root.
- Keep PostgreSQL and the Health API independent of OpenClaw. OpenClaw and the web dashboard are API clients only.
- Never expose SQL, shell, filesystem, or generic HTTP tools through the health plugin.
- Validate inputs at every API and model boundary with Zod or TypeBox.
- Meal estimates are drafts until the user explicitly confirms logging. A request that already says to log counts as confirmation.
- Use idempotency keys on create operations. Corrections update existing IDs; they never create replacement records.
- All totals, volume, estimated 1RM, PRs, and rolling aggregates are computed in code, not by a model.
- Keep Google model IDs out of committed runtime configuration until `pnpm models:smoke` verifies the authenticated live catalog.
- Never use real Gemini requests in automated tests. Use injected fakes.
- Do not log secrets or persist meal images by default.
- Treat nutrition output as an estimate and preserve confidence, ranges, uncertainty, source text, and audit metadata.
- After schema changes, update the SQL migration and repository tests together.
- Before handing off, run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and the OpenClaw plugin validator.

