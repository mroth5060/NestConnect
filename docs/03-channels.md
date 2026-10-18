# 03 · Channels — WhatsApp & Email

This is the highest-risk, highest-value part of the platform. Get the channel layer right and everything above it is "just" a well-built inbox.

---

## WhatsApp

### The decision: go 100% official

There are two ways to program WhatsApp, and the choice defines the business's risk profile.

| | **Official — WhatsApp Business Platform** (Cloud API + Groups API) | **Unofficial** — Baileys / whatsapp-web.js |
|---|---|---|
| How it works | Meta-hosted APIs + webhooks, via a BSP or Meta-direct | Reverse-engineered WhatsApp Web, runs your number as a "linked device" |
| Groups | ✅ **Yes** — official Groups API (2026), ≤8 members | ✅ Yes, any size |
| Compliance | ✅ Within Terms of Service | ❌ **Violates** Terms of Service |
| Ban risk | Low (policy-governed, quality-rated) | **High** — field data: numbers banned in **2–8 weeks**; 68% of surveyed SMBs banned within 12 months |
| Support / SLA | ✅ Official | ❌ None; community libraries |
| Scale & reliability | ✅ Built for it | ❌ Fragile; breaks on WhatsApp Web changes |
| Cost | Per-message fees + BSP markup | "Free" but you pay in bans and rebuilds |

**Recommendation: official only.** Until 2026 the killer objection to "official" was *no group support* — which is exactly what Swiftee needs. That objection is now gone: Meta shipped an official **Groups API**. So we get groups **and** stay compliant. Betting Swiftee's primary channel on a library that gets numbers banned in weeks is not a trade worth making.

### WhatsApp Groups API — what we can and can't do (2026)

The official Groups API lets an approved business **create, manage, and message small WhatsApp groups programmatically**:

- **≤ 8 members per group** — small, high-touch rooms by design (not community broadcast).
- **Up to 10,000 groups per business number** — plenty of parallel client rooms.
- **Members join via invite link** the business sends.
- Business can **pin messages**, **remove participants**, and receive **group webhooks**: `group_lifecycle_update`, `group_participants_update`, `group_settings_update`, `group_status_update`.
- **Supported message types:** text, media, text-based templates, media-based templates.
- **Eligibility:** requires an **Official Business Account (OBA)**. **Not** available on the consumer WhatsApp Business app, nor on numbers onboarded to *Multi-solution Conversations*.

> ⚠️ **Validate before Phase 4:** the **8-member cap** is the gating constraint. It comfortably fits *client + a couple of their people + a couple of Swiftee reps*. If Swiftee's real groups are bigger (community-style), there is **no compliant path** and we'd re-scope that requirement. **Confirm the actual group size first.**

### 1:1 messaging rules (Cloud API)

- **The 24-hour customer service window.** When a customer messages you, a 24-hour window opens in which you can reply with **free-form** messages. Outside it, you may only send **pre-approved message templates**.
- **Templates (HSM)** must be submitted to and approved by Meta, and are categorized **Marketing / Utility / Authentication**. The composer in Nest Connect is window-aware: inside the window it's free text; outside it, it offers only approved templates and explains why (see [`docs/01-product-and-ux.md`](01-product-and-ux.md)).
- **Templates are per WhatsApp account (WABA), not per number.** Every number on an account shares its templates, and no number can send another account's. Settings › Templates has a tab per account, naming its numbers:
  - **New template** submits it to Meta for approval on that account (`POST /{waba}/message_templates`, with an example for each variable). It is kept only if Meta accepts the submission, and shows *Pending review* until Meta decides.
  - **Delete** deletes it at Meta too (by `hsm_id`, so only that language goes); otherwise the next sync would bring it back.
  - **Edit** changes only what the variables pre-fill with. The name and wording are what Meta approved; to change them, create a new template.
  - **Not linked to an account** lists templates made here but never submitted. They are hidden from the composer and broadcasts of any number that has an account, refused if sent from one anyway, and can be submitted to an account or deleted. (A number with no account configured still sees everything.)
  - **Sync** runs by itself: soon after an account is first seen, then hourly, and every 10 minutes while one of its templates is waiting on review (`TemplatesService.sweep`; the last sync per account is the workspace setting `wa_templates_synced_at:{waba}`). Demo workspaces are skipped. *Sync from Meta* still runs it on demand.
  - Checks: `pnpm check:template-scope`, `pnpm check:template-meta`.
