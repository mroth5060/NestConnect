# Nest Connect — omnichannel comms platform

> A sleek, WhatsApp-native team inbox set up for **Hermolis** — kosher food and catering. Unifies **WhatsApp Business** (1:1 and small client **groups**), **shared email inboxes**, teams, routing, and (later) workflows — with realtime, multiplayer UX. Each business runs as its own organization (tenant) inside Nest Connect.
>
> _The name nods to the **NestJS** backend that powers it — a shared "nest" where every business's conversations connect._

This repository holds the **product + technical plan** _and_ a running **Phase 0 scaffold** — a pnpm/Turborepo monorepo (React app shell + NestJS API + realtime + shared schemas) that boots with zero infrastructure. Run it:

```bash
pnpm install && pnpm dev     # web → :5173, API → :3001
```

See **[DEVELOPMENT.md](DEVELOPMENT.md)** for the dev guide and the Postgres/Redis path.

---

## The 60-second summary

Nest Connect is a **team inbox** in the family of Front / Missive / Intercom / Chatwoot, but **WhatsApp-first** and built for Hermolis's way of working: every client conversation — whether it arrives on WhatsApp, in a WhatsApp group, or by email — lands in one fast, modern app where the right person or team picks it up.

**Two things make it "ours" and not a clone:**
1. **A two-section sidebar** — a personal **My Inbound** space (what's assigned to me + inbound my team hasn't picked up yet) sitting above **Shared Inboxes** (team-owned WhatsApp numbers, group spaces and email addresses you can create and route on the fly).
2. **Multiplayer, realtime everything** — WhatsApp-speed delivery, typing/read receipts, live presence and collision detection so two agents never talk over each other, plus an internal collaboration lane ("chat about the chat") beside every client thread.

## See it

An interactive concept mockup of the main screen lives at [`docs/mockups/ding-inbox.html`](docs/mockups/ding-inbox.html) — the two-section sidebar (My Space / Shared Inboxes), a live WhatsApp-style thread with an inline internal note, the channel-aware composer, and ⌘K routing. Open it in a browser; it's clickable (switch views, open conversations, press ⌘K).

## The single most important decision

**Go 100% official on WhatsApp.** As of 2026, Meta ships an official **Groups API** (small groups, ≤8 members, invite-link join, up to 10,000 groups per number). This means Swiftee's "groups with clients" requirement can be met **on the compliant WhatsApp Business Platform** — we do **not** need Baileys / whatsapp-web.js, which remain a Terms-of-Service violation and, per 2026 field data, get numbers **banned within 2–8 weeks**. Betting the business's primary channel on a ban-prone grey-market library would be a mistake. See [`docs/03-channels.md`](docs/03-channels.md).

> ⚠️ **The one thing to validate first:** official WhatsApp groups are capped at **8 members**. That's fine for high-touch client rooms (client + a couple of their people + Swiftee reps). If Swiftee needs large community groups, no compliant path exists and we'd re-scope. Confirm the real group size before Phase 4.

---

## Recommended stack (at a glance)

| Layer | Choice | Why |
|---|---|---|
| **Frontend** | React + TypeScript (Vite), Tailwind + shadcn/ui, Framer Motion, TanStack Query/Router/Virtual, Tiptap composer, cmdk (⌘K) | App-like, instant, accessible; the polish budget goes into the "WhatsApp-with-a-twist" UI |
| **Backend** | Node + TypeScript monorepo (pnpm + Turborepo), NestJS API, Socket.IO WebSocket gateway, BullMQ workers | One language end-to-end; structured for a growing platform; battle-tested realtime |
| **Data** | PostgreSQL 16 (primary), Redis (pub/sub, presence, queues, cache), Cloudflare R2 (media), Postgres FTS → Typesense (search) | Boring, proven, cheap to run; scales when we need it |
| **Channels** | WhatsApp **Cloud API + Groups API** (via 360dialog or Meta-direct BSP); Email via Gmail/Microsoft Graph OAuth + Postmark inbound/SMTP | Compliant, official, reliable threading |
| **Realtime** | Socket.IO + Redis adapter (self-host) — managed Ably/Pusher as the escape hatch | Presence, typing, read receipts, live assignment at WhatsApp speed |
| **Automation** | In-house rules engine on BullMQ → Inngest/Temporal if flows get long-running | Start simple, graduate deliberately |
| **Infra** | **Railway** (services + Postgres + Redis), Cloudflare (DNS/CDN/R2/WAF), GitHub Actions CI/CD | Matches Swiftee's existing tooling; per-PR preview envs |
| **Auth** | WorkOS or Clerk (B2B SSO/SAML + RBAC) | Enterprise-ready without building auth |
| **Observability** | OpenTelemetry + Grafana/Better Stack, Sentry, pino logs | See problems before customers do |

