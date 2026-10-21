/**
 * Starter seed for the Postgres path. Idempotent (upserts by id), and aligned
 * with the in-memory fixtures so the DB-backed app looks identical to the
 * zero-infra demo. Run: `pnpm db:up && pnpm db:migrate && pnpm db:seed`.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Kept from before the Hermolis rebrand — never shown, and renaming it would
// make an existing database look brand new and seed a second, empty workspace.
const ORG = "org_swiftee";

/**
 * The password the first admin account is created with.
 *
 * Deliberately not computed at module load with a built-in fallback, which is
 * what this used to do. `AUTH_DEV_PASSWORD ?? "ding1234"` put a password that
 * is public — it is right here, in the repository — on the admin account of any
 * database seeded without that variable set. And a password is the whole of it:
 * the API grants a full session on password alone, and the two-factor enrolment
 * gate is drawn by the *client*, so a non-browser caller never meets it.
 *
 * Outside production the convenience is worth it and the default stands. In
 * production there is no default: refuse to create the account rather than
 * create it with a known password. Called only where users are about to be
 * created, so an existing workspace — which never reaches that code — is
 * unaffected either way.
 */
function seedPasswordHash(): string {
  const chosen = process.env.AUTH_DEV_PASSWORD;
  if (!chosen && process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed a production database with the built-in demo password.\n" +
        "This is a brand-new workspace, so the first admin account is about to be created.\n" +
        "Set AUTH_DEV_PASSWORD to a strong, random value and deploy again; change it in the\n" +
        "app once you are signed in.",
    );
  }
  return bcrypt.hashSync(chosen ?? "ding1234", 8);
}

// Demo timestamps relative to real "now" so a freshly-seeded thread looks
// current — 2 days ago / Yesterday / Today, with rolling date dividers like
// WhatsApp. Demo conversations are seeded once on an empty DB and preserved
// thereafter (see the guard below), so these anchor the first seed only.
const now = Date.now();
const mins = (m: number) => new Date(now - m * 60_000);
const dayAt = (d: number, hh: number, mm: number) => {
  const t = new Date(now);
  t.setHours(hh, mm, 0, 0);
  t.setDate(t.getDate() - d);
  return t;
};