- **Click-to-WhatsApp / Page CTA entry** opens a **72-hour** free window (including templates).
- **Quality rating & messaging tiers** govern how many unique users you can message per day; low quality → throttling. We monitor quality signals and surface them to admins.

### The verified badge (Official Business Account)

Settings › Business profile shows each number's Official Business Account
status, read live from Meta:
- `GET /{phone-number-id}?fields=official_business_account` returns
  `oba_status`, and sometimes `status_message`.
- No field at all means nobody has applied, and reads as NOT_STARTED.

Admins and managers can apply from the same page with
`POST /{phone-number-id}/official_business_account`. It sends:
- `business_website_url`
- `primary_country_of_operation`
- `primary_language`
- optionally `parent_business_or_brand`
- up to five `supporting_links`
- optionally `additional_supporting_information`

Meta decides on the request. Independent press coverage counts most. The
number needs two-step verification, an approved display name and a
verified business. When Meta refuses, its own words are shown.

The form is offered only when nothing is live: not while a request is
PENDING, and not once it's APPROVED. Code is in
`whatsapp-management/business-profile.service.ts`; check:
`pnpm check:oba`.

### Forwarding a message to other chats

WhatsApp has no forward primitive — a forward is a fresh send of the same content
into a different chat, which is what `POST /api/conversations/:id/messages/:messageId/forward`
does. Given a list of customer ids it opens (or reuses) each one's WhatsApp
thread and sends a copy there, marked `forwarded` so both our thread and the web
and native UIs show WhatsApp's familiar "Forwarded" label.

Three things follow from that shape and are worth knowing:

- **Every target is attempted and reported separately.** The 24-hour window is
  per chat, so a forward to five customers where two windows have closed is the
  normal case, not an error. The response is one result per target and the UI
  names which ones didn't go.
- **Media is cloned, not re-uploaded.** The copy is a new attachment row pointing
  at the same stored object, so forwarding a large video costs a row. The original
  keeps working; nothing is moved.
- **Internal notes can't be forwarded**, and the server refuses them rather than
  relying on the UI to hide the option. A note is the team talking to itself, and
  a forward is the one action that would put it in front of a customer.

Capped at **5 chats** per forward, mirroring WhatsApp's own limit — the reason for
that limit (bulk forwarding reads as spam) applies to us too.

Inbound, Meta sets `context.forwarded` when a customer passes something on to us,
and we store it on the message and show the same label. It changes how an agent
should read what they're looking at.

### Pricing (as of 2026 — verify live before launch)

WhatsApp moved from conversation-based to **per-message pricing on 1 July 2025**. Each delivered **template** message is billed by **category × recipient country**:

| Category | UK rate (approx.) | Notes |
|---|---|---|
| Marketing | ~£0.038 / msg | Promotional; most expensive |
| Utility | ~low pence | Order/account updates |
| Authentication | ~low pence | OTP / login |
| **Service** (free-form in 24h window) | **Free until 1 Oct 2026** | Then billed at the utility/auth rate |

Plus your **BSP markup** (~$0.003–$0.010/msg for large BSPs). **Action:** model Swiftee's expected mix; service-window replies are free today, so cost is driven by templates and by the post-Oct-2026 change. Rates change — treat these as directional and confirm against Meta's live pricing page.

### BSP choice (decision #2)

