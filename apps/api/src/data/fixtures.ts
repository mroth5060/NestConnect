import type {
  Conversation,
  Contact,
  Inbox,
  Message,
  Participant,
  Team,
  Template,
  User,
} from "@ding/schemas";

/**
 * Demo seed data for Phase 0. The API serves this from an in-memory store so
 * the whole stack runs with zero infrastructure. The same shapes come out of
 * Postgres once the Prisma repository is wired in (see prisma/schema.prisma).
 */

// The internal id predates the Hermolis rebrand and is kept on purpose: it is
// never shown, and an existing database keys every row on it.
export const ORG_ID = "org_swiftee";
export const DEMO_USER_ID = "usr_nathan";

/* ---- demo media (data-URI backed, so it renders with no object storage) ---- */
const DEMO_PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#0284c7"/></linearGradient></defs><rect width="480" height="360" fill="url(#g)"/><rect x="26" y="26" width="428" height="308" rx="16" fill="#ffffff" opacity="0.10"/><text x="50%" y="50%" font-family="system-ui,Arial" font-size="26" fill="#ffffff" text-anchor="middle" opacity="0.94">Kiddush platters — 8 trays</text></svg>`;
const DEMO_PHOTO_URL = `data:image/svg+xml;base64,${Buffer.from(DEMO_PHOTO_SVG).toString("base64")}`;

/** A short silent WAV so the voice-note player has something real to play. */
function silentWav(ms: number): string {
  const rate = 8000;
  const n = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc(44 + n);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n, 40);
  buf.fill(128, 44);
  return `data:audio/wav;base64,${buf.toString("base64")}`;
}
const DEMO_VOICE_URL = silentWav(3200);
const DEMO_WAVEFORM = Array.from({ length: 34 }, (_, i) => Number((0.28 + 0.6 * Math.abs(Math.sin(i * 0.7))).toFixed(2)));
const DEMO_DOC_URL = `data:text/plain;base64,${Buffer.from(
  "Hermolis — Purchase Order 4471\nMaple Road Shul\n8× kiddush platter (parev), Friday 11am delivery.\n",
).toString("base64")}`;

const DEMO_IMAGE_ATT: Message["attachments"] = [
  { id: "att_demo_img", kind: "image", mime: "image/svg+xml", size: 18234, filename: "kiddush-platters.png", url: DEMO_PHOTO_URL, width: 480, height: 360 },
];
const DEMO_VOICE_ATT: Message["attachments"] = [
  { id: "att_demo_voice", kind: "voice", mime: "audio/wav", size: 41230, filename: "voice-message.ogg", url: DEMO_VOICE_URL, durationMs: 3200, waveform: DEMO_WAVEFORM },
];
const DEMO_DOC_ATT: Message["attachments"] = [
  { id: "att_demo_doc", kind: "document", mime: "text/plain", size: 248123, filename: "Purchase-Order-4471.txt", url: DEMO_DOC_URL },
];

/** A conversation plus its message history, as held in the store. `waWindow` is
 *  derived at read time from `lastInboundAt`, so it isn't stored on the record. */
// `assigneeName` is a display field resolved from `assigneeUserId` at summary
// time — the stored record keeps only the id, never the denormalised name.
export type ConversationRecord = Omit<
  Conversation,
  "snoozedUntil" | "unreadCount" | "waWindow" | "assigneeName"
> & {
  snoozedUntil?: string | null;
  unreadCount?: number;
  /** Most recent inbound message time (drives the WhatsApp 24-hour window). */
  lastInboundAt?: string | null;
  messages: Message[];
  participants?: Participant[];
};

const now = new Date();
const mins = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
// A timestamp on the calendar day `d` days before today at local hh:mm, so the
// flagship demo thread visibly spans "2 days ago / Yesterday / Today" and the
// date dividers roll over the way WhatsApp's do.
const dayAt = (d: number, hh: number, mm: number) => {
  const t = new Date(now);
  t.setHours(hh, mm, 0, 0);
  t.setDate(t.getDate() - d);
  return t.toISOString();
};

const LABEL = {
  vip: { id: "lbl_vip", name: "VIP", color: "#0FA47A" },
  delivery: { id: "lbl_delivery", name: "Delivery", color: "#E68A00" },
  billing: { id: "lbl_billing", name: "Billing", color: "#5B8DEF" },
  order: { id: "lbl_order", name: "Order", color: "#0FA47A" },
  onboarding: { id: "lbl_onboarding", name: "Onboarding", color: "#A06CF2" },
  resolved: { id: "lbl_resolved", name: "Resolved", color: "#8A968F" },
};