async function main() {
  // Is this a brand-new database? Checked BEFORE we ensure the org row exists.
  const firstRun =
    (await prisma.organization.findUnique({ where: { id: ORG }, select: { id: true } })) === null;

  // Before the first write, not at the point of use. Throwing later would leave
  // the organization row behind — and `firstRun` is false once that exists, so
  // the next deploy would skip the seed entirely and the workspace would sit
  // there permanently with no users and no second warning. Fail before touching
  // anything, and a corrected deploy starts from a clean slate.
  const passwordHash = firstRun ? seedPasswordHash() : "";

  await prisma.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: "Hermolis", region: "uk" },
  });

  // Legacy fix (runs every deploy; a no-op once migrated): a WhatsApp group used
  // to get its own `whatsapp_group` inbox. Groups now live under their WhatsApp
  // number, so move any such conversations onto the number and drop the inbox.
  const legacyGroupInboxes = await prisma.inbox.findMany({ where: { orgId: ORG, type: "whatsapp_group" } });
  for (const gi of legacyGroupInboxes) {
    await prisma.conversation.updateMany({ where: { inboxId: gi.id }, data: { inboxId: "inbox_wa" } });
    await prisma.inboxTeam.deleteMany({ where: { inboxId: gi.id } });
    await prisma.inbox.delete({ where: { id: gi.id } });
  }

  // Everything below is demo/baseline data seeded ONLY into a fresh database.
  // Re-running the seed on every deploy must NEVER resurrect what an admin has
  // since deleted — a removed channel, user, team, label or template — so once
  // the workspace exists we stop here and leave their data exactly as it is.
  if (!firstRun) {
    console.log("✓ Seed: existing workspace — baseline data left as-is.");
    return;
  }

  const users = [
    { id: "usr_nathan", name: "Nathan A", email: "nathan@hermolis.com", role: "admin" as const, avatarColor: "linear-gradient(135deg,#3B82F6,#8B5CF6)", online: true },
    { id: "usr_james", name: "James", email: "james@hermolis.com", role: "agent" as const, avatarColor: "linear-gradient(135deg,#0EA5E9,#22D3EE)", online: true },
    { id: "usr_amara", name: "Amara", email: "amara@hermolis.com", role: "agent" as const, avatarColor: "linear-gradient(135deg,#F43F5E,#F59E0B)", online: false },
  ];
  // Reached only on a first run, so these users do not exist yet. The upsert's
  // `update` deliberately does nothing: it used to reset `passwordHash`, which
  // was harmless only because the guard above kept it unreachable — and would
  // have silently undone every password change in the workspace the day
  // somebody moved that guard.
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: {},
      create: { orgId: ORG, passwordHash, ...u },
    });
  }

  const teams = [
    { id: "team_support", name: "Support team", icon: "headset", order: 0, slaMinutes: 60 },
    { id: "team_sales", name: "Sales team", icon: "cart", order: 1, slaMinutes: 240 },
  ];
  for (const t of teams) {
    await prisma.team.upsert({
      where: { id: t.id },
      update: { slaMinutes: t.slaMinutes },
      create: { orgId: ORG, ...t },
    });
  }

  const memberships = [
    { userId: "usr_nathan", teamId: "team_support", role: "manager" },
    { userId: "usr_nathan", teamId: "team_sales", role: "manager" },
    { userId: "usr_james", teamId: "team_support", role: "member" },
    { userId: "usr_amara", teamId: "team_sales", role: "member" },
  ];
  for (const m of memberships) {
    await prisma.teamMember.upsert({
      where: { userId_teamId: { userId: m.userId, teamId: m.teamId } },
      update: {},
      create: m,
    });
  }

  const inboxes = [
    { id: "inbox_wa", type: "whatsapp" as const, name: "+44 20 7946", handle: "+44 20 7946 0100", routing: "manual" as const, teams: ["team_support"] },
    { id: "inbox_support", type: "email" as const, name: "support@hermolis.com", handle: "support@hermolis.com", routing: "round_robin" as const, teams: ["team_support"] },
    { id: "inbox_hello", type: "email" as const, name: "orders@hermolis.com", handle: "orders@hermolis.com", routing: "round_robin" as const, teams: ["team_sales"] },
  ];
  for (const i of inboxes) {
    await prisma.inbox.upsert({
      where: { id: i.id },
      update: {},
      create: { id: i.id, orgId: ORG, type: i.type, name: i.name, handle: i.handle, routingStrategy: i.routing },
    });
    for (const teamId of i.teams) {
      await prisma.inboxTeam.upsert({
        where: { inboxId_teamId: { inboxId: i.id, teamId } },
        update: {},
        create: { inboxId: i.id, teamId },
      });
    }
  }

  const labels = [
    { id: "lbl_vip", name: "VIP", color: "#0FA47A" },
    { id: "lbl_delivery", name: "Delivery", color: "#E68A00" },
    { id: "lbl_billing", name: "Billing", color: "#5B8DEF" },
    { id: "lbl_order", name: "Order", color: "#0FA47A" },
    { id: "lbl_onboarding", name: "Onboarding", color: "#A06CF2" },
  ];
  for (const l of labels) {
    await prisma.label.upsert({ where: { id: l.id }, update: {}, create: { orgId: ORG, ...l } });
  }

  // Pre-approved WhatsApp templates for replying once a 24-hour window closes.
  const templates = [
    { id: "tpl_order_update", name: "order_update", category: "utility", body: "Hi {{1}}, your order {{2}} is on its way and should arrive by {{3}}. Reply here if you need anything!" },
    { id: "tpl_appointment_reminder", name: "appointment_reminder", category: "utility", body: "Hi {{1}}, a quick reminder of your menu tasting on {{2}} at {{3}}. Reply here to reschedule." },
    { id: "tpl_payment_reminder", name: "payment_reminder", category: "utility", body: "Hi {{1}}, invoice {{2}} for {{3}} is now due. You can reply here with any questions." },
    { id: "tpl_welcome_back", name: "welcome_back", category: "marketing", body: "Hi {{1}} 👋 It's been a little while — reply here and we'll pick up right where we left off." },
  ];
  for (const t of templates) {
    await prisma.template.upsert({
      where: { id: t.id },
      update: {},
      create: { id: t.id, orgId: ORG, language: "en", approvalStatus: "approved", ...t },
    });
  }

  // A formatted inbound email (already in the sanitized shape the ingest pipeline
  // produces): a letterhead image blocked as a remote src, a greeting and a list.
  const tideEmailHtml = `<div style="font-family:Arial,Helvetica,sans-serif;color:#22303a">
  <div style="background:#0ea5e9;padding:16px 20px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;color:#ffffff;font-size:18px">Shefa Fresh Produce — New Supplier Onboarding</h2>
    <p style="margin:4px 0 0;color:#e0f4ff;font-size:13px">Fresh produce · London E5</p>
  </div>
  <img data-blocked-src="https://cdn.example.com/shefa/letterhead.png" alt="Shefa Fresh Produce" width="560" style="width:100%;max-width:560px;display:block">
  <div style="padding:14px 20px">
    <p>Hello Hermolis team,</p>
    <p>We're getting set up as a <b>new supplier</b> and had a few questions before our first delivery:</p>
    <ul style="padding-left:20px;margin:10px 0">
      <li>Which hechsher do you need on our produce and paperwork?</li>
      <li>Is there a cut-off time for deliveries before Shabbat and Yom Tov?</li>
      <li>Can we consolidate multiple POs into one drop?</li>
    </ul>
    <p style="margin:14px 0">
      <a href="https://hermolis.com/suppliers/shefa" target="_blank" rel="noopener noreferrer nofollow" style="background:#0ea5e9;color:#ffffff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Supplier portal</a>
    </p>
    <p style="color:#667;font-size:13px;margin-top:16px">Many thanks,<br>The Shefa Fresh Produce team</p>
  </div>
</div>`;

  // A representative set of contacts + conversations + messages.
  const seedConversations = [
    {
      contact: { id: "ct_ivy", displayName: "Maple Road Shul", company: "Synagogue · London NW11", avatarColor: "linear-gradient(135deg,#F97316,#DB2777)", phone: "+44 20 8455 0122", email: "office@mapleroadshul.org.uk", tags: ["Key account", "Kiddush"] },
      conv: { id: "conv_ivy", inboxId: "inbox_wa", channel: "whatsapp_group" as const, subject: null as string | null, status: "open" as const, assigneeUserId: "usr_nathan", assignedTeamId: "team_support", priority: "high" as const, unread: true, unreadCount: 2, slaDueAt: mins(-72), preview: "James · Hermolis: 11am works — re-slotting now 👍" },
      labels: ["lbl_vip", "lbl_delivery"],
      // Spans 2 days ago → yesterday → today so the date dividers roll over.
      messages: [
        { direction: "in" as const, authorType: "contact" as const, authorName: "Miriam (Maple Road Shul)", body: "Morning! Are we still on for the kiddush delivery this Friday?", internal: false, createdAt: dayAt(2, 9, 2) },
        { direction: "out" as const, authorType: "user" as const, authorName: "Nathan A", authorUserId: "usr_nathan", body: "Morning Miriam 👋 Yes — you're booked in. I'll confirm the slot shortly.", internal: false, createdAt: dayAt(2, 9, 8) },
        { direction: "in" as const, authorType: "contact" as const, authorName: "Miriam (Maple Road Shul)", body: "Amazing. One change — could you bring it forward to 11am? Shabbat comes in early this week.", internal: false, createdAt: dayAt(1, 13, 20) },
        { direction: "out" as const, authorType: "user" as const, authorName: "James", authorUserId: "usr_james", body: "@nathan can the NW London van take an 11am Friday drop for the shul? Early Shabbat their end.", internal: true, createdAt: dayAt(1, 13, 24) },
        { direction: "in" as const, authorType: "contact" as const, authorName: "James · Hermolis", body: "Yep, 11am works — I'll re-slot the van now. 👍", internal: false, createdAt: mins(35) },
      ],
    },
    {
      contact: { id: "ct_north", displayName: "Northwood Care Home", company: "Care home · London HA6", avatarColor: "linear-gradient(135deg,#0EA5E9,#2563EB)", phone: "+44 20 3555 0148", email: "accounts@northwoodcare.co.uk", tags: ["Contract", "Net-30"] },
      conv: { id: "conv_north", inboxId: "inbox_wa", channel: "whatsapp" as const, subject: null as string | null, status: "open" as const, assigneeUserId: null, assignedTeamId: "team_support", priority: "normal" as const, unread: true, unreadCount: 3, slaDueAt: mins(40), preview: "Invoice #4471 — is the VAT right on the cold food?" },
      labels: ["lbl_billing"],
      messages: [
        { direction: "in" as const, authorType: "contact" as const, authorName: "Northwood Care Home", body: "Hi team — is the VAT right on invoice #4471? It's 20% on the whole lot, but most of it is cold food.", internal: false, createdAt: dayAt(1, 16, 12) },
        { direction: "in" as const, authorType: "contact" as const, authorName: "Northwood Care Home", body: "No rush, just before month end 🙏", internal: false, createdAt: mins(180) },
      ],
    },
    {
      contact: { id: "ct_tide", displayName: "Shefa Fresh Produce", company: "Supplier · London E5", avatarColor: "linear-gradient(135deg,#14B8A6,#0EA5E9)", phone: "+44 20 8555 0166", email: "team@shefafresh.co.uk", tags: ["Supplier", "New lead"] },
      conv: { id: "conv_tide", inboxId: "inbox_support", channel: "email" as const, subject: "New supplier onboarding" as string | null, status: "open" as const, assigneeUserId: null, assignedTeamId: "team_support", priority: "normal" as const, unread: true, unreadCount: 1, slaDueAt: mins(165), preview: "New supplier onboarding — hechsher and delivery questions" },
      labels: ["lbl_onboarding"],
      messages: [
        { direction: "in" as const, authorType: "contact" as const, authorName: "Shefa Fresh Produce", body: "Hello! We're getting set up as a new supplier and had a few questions about your hechsher requirements and delivery windows.", internal: false, createdAt: mins(92), bodyHtml: tideEmailHtml },
      ],
    },
  ];

  for (const s of seedConversations) {
    // Non-destructive: a demo conversation is seeded only when it's absent.
    // Once it exists it's a real working thread — its state, messages and media
    // are preserved across deploys rather than wiped and rebuilt.
    const alreadySeeded = await prisma.conversation.findUnique({
      where: { id: s.conv.id },
      select: { id: true },
    });
    if (alreadySeeded) continue;

    await prisma.contact.upsert({
      where: { id: s.contact.id },
      update: { tags: s.contact.tags ?? [] },
      create: {
        id: s.contact.id,
        orgId: ORG,
        displayName: s.contact.displayName,
        company: s.contact.company,
        avatarColor: s.contact.avatarColor,
        tags: s.contact.tags ?? [],
        identities: {
          create: [
            { kind: "phone", value: s.contact.phone },
            { kind: "email", value: s.contact.email },
          ],
        },
      },
    });

    const newest = s.messages.reduce(
      (a, m) => (m.createdAt > a ? m.createdAt : a),
      s.messages[0].createdAt,
    );
    // Seed the WhatsApp 24-hour window anchor from the newest inbound message
    // (fresh DBs run the seed before any backfill could populate it).
    const lastInboundAt =
      s.messages
        .filter((m) => m.direction === "in")
        .reduce<Date | null>((a, m) => (a && a > m.createdAt ? a : m.createdAt), null);

    await prisma.conversation.create({
      data: {
        id: s.conv.id,
        orgId: ORG,
        inboxId: s.conv.inboxId,
        contactId: s.contact.id,
        channel: s.conv.channel,
        subject: s.conv.subject,
        status: s.conv.status,
        assigneeUserId: s.conv.assigneeUserId,
        assignedTeamId: s.conv.assignedTeamId,
        priority: s.conv.priority,
        unread: s.conv.unread,
        unreadCount: s.conv.unreadCount ?? 0,
        preview: s.conv.preview,
        slaDueAt: s.conv.slaDueAt,
        lastActivityAt: newest,
        lastInboundAt,
        seq: s.messages.length,
        labels: { create: s.labels.map((labelId) => ({ labelId })) },
      },
    });

    await prisma.message.createMany({
      data: s.messages.map((m, idx) => ({
        conversationId: s.conv.id,
        seq: idx + 1,
        direction: m.direction,
        authorType: m.authorType,
        authorName: m.authorName,
        authorUserId: "authorUserId" in m ? (m.authorUserId as string) : null,
        body: m.body,
        bodyHtml: "bodyHtml" in m ? (m.bodyHtml as string) : null,
        internal: m.internal,
        status: m.direction === "out" ? ("read" as const) : ("delivered" as const),
        createdAt: m.createdAt,
      })),
    });
  }

  // One-time demo enrichment: give the pre-seeded supplier email its rich HTML body
  // so the HTML-email feature is visible even on databases seeded before it
  // existed. Idempotent + scoped to the demo message, so real mail is untouched.
  await prisma.message.updateMany({
    where: { conversationId: "conv_tide", direction: "in", bodyHtml: null },
    data: { bodyHtml: tideEmailHtml },
  });

  console.log("✓ Seeded Hermolis org, users, teams, inboxes, and demo conversations.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