| Option | Pros | Cons |
|---|---|---|
| **360dialog** | WhatsApp-focused, fast onboarding, transparent pricing, no per-message markup on some plans | WhatsApp-only |
| **Meta-direct** (Cloud API + Embedded Signup) | Cheapest, no middleman, full API surface | You own more onboarding/compliance plumbing |
| **Twilio** | Broad (adds SMS/voice/email later), great docs | Higher per-message cost |

**Lean 360dialog or Meta-direct** for a WhatsApp-first product. Whichever we pick, we isolate it behind a `WhatsAppProvider` adapter so switching later is a contained change.

### Onboarding a number (Embedded Signup)

Meta's **Embedded Signup** flow lets a Swiftee client (or Swiftee itself) connect a WhatsApp Business Account and phone number from inside Nest Connect, provision the number, and register webhooks — this powers **"+ Create inbox → WhatsApp"**. Requires Meta Business verification and an OBA for group features.

### Keeping the WhatsApp Business app (coexistence)

A number that already runs on the **WhatsApp Business app** can join Nest Connect without leaving the phone. Meta calls this coexistence. Adding the number the normal way fails with "This phone number is already registered to a WhatsApp account": the API wants to take the number over. Coexistence links the API to the app instead.

**Connecting.** Settings › Channels › Connect › **WhatsApp Business app**. Meta's sign-up opens in a popup and the person picks "Connect your existing WhatsApp Business app". The phone then shows a QR code; scan it in the app (Settings › Linked devices / Business platform). The browser gets a code plus the account (WABA) and number Meta onboarded, and posts them to `POST /api/channels/meta/coexistence`. The server then:

1. Swaps the code for a token. The SDK flow has no redirect URI.
2. Checks the number is in that account. It uses the number Meta named, never "the first number".
3. Refuses a number already connected to another workspace.
4. Subscribes the app to the account.
5. Creates the channel unrouted, like every one-click connect, so the admin picks the team in the editor that opens.

**Checking it really is a Business app number.** Meta's sign-up can hand back an ordinary API number even from the Business-app card: for example a number Meta judged ineligible, or a new number typed in and verified by text. The two need opposite treatment. An API number has to be registered; a Business app number must never be. So the server doesn't trust the card. It decides like this:

1. Ask Meta (`GET /{phone-number-id}?fields=is_on_biz_app`).
2. If Meta won't say, use how the sign-up finished: `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` versus a plain `FINISH`.
3. If Meta then refuses the phone's contacts with "only available to WhatsApp Business App phone numbers" (131000/10), it's an API number after all.

An ordinary number is saved as a regular WhatsApp channel, with the Register step. Connecting again puts right a channel that was wrongly flagged.

**It is never registered.** The usual API `register` step would take the number off the phone. The registration panel is replaced by a coexistence box, and `register()` refuses a coexistence channel.

**History and contacts.** Straight after connecting, the server asks Meta for the phone's contacts (`smb_app_state_sync`), then its chat history (`history`). Meta allows each **once, within 24 hours** of onboarding. Then:

- Contacts arrive on the `smb_app_state_sync` webhook. Only contacts we know by number alone are renamed; a name someone typed in Nest Connect is kept.
- History (up to 6 months) arrives on the `history` webhook in batches. Each customer gets one **closed, read** conversation holding the old messages in time order. It is never routed, assigned or put on an SLA. Re-sent batches are skipped by message id.
- If the person declined to share history on the phone, the channel says so.

**Replies from the phone.** Anything sent from the app arrives on the `smb_message_echoes` webhook. It is filed as an outbound message in the customer's open conversation, labelled **"Sent by WhatsApp Business app"**. It counts as an answer, so the SLA clock stops. It doesn't create routing or assignment on its own.

**Disconnects.** If the number is unlinked from the phone or the account is offboarded, Meta sends `account_update`. The channel shows **Reconnect needed**; connecting again from the same card repairs it in place.

**Meta-side setup (once per Meta app):**