export function makeSeed() {
  const users: User[] = [
    { id: DEMO_USER_ID, orgId: ORG_ID, name: "Nathan A", email: "nathan@hermolis.com", role: "admin", avatarColor: "#3B82F6", online: true, available: true },
    { id: "usr_james", orgId: ORG_ID, name: "James", email: "james@hermolis.com", role: "agent", avatarColor: "#0EA5E9", online: true, available: true },
    { id: "usr_amara", orgId: ORG_ID, name: "Amara", email: "amara@hermolis.com", role: "agent", avatarColor: "#F43F5E", online: false, available: true },
  ];

  const teams: Team[] = [
    { id: "team_support", orgId: ORG_ID, name: "Support team", icon: "headset", order: 0, slaMinutes: 60 },
    { id: "team_sales", orgId: ORG_ID, name: "Sales team", icon: "cart", order: 1, slaMinutes: 240 },
  ];

  // Demo "me" (Nathan) belongs to both teams.
  const membership: Record<string, string[]> = {
    [DEMO_USER_ID]: ["team_support", "team_sales"],
    usr_james: ["team_support"],
    usr_amara: ["team_sales"],
  };

  const inboxes: Inbox[] = [
    { id: "inbox_wa", orgId: ORG_ID, type: "whatsapp", name: "+44 20 7946", handle: "+44 20 7946 0100", teamIds: ["team_support"], routingStrategy: "manual", isDefault: false, order: 0, unread: 2 },
    { id: "inbox_support", orgId: ORG_ID, type: "email", name: "support@hermolis.com", handle: "support@hermolis.com", teamIds: ["team_support"], routingStrategy: "round_robin", isDefault: false, order: 0, unread: 1 },
    { id: "inbox_hello", orgId: ORG_ID, type: "email", name: "orders@hermolis.com", handle: "orders@hermolis.com", teamIds: ["team_sales"], routingStrategy: "round_robin", isDefault: false, order: 0, unread: 0 },
  ];

  const c = (contact: Omit<Contact, "tags"> & { tags?: string[] }): Contact => ({
    tags: [],
    ...contact,
  });
  const contacts = {
    ivy: c({ id: "ct_ivy", orgId: ORG_ID, displayName: "Maple Road Shul", company: "Synagogue · London NW11", phone: "+44 20 8455 0122", email: "office@mapleroadshul.org.uk", avatarColor: "#F97316", tags: ["Key account", "Kiddush"] }),
    north: c({ id: "ct_north", orgId: ORG_ID, displayName: "Northwood Care Home", company: "Care home · London HA6", phone: "+44 20 3555 0148", email: "accounts@northwoodcare.co.uk", avatarColor: "#0EA5E9", tags: ["Contract", "Net-30"] }),
    bloom: c({ id: "ct_bloom", orgId: ORG_ID, displayName: "Oakwood Jewish Primary", company: "School · London NW4", phone: "+44 20 8555 0193", email: "kitchen@oakwoodprimary.org.uk", avatarColor: "#10B981", tags: ["School meals"] }),
    harbour: c({ id: "ct_harbour", orgId: ORG_ID, displayName: "Heathside Hotel", company: "Hotel · London NW3", phone: "+44 20 7555 0176", email: "events@heathsidehotel.co.uk", avatarColor: "#6366F1", tags: ["Events"] }),
    acme: c({ id: "ct_acme", orgId: ORG_ID, displayName: "Rachel Levy", company: "Bar mitzvah · June", phone: "+44 7700 900110", email: "rachel.levy@example.co.uk", avatarColor: "#F59E0B", tags: ["Simcha"] }),
    tide: c({ id: "ct_tide", orgId: ORG_ID, displayName: "Shefa Fresh Produce", company: "Supplier · London E5", phone: "+44 20 8555 0166", email: "team@shefafresh.co.uk", avatarColor: "#14B8A6", tags: ["Supplier", "New lead"] }),
  };

  // Members of the demo WhatsApp group "Maple Road Shul" (shul office + committee + a Hermolis rep).
  const ivyMembers: Contact[] = [
    c({ id: "ct_priya", orgId: ORG_ID, displayName: "Miriam · Shul office", phone: "+44 20 8455 0122", avatarColor: "#F97316" }),
    c({ id: "ct_marco", orgId: ORG_ID, displayName: "David · Kiddush committee", phone: "+44 7700 900140", avatarColor: "#8B5CF6" }),
    c({ id: "ct_jamesg", orgId: ORG_ID, displayName: "James · Hermolis", phone: "+44 20 7946 0100", avatarColor: "#0EA5E9" }),
  ];

  let mid = 0;
  const msg = (
    conversationId: string,
    seq: number,
    direction: "in" | "out",
    authorType: "contact" | "user" | "system",
    authorName: string,
    body: string,
    minsAgo: number,
    opts: {
      internal?: boolean;
      status?: Message["status"];
      at?: string;
      messageType?: Message["messageType"];
      attachments?: Message["attachments"];
      reactions?: Message["reactions"];
      quotedMsgId?: string;
      bodyHtml?: string;
      email?: Message["email"];
    } = {},
  ): Message => ({
    id: `msg_${++mid}`,
    conversationId,
    seq,
    direction,
    authorType,
    authorName,
    body,
    bodyHtml: opts.bodyHtml,
    status: opts.status ?? (direction === "out" ? "read" : "delivered"),
    internal: opts.internal ?? false,
    messageType: opts.messageType ?? "text",
    attachments: opts.attachments ?? [],
    reactions: opts.reactions ?? [],
    quotedMsgId: opts.quotedMsgId,
    email: opts.email,
    createdAt: opts.at ?? mins(minsAgo),
  });

  // The Maple Road Shul group thread — showcases a reaction and quoted replies. Built
  // as a list first so later messages can reference an earlier one's generated id.
  const ivyMsgs: Message[] = [
    msg("conv_ivy", 1, "in", "contact", "Miriam (Maple Road Shul)", "Morning! Are we still on for the kiddush delivery this Friday?", 0, { at: dayAt(2, 9, 2) }),
    msg("conv_ivy", 2, "out", "user", "Nathan A", "Morning Miriam 👋 Yes — you're booked in. I'll confirm the slot shortly.", 0, { at: dayAt(2, 9, 8), reactions: [{ emoji: "👍", by: "contact" }] }),
    msg("conv_ivy", 3, "in", "contact", "Miriam (Maple Road Shul)", "Amazing. One change — could you bring it forward to 11am? Shabbat comes in early this week.", 0, { at: dayAt(1, 13, 20) }),
    msg("conv_ivy", 4, "out", "user", "James", "@nathan can the NW London van take an 11am Friday drop for the shul? Early Shabbat their end.", 0, { internal: true, at: dayAt(1, 13, 24) }),
    // One reaction on each side of the thread, so the pill's mirroring is
    // visible in the demo: theirs on our message above, ours on theirs here.
    msg("conv_ivy", 5, "in", "contact", "James · Hermolis", "Yep, 11am works — I'll re-slot the van now. 👍", 35, { reactions: [{ emoji: "❤️", by: "user" }] }),
    msg("conv_ivy", 6, "in", "contact", "Miriam (Maple Road Shul)", "Same platters as last time please 👇", 30, { messageType: "image", attachments: DEMO_IMAGE_ATT }),
    msg("conv_ivy", 7, "in", "contact", "Miriam (Maple Road Shul)", "", 29, { messageType: "voice", attachments: DEMO_VOICE_ATT }),
    msg("conv_ivy", 8, "in", "contact", "Miriam (Maple Road Shul)", "And the PO for your records", 28, { messageType: "document", attachments: DEMO_DOC_ATT }),
  ];
  // Nathan's confirmation replies to Miriam's opening question (and she 👍'd it);
  // James's "11am works" quotes Miriam's request to move the slot.
  ivyMsgs[1].quotedMsgId = ivyMsgs[0].id;
  ivyMsgs[4].quotedMsgId = ivyMsgs[2].id;

  // A formatted inbound email (already in the sanitized shape the ingest pipeline
  // produces): a hero image blocked as a remote src, a styled table and a button.
  const bloomEmailHtml = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2b2b2b">
  <div style="background:#0f766e;padding:16px 20px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;color:#ffffff;font-size:18px">Oakwood Primary — Weekly Lunch Order</h2>
    <p style="margin:4px 0 0;color:#c9f2ec;font-size:13px">PO #YP-2288 · Delivery Monday AM</p>
  </div>
  <img data-blocked-src="https://images.example.com/oakwood/this-week.jpg" alt="This week's menu" width="560" style="width:100%;max-width:560px;display:block">
  <div style="padding:14px 20px">
    <p>Hi Hermolis team,</p>
    <p>Here's this week's order — <b>same delivery window</b> as usual please. Full breakdown below.</p>
    <table style="width:100%;border-collapse:collapse;margin:12px 0" cellpadding="8">
      <tr style="background:#f1f5f4">
        <th align="left" style="border-bottom:2px solid #dddddd">Item</th>
        <th align="right" style="border-bottom:2px solid #dddddd">Qty</th>
        <th align="right" style="border-bottom:2px solid #dddddd">Unit</th>
      </tr>
      <tr><td style="border-bottom:1px solid #eeeeee">Chicken schnitzel &amp; rice</td><td align="right" style="border-bottom:1px solid #eeeeee">180</td><td align="right" style="border-bottom:1px solid #eeeeee">£3.20</td></tr>
      <tr><td style="border-bottom:1px solid #eeeeee">Vegetable lasagne (parev)</td><td align="right" style="border-bottom:1px solid #eeeeee">60</td><td align="right" style="border-bottom:1px solid #eeeeee">£2.90</td></tr>
      <tr><td style="border-bottom:1px solid #eeeeee">Fruit pots</td><td align="right" style="border-bottom:1px solid #eeeeee">240</td><td align="right" style="border-bottom:1px solid #eeeeee">£0.80</td></tr>
    </table>
    <p style="margin:14px 0">
      <a href="https://hermolis.com/orders/YP-2288" target="_blank" rel="noopener noreferrer nofollow" style="background:#0f766e;color:#ffffff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:bold">View full order</a>
    </p>
    <p style="color:#666666;font-size:13px;margin-top:16px">Thanks,<br>Sarah — Oakwood Primary kitchen</p>
  </div>
</div>`;

  const conversations: ConversationRecord[] = [
    {
      id: "conv_ivy", orgId: ORG_ID, inboxId: "inbox_wa", channel: "whatsapp_group",
      channelRef: "group_ivy_demo", inviteLink: "https://chat.whatsapp.com/NCmapleshul01",
      contact: contacts.ivy, subject: "Maple Road Shul", status: "open", assigneeUserId: DEMO_USER_ID, assignedTeamId: "team_support",
      priority: "high", labels: [LABEL.vip, LABEL.delivery], unread: true, unreadCount: 2,
      participants: ivyMembers.map((m, i) => ({ id: `part_ivy_${i + 1}`, conversationId: "conv_ivy", contact: m, role: (i === 2 ? "admin" : "member") as "admin" | "member", joinedAt: mins(600) })),
      slaDueAt: mins(-72), lastActivityAt: mins(35), seq: 5, preview: "James · Hermolis: 11am works — re-slotting now 👍",
      messages: ivyMsgs,
    },
    {
      id: "conv_north", orgId: ORG_ID, inboxId: "inbox_wa", channel: "whatsapp",
      contact: contacts.north, status: "open", assigneeUserId: null, assignedTeamId: "team_support",
      priority: "normal", labels: [LABEL.billing], unread: true, unreadCount: 3,
      slaDueAt: mins(40), lastActivityAt: mins(3), seq: 2, preview: "Invoice #4471 — is the VAT right on the cold food?",
      messages: [
        msg("conv_north", 1, "in", "contact", "Northwood Care Home", "Hi team — quick one on invoice #4471, is the VAT right? It's 20% on the whole lot, but most of it is cold food.", 4),
        msg("conv_north", 2, "in", "contact", "Northwood Care Home", "No rush, just before month end 🙏", 3),
      ],
    },
    {
      id: "conv_bloom", orgId: ORG_ID, inboxId: "inbox_support", channel: "email",
      contact: contacts.bloom, subject: "Weekly lunch order", status: "open", assigneeUserId: DEMO_USER_ID, assignedTeamId: "team_support",
      priority: "normal", labels: [LABEL.order], unread: false,
      slaDueAt: null, lastActivityAt: mins(18), seq: 2, preview: "Re: Weekly lunch order — confirmed for Monday AM",
      messages: [
        msg("conv_bloom", 1, "in", "contact", "Oakwood Jewish Primary", "Oakwood Primary — Weekly Lunch Order (PO #YP-2288). Here's this week's order — same delivery window as usual please.", 40, { bodyHtml: bloomEmailHtml }),
        msg("conv_bloom", 2, "out", "user", "Nathan A", "Got it, thank you! Confirmed for Monday AM. I'll let you know once the van is out.", 18, {
          bodyHtml: "<p>Got it, thank you! <b>Confirmed for Monday AM.</b></p><p>I'll let you know once the van is out. 🚚</p><p>— Nathan, Hermolis</p>",
          // Two tracked recipients, one of whom has opened it: the case per-recipient
          // tracking exists for — "did the person who needed to see it see it, or
          // only their colleague".
          email: {
            subject: "Re: Weekly Lunch Order (PO #YP-2288)",
            recipients: [
              { address: "kitchen@oakwoodprimary.org.uk", kind: "to", openedAt: mins(12) },
              { address: "bursar@oakwoodprimary.org.uk", kind: "cc", openedAt: null },
            ],
          },
        }),
      ],
    },
    {
      id: "conv_harbour", orgId: ORG_ID, inboxId: "inbox_wa", channel: "whatsapp",
      contact: contacts.harbour, status: "pending", assigneeUserId: null, assignedTeamId: "team_support",
      priority: "low", labels: [LABEL.resolved], unread: false,
      slaDueAt: null, lastActivityAt: mins(41), seq: 1, preview: "Events: thanks, the mashgiach has signed off 👍",
      messages: [
        msg("conv_harbour", 1, "in", "contact", "Heathside Hotel", "Thanks, the mashgiach has signed off 👍", 41),
      ],
    },
    {
      id: "conv_acme", orgId: ORG_ID, inboxId: "inbox_wa", channel: "whatsapp",
      contact: contacts.acme, status: "open", assigneeUserId: DEMO_USER_ID, assignedTeamId: "team_support",
      priority: "normal", labels: [], unread: false,
      slaDueAt: null, lastActivityAt: mins(70), seq: 1, preview: "You: no problem, see you at the tasting!",
      messages: [
        msg("conv_acme", 1, "out", "user", "Nathan A", "No problem, see you at the tasting!", 70),
      ],
    },
    {
      id: "conv_tide", orgId: ORG_ID, inboxId: "inbox_support", channel: "email",
      contact: contacts.tide, subject: "New supplier onboarding", status: "open", assigneeUserId: null, assignedTeamId: "team_support",
      priority: "normal", labels: [LABEL.onboarding], unread: true, unreadCount: 1,
      slaDueAt: mins(165), lastActivityAt: mins(92), seq: 1, preview: "New supplier onboarding — hechsher and delivery questions",
      messages: [
        msg("conv_tide", 1, "in", "contact", "Shefa Fresh Produce", "Hello! We're getting set up as a new supplier and had a few questions about your hechsher requirements, delivery windows and cut-off times.", 92),
      ],
    },
  ];

  // A few pre-approved WhatsApp templates for the demo, so the composer's
  // closed-window flow (e.g. conv_acme, which has no inbound) has something to send.
  const templates: Template[] = [
    { id: "tpl_order_update", name: "order_update", category: "utility", language: "en", approvalStatus: "approved", variableCount: 3, variableDefaults: ["{{contact.first_name}}"], body: "Hi {{1}}, your order {{2}} is on its way and should arrive by {{3}}. Reply here if you need anything!" , isDefault: false },
    { id: "tpl_appointment_reminder", name: "appointment_reminder", category: "utility", language: "en", approvalStatus: "approved", variableCount: 3, variableDefaults: ["{{contact.first_name}}"], body: "Hi {{1}}, a quick reminder of your menu tasting on {{2}} at {{3}}. Reply here to reschedule." , isDefault: false },
    { id: "tpl_payment_reminder", name: "payment_reminder", category: "utility", language: "en", approvalStatus: "approved", variableCount: 3, variableDefaults: ["{{contact.first_name}}"], body: "Hi {{1}}, invoice {{2}} for {{3}} is now due. You can reply here with any questions." , isDefault: false },
    { id: "tpl_welcome_back", name: "welcome_back", category: "marketing", language: "en", approvalStatus: "approved", variableCount: 1, variableDefaults: ["{{contact.first_name}}"], body: "Hi {{1}} 👋 It's been a little while — reply here and we'll pick up right where we left off." , isDefault: false },
  ];

  return { users, teams, membership, inboxes, conversations, templates, labels: Object.values(LABEL) };
}
