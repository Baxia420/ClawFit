# ClawFit Identity & Multi-User Architecture (Stage 1 Foundation)

This document details the identity, household, external identity, and data ownership foundation introduced in ClawFit Stage 1.

---

## 1. Domain Entities & Identity Model

ClawFit was initially designed as an implicit single-user personal fitness tracker. Stage 1 refactors the persistence and domain foundation into an explicit user-owned architecture while preserving 100% of historical records and existing single-user runtime behavior.

### A. The ClawFit User (`users`)
- Represents an explicit person within the ClawFit system.
- Each user has a stable UUID (`id`), a `displayName`, a `role` (`primary` or `partner`), an `active` status flag, and audit timestamps (`createdAt`, `updatedAt`).
- No personal names or credentials are hardcoded into domain/runtime code. Runtime logic operates strictly on generic UUIDs.
- Well-known deterministic UUIDs are established for bootstrapping:
  - **Primary User**: `00000000-0000-0000-0000-000000000002` (`DEFAULT_PRIMARY_USER_ID`)
  - **Partner User**: `00000000-0000-0000-0000-000000000003` (`DEFAULT_PARTNER_USER_ID`)

### B. The Household Concept (`households` & `household_members`)
- To support current independent tracking, partner onboarding, and eventual shared visibility, users belong to a `household`.
- `households`: `id` (UUID), `name`, timestamps. Default household ID: `00000000-0000-0000-0000-000000000001` (`DEFAULT_HOUSEHOLD_ID`).
- `household_members`: Maps `household_id` and `user_id` with roles (`owner`, `member`).
- Ensures users can be grouped into a single unit for future shared aggregation without destroying data ownership boundaries.

### C. External Identity Abstraction (`external_identities`)
- Bridges external chat providers (e.g. WhatsApp) to internal ClawFit users.
- Attributes:
  - `userId`: Foreign key to `users.id` (cascade delete).
  - `provider`: Channel identifier (e.g. `whatsapp`).
  - `externalIdentifier`: Channel-specific unique identifier (e.g. E.164 phone `+60123456789` or WhatsApp JID/LID).
  - `metadata`: JSONB store for channel-specific context (e.g. push name, verified status).
- **Multiple Aliases per User**: The schema enforces a unique constraint on `(provider, external_identifier)` so each channel identifier maps to exactly one ClawFit user, while allowing multiple aliases (e.g. an E.164 phone and a WhatsApp LID JID) to map to the same `userId`.
- Unit-tested identity resolver at the domain boundary:
  `HealthRepository.resolveUser({ provider, externalIdentifier })`
  Returns `{ resolved: true, user, externalIdentity }` or failure reason (`unknown_external_identity`, `user_inactive_or_missing`).

---

## 2. Data Ownership, Security, & Boundary Model

### Strict Explicit Repository Scoping
- All `HealthRepository` domain methods require an explicit `userId: string` as their first parameter.
- There are no optional `userId` parameters and no overloads that omit `userId`.
- The repository does **not** silently default missing user context to `DEFAULT_PRIMARY_USER_ID`. Missing user context at the repository boundary is a compile-time type error.

### Outer API Adapter Boundary
- Stage 1 intentionally does **not** expose public `x-user-id` headers or `?userId=` query parameters to API callers. Callers cannot choose or impersonate arbitrary user profiles.
- Instead, the outer API adapter (`apps/api/src/create-app.ts`) internally binds existing single-user routes to the internal primary-user compatibility context (`DEFAULT_PRIMARY_USER_ID`) and explicitly passes this ID to repository calls.
- In Stage 2, user identity will be derived securely from WhatsApp metadata (`toolContext.requesterSenderId` via `resolveUser`), and future web authentication will establish web user identity.

### Entity Scoping & Invariants