- An Embedded Signup **configuration** that includes "WhatsApp Business app onboarding". Put its Configuration ID with the App ID and secret in Settings › Setup.
- Webhook fields on the app: `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`, `account_update`.
- Business Verification on the Meta business portfolio. Coexistence may also need Tech Provider status for the app.
- The page that runs the sign-up must allow the Facebook popup to post back. The API sends `Cross-Origin-Opener-Policy: same-origin-allow-popups`.

**Limits to know.**

- The app keeps working, but throughput on a coexistence number is lower than a pure API number (about 20 messages a second).
- Groups and disappearing messages aren't mirrored.
- The phone must open the WhatsApp Business app at least every ~14 days, or Meta unlinks it.
- Try it on a spare number before the main one.

`pnpm check:coexistence` (memory) and `pnpm check:coexistence-pg` (Postgres) cover connect, the register guard, echoes, history, contacts and disconnects.

---

## Email — shared inboxes

Email is the second first-class channel. Two connection modes cover every case:

### Mode A — Connect an existing mailbox (OAuth)

For addresses Swiftee/clients already run on **Google Workspace** or **Microsoft 365**:

- **Gmail API** (Google) / **Microsoft Graph** (365) via **OAuth 2.0**.
- **Inbound:** Gmail push via Pub/Sub watch; Graph via change-notification subscriptions (webhooks) with periodic delta sync as backstop.
- **Outbound:** send through the same API so replies come *from* the real address and thread correctly in the client's own mailbox too.
- Least friction — adopt `support@swiftee.co.uk` without changing MX records.

### When Google signs a mailbox out

A Gmail sign-in can stop working on its own: the password changed, someone
removed the app's access in their Google account, an admin policy, or a grant
Google expired. Before, nothing noticed — the channel still said Connected,
polling failed silently every minute, replies retried six times and then failed
with Google's raw error, and the fix people found was deleting the channel
(and every conversation on it) and adding it again.

Now:

- **Noticed once.** The first time Google refuses the sign-in (a refused token
  refresh — `invalid_grant` — no saved refresh token, a 401 from Gmail, or a
  scope taken away), the inbox is marked signed out, with the reason and when
  (`authError` / `authErrorAt` on its channel config; `signedOut` on the
  inbox). Polling and push skip it from then on, and a reply from it fails at
  once — "the channel needs reconnecting" — instead of retrying.
- **Flagged.** The channel's card reads **Reconnect needed**; admins and
  managers get one bell entry and push, and a banner across the top of the app
  with **Reconnect**; anyone replying on that channel is told before they write.
- **Reconnected in place.** **Reconnect** (in the banner, or the channel's
  editor) runs Google's sign-in for *that* channel (`oauth/start?inboxId=…`,
  with the address offered). It must be the same mailbox — signing in as anyone
  else is refused. The channel keeps its id, conversations, routing, name and
  signature. Adding the same address again from Add channel does the same.
- **The email it missed — your choice.** Before Google's popup, Reconnect asks
  what to do about the mail that arrived while it was out:
  - **Bring it in** (the default): it catches up from the history cursor it
    stopped at. Gmail keeps that history for about a week; when the mailbox
    was out for longer, the cursor starts again from now and the gap is swept
    by date instead — everything received and sent from a day before the
    sign-out, oldest first, through the same path as live mail (new
    conversations, replies on their threads, the usual routing and alerts).
    The sweep runs in the background, up to 5,000 messages; anything already
    in Nest is skipped by its Message-ID.
  - **Start from now** (`missed=skip`): no catch-up; what it missed stays in
    Gmail.
- **Bring in missed email…** on a connected Gmail channel's editor does the
  same sweep from a date you pick (up to 90 days back) — for a gap an earlier
  reconnect didn't cover. `POST /channels/google/inboxes/:id/missed {since}`,
  managers and admins.