Full rationale and alternatives in [`docs/02-architecture.md`](docs/02-architecture.md).

---

## System context

```mermaid
flowchart LR
    subgraph Clients["Swiftee clients"]
      WA["WhatsApp 1:1"]
      WG["WhatsApp groups (≤8)"]
      EM["Email"]
    end

    subgraph Providers["Channel providers"]
      META["WhatsApp Cloud + Groups API<br/>(360dialog / Meta)"]
      MAIL["Gmail / MS Graph<br/>+ Postmark inbound/SMTP"]
    end

    subgraph NC["Nest Connect platform (Railway)"]
      GW["Channel gateways<br/>(webhook ingest)"]
      API["NestJS API + routing engine"]
      RT["Realtime gateway<br/>(Socket.IO + Redis)"]
      WK["Workers (BullMQ)<br/>send • workflows • SLA"]
      DB[("PostgreSQL")]
      RD[("Redis")]
      R2[("R2 media")]
    end

    Agents["Swiftee agents & teams<br/>(web app / PWA)"]

    WA <--> META
    WG <--> META
    EM <--> MAIL
    META <--> GW
    MAIL <--> GW
    GW --> API
    API <--> DB
    API <--> RD
    API --> WK
    WK <--> META
    WK <--> MAIL
    API --> RT
    RT <--> Agents
    API <--> R2
```

---

## How to read these docs

Read in order for the full story, or jump to what you need:

| # | Doc | What's inside |
|---|---|---|
| 01 | [Product & UX](docs/01-product-and-ux.md) | Vision, personas, the "twist", the two-section sidebar spec, screens & interactions |
| 02 | [Architecture & Tech](docs/02-architecture.md) | Full tech map, service architecture, realtime/event model, sequence diagrams |
| 03 | [Channels](docs/03-channels.md) | WhatsApp (Cloud + Groups API, templates, windows, pricing) and Email (shared inboxes, threading) |
| 04 | [Data Model](docs/04-data-model.md) | Entities, ER diagram, conversation state machine, multi-tenancy, identity resolution |
| 05 | [Routing, Teams & Workflows](docs/05-routing-teams-workflows.md) | Teams, inboxes, routing engine, **My Inbound** semantics, automation engine |
| 06 | [Roadmap](docs/06-roadmap.md) | Phased delivery, milestones, team shape, timeline |
| 07 | [Infra, Security & Cost](docs/07-infra-security-cost.md) | Railway infra, UK GDPR + WhatsApp compliance, observability, cost model |

---

## Open decisions to confirm before build

1. **Real WhatsApp group size** — does ≤8 members cover Swiftee's client groups? (Gates Phase 4.)
2. **BSP** — 360dialog (fast, WhatsApp-focused) vs Meta-direct (cheapest, more setup) vs Twilio (broad, pricier).
3. **Realtime** — self-hosted Socket.IO+Redis (chosen default, full control) vs managed Ably/Pusher (less ops, per-message cost).
4. **Build bespoke vs fork Chatwoot** — bespoke recommended for the UX bar Swiftee wants; the decision is argued in [`docs/02-architecture.md`](docs/02-architecture.md).
5. **Auth vendor** — WorkOS vs Clerk vs self-hosted.

_These are the forks that change what we build next; everything else is reversible._