| Entity | Scoping Mechanism | Integrity Invariants |
| --- | --- | --- |
| `meals` | `user_id` (UUID, NOT NULL) | Indexed by `(user_id, occurred_at)`. Repository queries enforce user ownership. |
| `pending_meal_estimates` | `user_id` (UUID, NOT NULL) | User A cannot view, edit, cancel, or confirm User B's draft. Scope key preserved. |
| `food_presets` | `user_id` (UUID, NOT NULL) | Unique constraint per user on `(user_id, normalized_name)`. |
| `workouts` | `user_id` (UUID, NOT NULL) | **One active workout per user**: DB partial unique index on `(user_id) WHERE status = 'active'`. User A and User B can work out simultaneously. |
| `user_settings` | `user_id` (UUID PK) | Independent calorie targets, protein targets, and timezones per user. |
| `notification_preferences` | `user_id` (UUID, NOT NULL) | Unique constraint per user on `(user_id, type)`. |
| `meal_items` | via `meal_id` FK | Child table scoped through parent. |
| `exercises` / `workout_sets` | via `workout_id` FK | Child tables scoped through parent workout. |

### Migration Preservation
Migration `0004_two_user_identity.sql` creates the new identity tables, seeds the default household and users, backfills all pre-existing records to `DEFAULT_PRIMARY_USER_ID`, and makes `user_id` non-null with foreign keys and unique constraints. Zero historical records are deleted.

---

## 3. Drizzle Migration Metadata Strategy

- **Runtime Migration Authority**: Runtime migrations in production (`packages/db/src/migrate.ts`) and embedded test environments (`packages/db/src/client.ts`) execute raw SQL files from `packages/db/drizzle/*.sql` sequenced by `_journal.json`. They do not depend on AST snapshot files.
- **Authoritative Snapshot Baseline (0004)**: Because snapshots `0001`–`0003` were absent from the repository, running `drizzle-kit generate` would fall back to diffing against `0000_snapshot.json` and attempt to regenerate historical tables. We resolved this by using Drizzle Kit's own introspection engine to produce the canonical `0004_snapshot.json` AST representing the complete schema at migration 0004, linked back to `0000_snapshot.json`.
- **Future Migration Safety (0005+)**: Running `pnpm db:generate` now cleanly diffs against `0004_snapshot.json`, reporting `No schema changes, nothing to migrate` and guaranteeing that future migrations will only contain new incremental changes.

---

## 4. WhatsApp Group Sender Resolution (OpenClaw Investigation)

Investigation of the installed environment (`openclaw@2026.7.1-2` and `@openclaw/whatsapp`):
- In WhatsApp direct messages: `msg.key.remoteJid` is `<phone>@s.whatsapp.net`, and `toolContext.requesterSenderId` delivers the sender's E.164 phone.
- In WhatsApp groups: `msg.key.remoteJid` is the group JID (`<groupId>@g.us`), while `msg.key.participant` contains the actual sender's JID (`<phone>@s.whatsapp.net` or `<lid>@lid`).
- OpenClaw resolves the individual sender and exposes it as `toolContext.requesterSenderId`.
- **Verdict**: WhatsApp group messages are **not blocked**. In Stage 2, OpenClaw tools can resolve the caller via `toolContext.requesterSenderId` and map them via `resolveUser`.

---

## 5. Future Milestones Roadmap

The following stages are explicitly future work and not implemented in Stage 1:

- **Stage 2 — Client, API, and OpenClaw User Routing**:
  - OpenClaw plugin sender extraction from `toolContext.requesterSenderId`.
  - Resolution of inbound sender to ClawFit user via `resolveUser`.
  - Route execution with user-scoped API calls.
  - Client authentication and user selection in Web client.
- **Stage 3 — Always-On OpenClaw Hosting**:
  - Transitioning OpenClaw gateway from local execution to persistent hosted infrastructure.
  - Resilient webhook delivery and socket reconnection.
- **Stage 4 — Shared Dashboard**:
  - Web UI views for viewing partner nutrition, workouts, and household streaks.
  - Permissions model for household shared data visibility.