- Starting a Google connection is for managers and admins, like adding any
  channel. A Gmail channel's editor no longer shows the Postmark token field
  (typing there would have overwritten its sign-in).
- `pnpm check:gmail-reauth` covers all of it, with Google faked at the network.

### Mode B — Host the address (inbound provider)

For addresses we want Nest Connect to fully own, or non-Google/MS domains:

- **Inbound:** point/forward to **Postmark inbound** (or AWS SES → SNS). Provider parses MIME and POSTs a clean JSON webhook to our email gateway.
- **Outbound:** send via **Postmark/SES SMTP or API** with proper **SPF, DKIM, DMARC** on Swiftee's domain for deliverability.
- Full control over threading and storage.

**Recommendation:** support both; start with **Mode A (Gmail/Graph OAuth)** since it's what teams already have, add **Mode B (Postmark)** for hosted addresses.

### Threading & the shared-inbox model

- **Threading** uses standard headers — `Message-ID`, `In-Reply-To`, `References` — plus subject/participant heuristics, to group emails into one Nest Connect **conversation**. Each outbound message sets/propagates these headers so replies land back in the right thread.
- **The subject decides the thread when the headers don't.** Every other channel
  is one conversation per person; a mailbox is not. "Invoice #4471" and
  "Christmas opening hours" from the same customer are two conversations, and
  filing the second onto the first buries it under whatever they last wrote
  about. So an inbound email that carries no usable `References` chain only
  joins an open conversation whose subject matches, compared with reply and
  forward prefixes stripped and case folded (`data/email-threading.ts`) — "Re:",
  "Fwd: Re:" and "Re[2]:" are all the same thread. This is a fallback, never the
  first test: a genuine reply threads on its header chain.
  - **An agent renaming a thread is safe**, twice over. The customer's reply
    carries `References` and matches before the subject is ever consulted; and
    the rename is written to the conversation, so their "Re: <new subject>"
    matches it anyway.
  - The rule is keyed on the channel, not on whether a subject happens to
    exist. A WhatsApp group carries the group's name in the same field, and
    comparing that against an inbound with no subject would fork every group
    thread on every message.
- **Identity normalisation decides who a customer *is*.** Every write path funnels
  through one function (`contacts/identity.ts`) that turns a phone or email into a
  canonical key; get-or-create matches on that key alone. For phones the key is
  the **digits of the E.164 number** — `447911123456` — with the `+` dropped
  deliberately: a number `libphonenumber` can't parse has no E.164 form, so that
  branch can only produce raw digits, and if the parsed branch kept the `+` the
  two could never match. `phone` and `wa_id` share the key, because a number is a
  number however it reached us. The rule is versioned; when it changes, boot
  re-canonicalises every stored key and merges the contacts that collapse
  together. Getting this wrong forks one customer into two contacts with two
  threads — the same failure as CC threading, arriving through the front door.
- **Threading is always scoped to a customer.** Everyone on a CC list shares one
  `References` chain, and Gmail groups their replies into one mailbox thread, so
  the headers alone say "same conversation" about messages from two different
  people. Inbound therefore matches the chain only against the sender's own
  conversations, a Gmail thread id is owned by exactly one conversation, and an
  agent's reply synced back from Gmail is matched against the customers it was
  actually addressed to. Without that, a CC'd customer's Reply-All merges into
  the original sender's thread and an agent ends up answering the wrong person.
- A **shared email inbox** is just an `Inbox` of type `email` owned by one or more teams — the *same* conversation/assignment/routing model as WhatsApp. Collision detection, internal notes, and "up for grabs" all work identically.
- **Attachments** stream to R2; large ones are linked, not inlined.
- **Signatures, quoting, CC/BCC, drafts** handled in the Tiptap composer; per-user and per-inbox signatures.

---

### Reply-To

An email can ask for replies to go somewhere other than its sender, using a
`Reply-To` header. A website form does this all the time: it sends From
`noreply@site` with Reply-To set to the visitor who filled the form in.
NestConnect treats the Reply-To address as the customer:

