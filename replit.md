# Invite Ledger

A public shared workspace for reviewing recipient lists, configuring calendar events, and processing iCloud Calendar invitations with server-reported outcomes.

## Run & Operate

- `pnpm run dev` — run the API server and web app together (API port 3001, web port 5000 by default)
- `pnpm start` — run the built API server and web app; run `pnpm run build` first
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run test` — CalDAV response-safety tests
- `pnpm run build` — typecheck + tests + build all packages
- In Replit, use the managed `artifacts/api-server: API Server` and `artifacts/icloud-invitations: web` workflows; their ports are injected by the artifact runner.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (ESM API bundle) and Vite

## Where things live

- API contracts: `lib/api-spec/openapi.yaml`; generated client and Zod schemas live in workspace packages under `lib/`.
- Database tables: `lib/db/src/schema/`.
- Public workspace API routes: `artifacts/api-server/src/routes/`.
- CalDAV discovery and event writes: `artifacts/api-server/src/lib/icloud-caldav.ts`.
- Campaign queue processing: `artifacts/api-server/src/lib/campaign-worker.ts`.
- Web interface: `artifacts/icloud-invitations/src/`.

## Architecture decisions

- iCloud is accessed directly over CalDAV; do not substitute mocked runtime behavior or claim a connection is live without a successful account test.
- Keep attendee invitation scheduling distinct from calendar event creation. Count scheduling as server-accepted only when the CalDAV event write returns a `Schedule-Tag`; this still does not prove inbox delivery.
- Campaigns group up to the configured number of invitees into one calendar event and process groups sequentially. `eventsCreated` counts event groups, while invitation, failure, and pending counts remain per recipient.
- If the account does not advertise CalDAV scheduling, attendee campaigns are blocked. Calendar-only event creation is the explicit fallback.
- iCloud credentials remain server-side and encrypted; never expose them in API responses, browser storage, or logs.
- The workspace and API are intentionally public: anyone with the app URL can view and change recipient data, settings, and campaigns. Do not imply user-level access control.

## Product

Users can import and validate recipients, configure event and iCloud settings (including invitees per event), review campaign outcomes, pause/resume/stop processing, and inspect an activity log. Each recipient keeps an individual campaign status even when several recipients share one event.

## User preferences

Never claim an invitation reached a recipient's inbox. Report only the event creation and CalDAV scheduling response that the server actually returned.

## Gotchas

- A connected account may support calendar event creation without supporting invitation scheduling; show and respect the discovered capability.
- The public workspace uses a shared owner identity. Existing data owned by prior authenticated users must be migrated explicitly before it is expected to appear here.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
