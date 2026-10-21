# Development

Ding is a pnpm + Turborepo monorepo. **Node 22+** and **pnpm 10+** required.

## TL;DR — run it with zero infrastructure

```bash
pnpm install
pnpm dev
```

- Web app → http://localhost:5173
- API → http://localhost:3001 (health at http://localhost:3001/health)

The API boots on **in-memory fixtures** and single-node Socket.IO, so you get the
full app — sidebar, threads, routing, live send/receive — without Postgres or
Redis. Open the app in two browser tabs and send a message: it appears in both
instantly (that's the realtime loop end-to-end).

> `pnpm dev` runs the `@ding/schemas` build first (Turbo orders it), then starts
> the API and web dev servers in parallel.

## The real data path (Postgres + Redis)

```bash
cp .env.example .env      # DATABASE_URL + REDIS_URL are pre-filled for local
pnpm db:up                # start Postgres + Redis via docker-compose
pnpm db:generate          # generate the Prisma client
pnpm db:migrate           # create the schema
pnpm db:seed              # load the demo org, teams, inboxes, conversations
pnpm dev
```

Setting `DATABASE_URL` flips the API onto Postgres; setting `REDIS_URL` enables
the Socket.IO Redis adapter (multi-node realtime). Both are optional in dev.

> **Persistence is implemented (Phase 1).** The API selects its store by
> `DATABASE_URL`: unset → `MemoryStore` (fixtures); set → `PrismaStore`
> (Postgres). Both satisfy the same `Store` interface in `apps/api/src/data/`,
> so it's a config switch, not a code change. An initial migration is committed
> under `apps/api/prisma/migrations/`.

## Workspace layout

```
apps/
  api/            NestJS: REST + Socket.IO gateway, in-memory store, Prisma schema+seed
  web/            React + Vite app shell (the ported mockup, data-driven)
packages/
  schemas/        @ding/schemas — shared Zod schemas, types, realtime event contract
infra/
  railway/        deployment notes
```

## Common scripts (run from the repo root)

| Command | What it does |
|---|---|
| `pnpm dev` | Run schemas (watch) + API + web together |
| `pnpm build` | Build every package (Turbo) |
| `pnpm typecheck` | Type-check every package |
| `pnpm check:threading` | Assert where an inbound message lands (see `tools/`) |
| `pnpm check:routing` | Assert which team a new conversation is assigned to |
| `pnpm db:up` / `pnpm db:down` | Start / stop local Postgres + Redis |
| `pnpm db:migrate` / `pnpm db:seed` | Create schema / load demo data |

Per-app: `pnpm --filter @ding/api dev`, `pnpm --filter @ding/web dev`.

## API surface (Phase 0)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe |
| GET | `/api/me` | Current (demo) user + teams |
| GET | `/api/views` | Sidebar model: My Space + Shared inboxes with counts |
| GET | `/api/inboxes` | Inboxes the user can access |
| GET | `/api/conversations?view=` | Conversations for a view (`inbound`, `mine`, `grabs`, `mentions`, `team:<id>`, `inbox:<id>`) |
| GET | `/api/conversations/:id` | A conversation with its messages |
| POST | `/api/conversations/:id/messages` | Send a message (emits `message.created`; WhatsApp replies dispatch through the provider) |
| POST | `/api/conversations/:id/assign` | Assign / route (emits `conversation.assigned`) |
| GET | `/api/channels/whatsapp/webhook` | Meta webhook verification handshake |
| POST | `/api/channels/whatsapp/webhook` | Inbound messages + delivery statuses |
| POST | `/api/channels/email/webhook` | Inbound email (Postmark-style), threaded by Message-ID |
| POST | `/api/groups` | Create a WhatsApp group space (admins/managers) |
| POST | `/api/groups/:id/participants` | Add a member (enforces the 8-member cap) |
| DELETE | `/api/groups/:id/participants/:contactId` | Remove a member |

Realtime events (Socket.IO) are defined in `packages/schemas` under
`ServerEvent` / `ClientEvent`.

## Auth (Phase 3)

Real session auth: email + password → bcrypt-verified → a signed JWT in an
**httpOnly cookie**. A global `AuthGuard` validates the cookie and sets the
current user (read via `@CurrentUserId()`); routes are protected by default,
with `@Public()` marking login, `/health`, and the channel webhooks. The
`AuthService` is the seam where SSO (WorkOS/Clerk) drops in later.

- **Sign in** with any seeded user, password `ding1234` (set via
  `AUTH_DEV_PASSWORD`): `nathan@hermolis.com` (admin), `james@hermolis.com`,
  `amara@hermolis.com`.
- Endpoints: `POST /api/auth/login`, `POST /api/auth/logout`,
  `GET /api/auth/session`.
- The web app gates on `GET /api/auth/session` — unauthenticated shows the login
  screen; the avatar menu signs out.
- **Two-factor is mandatory**: a signed-in user who hasn't enrolled is held at
  the setup gate. To skip it locally set `AUTH_REQUIRE_2FA=false` — the API
  reports the policy on the session response (`twoFactorEnforced`) and the web
  app follows it. The flag is **ignored in production**, and it only turns off
  forced *enrolment*: a user who has already enrolled is still asked for a code
  at login, in dev too.

## Create an inbox

`POST /api/inboxes` (admins/managers only) creates and routes a new inbox
(WhatsApp number, group, or email address) — wired to the sidebar's
**+ New inbox & route** button.

## WhatsApp channel (Phase 1)

Inbound WhatsApp messages arrive at the webhook, are normalized, unified to a
contact, opened as a conversation, **routed** (per-customer owner → round-robin
→ up-for-grabs), and pushed live. Outbound replies dispatch through the
`WhatsAppCloudProvider`.

**Mock by default.** With no `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`, the
provider fakes sends and progresses delivered/read so the whole loop works with
zero credentials. Set both (plus `WHATSAPP_APP_SECRET` to enforce webhook
signatures) to go live against the Cloud API.

**Try it against a running API:**

```bash
# simulate an inbound customer message
node tools/simulate-whatsapp.mjs "447700900123" "Jordan Fields" "Hi, need a quote"

# then reply from the app UI (or POST /api/conversations/:id/messages) and
# simulate a delivery receipt for the returned wamid:
node tools/simulate-whatsapp.mjs --status wamid.mock_123 read
```

Point Meta's webhook at `POST /api/channels/whatsapp/webhook` with verify token
`WHATSAPP_VERIFY_TOKEN`. Map a WhatsApp number to an inbox via the inbox's
`channelConfig.phoneNumberId` (falls back to the first WhatsApp inbox in dev).

## WhatsApp groups (Phase 4)

Official WhatsApp **group spaces** (≤8 members). A group is a `whatsapp_group`
conversation with a participant list, an invite link, and a `channelRef` (the
group id).

- **Create**: `POST /api/groups { inboxId, name, members: [{ phone, name? }] }`
  (admins/managers) — provisions the group (mock unless WhatsApp is live), stores
  the invite link, adds participants, and routes it. The **8-member cap** is
  enforced on create and add.
- **Manage** members from the conversation's context panel, or via
  `POST /api/groups/:id/participants` and `DELETE /api/groups/:id/participants/:contactId`.
- **Inbound**: group messages are matched to the group by id and attributed to
  the sending member; `group_participants_update` webhooks keep the roster live.

Simulate group traffic (use the conversation's `channelRef` as `<groupRef>`):

```bash
node tools/simulate-group.mjs msg  <groupRef> "447700900999" "Priya" "Morning all!"
node tools/simulate-group.mjs join <groupRef> "447700900888" "Sam"
node tools/simulate-group.mjs leave <groupRef> "447700900888"
```

## Email shared inboxes (Phase 2)

Email is a first-class channel through the **same** ingest/route/dispatch path
as WhatsApp — an email inbox is just an `Inbox` of type `email` owned by a team.
Inbound email is matched to a conversation by **Message-ID / References**
(threading); a new thread is routed like any other conversation. Outbound
replies go through the `EmailProvider`, which mints an RFC `Message-ID` (stored
as the message's `channelMsgId`) and sets `In-Reply-To`/`References` so the
customer's reply threads back.

**Mock by default.** With no `POSTMARK_TOKEN`, sends are logged, not delivered.
Set it (plus `EMAIL_FROM`/`EMAIL_DOMAIN`) to send for real via Postmark. Point a
Postmark **inbound** webhook at `POST /api/channels/email/webhook` (optionally
guarded by `?token=EMAIL_INBOUND_TOKEN`).

**Try it against a running API:**

```bash
# inbound email → lands in the support@ shared inbox, routed to a team
node tools/simulate-email.mjs "sam@acme.co.uk" "Sam Rivera" "support@hermolis.com" "Quote request" "Can you quote weekly collections?"

# reply from the app, then simulate the customer's threaded follow-up by
# passing the reply's Message-ID (its channelMsgId):
node tools/simulate-email.mjs "sam@acme.co.uk" "Sam Rivera" "support@hermolis.com" "Re: Quote request" "One more thing…" --in-reply-to "<ding.conv_x.123@hermolis.com>"
```