- **The contact** is the Reply-To address. It takes the Reply-To's display
  name. Failing that it takes the sender's name, unless the sender is an
  automated mailbox (`noreply@`, `forms@`, `wordpress@`, …), in which case
  it uses the address itself.
- **The thread** is that customer's. Each form visitor gets their own
  conversation instead of everyone landing on one "noreply" thread. When the
  visitor later writes from their own address, it joins the same thread.
- **The reply** goes to the Reply-To address, because it is the
  conversation's address.
- **The message** shows **Via** the address it actually came from, on web
  and in the app.

The header is ignored when:
- it is the sender's own address;
- it points back at our own inbox (a relay misconfiguration);
- it isn't an address at all.

When it lists several addresses, the first is the customer.

Postmark (its `ReplyTo` field, or the raw header), Gmail sync and the Gmail
import all read it (`apps/api/src/channels/email/reply-to.ts`; check:
`pnpm check:reply-to`).

## SMS — any provider, by configuration

SMS is a channel type like the others. It sits on the same conversations,
contacts, routing and composer. The provider isn't coded in: one engine
drives any SMS REST API from a declarative config. That config covers
endpoints, auth, body template, response mapping, webhooks or polling for
replies, and receipt status words. DialMyCalls (polling; it has no webhooks)
and Twilio (webhooks) ship as presets. Any other provider is filled in by
hand, or from its pasted API docs with AI. See [sms.md](sms.md).

## The channel abstraction (why the core stays clean)

Every channel implements the same two interfaces, so the domain core never special-cases a provider:

```ts
interface InboundNormalizer {
  // provider webhook  ->  canonical inbound event
  verify(req): boolean;                 // signature check
  dedupeKey(payload): string;           // idempotency (provider msg id)
  toInbound(payload): CanonicalInbound; // { channel, externalId, contact, conversationRef, body, media, ts }
}

interface ChannelProvider {
  send(msg: OutboundMessage): Promise<SendResult>;   // text/media/template
  supports(feature): boolean;   // groups? templates? richText? readReceipts?
  // group ops (WhatsApp Groups only)
  createGroup?(...): Promise<GroupRef>;
  inviteLink?(groupId): Promise<string>;
  removeParticipant?(groupId, memberId): Promise<void>;
}
```

Adapters we build: `WhatsAppCloudProvider`, `WhatsAppGroupsProvider`, `EmailGraphProvider`, `EmailGmailProvider`, `EmailPostmarkProvider`. Adding SMS/Instagram/Messenger later = another adapter, **zero** changes to conversations, routing, or the UI's inbox model.

---

## Compliance checklist (channels)

- **Opt-in / consent** management for WhatsApp (required); store proof of opt-in per contact.
- **Template governance** — submission, approval status, versioning surfaced to admins.
- **Quality-rating** monitoring + alerts; back-off on throttling.
- **Data handling** — Meta/BSP **DPA** in place; EU/UK data region; retention policy on message content (see [`docs/07-infra-security-cost.md`](07-infra-security-cost.md)).
- **Email deliverability** — SPF/DKIM/DMARC, bounce/complaint handling, unsubscribe where applicable.

---

## Sources (verify before build — this space moves fast)

- WhatsApp Groups API — [Meta for Developers: Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) · [imBee 2026 guide](https://www.imbee.io/resource/whatsapp-groups-api-business-guide-2026)
- WhatsApp pricing — [Meta: Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) · [Blueticks: per-message pricing 2026](https://blueticks.co/blog/whatsapp-business-pricing-change-2026-per-message)
- Unofficial-library ban risk — [Kraya AI: automation ban risk 2026](https://blog.kraya-ai.com/whatsapp-automation-ban-risk) · [WhatsApp Cloud API vs unofficial libraries](https://whatsapp.checkleaked.cc/blog/whatsapp-cloud-api-vs-unofficial)
