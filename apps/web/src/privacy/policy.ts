/**
 * The NestConnect privacy policy: owner facts, content, and the rule that
 * decides whether it may be shown at all.
 *
 * Everything in the policy that describes what the software does is written
 * from the code (see docs/privacy-policy-draft.md for the file-by-file
 * grounding). Everything that is a fact about the *operator* — who they are,
 * where to write to them, how long they keep data, which optional services
 * their production deployment actually switches on — cannot be read from the
 * code, and is therefore an owner field below.
 *
 * Fail closed: until every owner field is resolved (non-null, non-empty, and
 * free of anything that looks like a placeholder), `resolvePolicy` answers
 * `pending` and the public page renders a neutral "being finalised" notice with
 * none of the draft text. There is no partial mode.
 */

/* ------------------------------------------------------------------------ */
/* Owner fields                                                              */
/* ------------------------------------------------------------------------ */

/** Who is responsible for end customers' data in the business's conversations. */
export type EndCustomerDataRole = "processor" | "controller";

/**
 * Facts only the owner can supply. `null` means unresolved.
 *
 * Every field is required for publication. Booleans record whether an
 * optional, configuration-dependent part of the code is actually switched on
 * in production; they decide which paragraphs and service providers the
 * published policy lists, so they must be confirmed rather than guessed.
 */
export interface PrivacyOwnerFields {
  /** Legal name of the entity operating NestConnect. */
  controllerName: string | null;
  /** Company registration details (number and place of registration), as the owner wants them shown. */
  companyDetails: string | null;
  /** Registered or postal address for privacy correspondence. */
  postalAddress: string | null;
  /** Mailbox that privacy requests should go to. */
  contactEmail: string | null;
  /** Date the policy takes effect, YYYY-MM-DD. */
  effectiveDate: string | null;
  /** Whether the operator acts for the business (processor) or decides for itself (controller) about end customers' data. */
  endCustomerDataRole: EndCustomerDataRole | null;
  /** Name of the hosting provider that runs the servers and database. */
  hostingProvider: string | null;
  /** Region(s)/country where the servers, database and backups are located. */
  hostingRegion: string | null;
  /** How personal data transferred between countries is safeguarded. */
  internationalTransfersStatement: string | null;
  /** How long each category of data is kept, and what happens at the end. */
  retentionStatement: string | null;
  /** Whether database/storage backups exist and how long they are kept. */
  backupStatement: string | null;
  /** The legal bases relied on for processing (where the law requires one). */
  legalBasesStatement: string | null;
  /** Region-specific rights text (for example, where to complain to a regulator). */
  jurisdictionalRightsStatement: string | null;
  /** Statement about children / minimum age. */
  childrenStatement: string | null;
  /** SECRET_ENCRYPTION_KEY is set in production, so integration secrets are encrypted at rest. */
  secretEncryptionEnabledInProduction: boolean | null;
  /** The mobile app is built with EXPO_PUBLIC_SENTRY_DSN, so crash reporting to Sentry is on. */
  sentryEnabledInProduction: boolean | null;
  /** Cloudflare sits in front of nestconnect.io (DNS/proxy). */
  cloudflareInFrontOfDomain: boolean | null;
  /** Attachments are stored in Cloudflare R2 (R2_* configured) rather than on server disk. */
  r2StorageInProduction: boolean | null;
  /** The WhatsApp channel (Meta WhatsApp Business Cloud API) is offered. */
  whatsappCloudApiInUse: boolean | null;
  /** The Gmail channel (Google OAuth, Gmail API, optional Cloud Pub/Sub) is offered. */
  gmailIntegrationInUse: boolean | null;
  /** Postmark carries the email channel (POSTMARK_TOKEN set) and/or system email. */
  postmarkInUse: boolean | null;
  /** Resend carries system email (RESEND_API_KEY set or configured in Settings). */
  resendInUse: boolean | null;
  /** An SMTP relay carries system email (SMTP_* set or configured in Settings). */
  smtpInUse: boolean | null;
  /** AI "Polish" (Anthropic API) is available to workspaces. */
  anthropicPolishAvailable: boolean | null;
  /** The in-app chat SDK with customer push (Firebase Cloud Messaging) is offered to businesses. */
  sdkCustomerPushInUse: boolean | null;
}

export type ResolvedOwnerFields = { [K in keyof PrivacyOwnerFields]: NonNullable<PrivacyOwnerFields[K]> };

/**
 * THE owner fields. All are resolved and the owner approved publication on
 * 2026-10-08, so the public /privacy page renders the full policy. Change any
 * value only with the owner's approval — see docs/privacy-policy-draft.md.
 */
export const OWNER_FIELDS: PrivacyOwnerFields = {
  // Operator facts: owner-confirmed; company number and registered office
  // checked against Companies House (17089989, active).
  controllerName: "Nest Partners Limited",
  companyDetails: "a private limited company registered in England and Wales, company number 17089989",
  postalAddress: "14 Grosvenor Way, London, E5 9ND, United Kingdom",
  contactEmail: "info@swiftee.co.uk",
  effectiveDate: "2026-10-19",
  // Legal positions and retention: drafted for and approved by the owner.
  endCustomerDataRole: "processor",
  // Infrastructure: read from the live Railway project (service region
  // "US West (California, USA)"; no scheduled backups on the current plan).
  hostingProvider: "Railway",
  hostingRegion: "United States (US West, California)",
  internationalTransfersStatement:
    "We are based in the United Kingdom. Our servers and database are hosted in the United States, and several of our service providers (including Railway, Cloudflare, Google, Meta, Resend, Expo and Anthropic) process personal information in the United States or other countries outside the UK and the European Economic Area. When we transfer personal information out of the UK or the EEA, we rely on adequacy regulations or decisions where they apply (such as the UK-US data bridge or the EU-US Data Privacy Framework for certified recipients), or on appropriate safeguards such as the UK International Data Transfer Addendum or the EU Standard Contractual Clauses.",
  retentionStatement:
    "We keep a workspace's information for as long as the business's account is active. When a business closes its account, we delete its information within 90 days, unless we need to keep some of it for longer to comply with the law, resolve disputes or enforce our agreements.",
  backupStatement:
    "We do not currently run scheduled database backups. Our hosting provider has occasionally taken a backup of the database (for example before platform maintenance); such a backup can contain the information described in this policy and is stored with the hosting provider in the same region.",
  legalBasesStatement:
    "Where data protection law (such as the UK GDPR or the EU GDPR) requires a legal basis, we rely on: performing our contract with the business that uses NestConnect, and with its workspace users, to provide the service; our legitimate interests in operating, securing and improving the service and preventing abuse; complying with our legal obligations; and your consent where we ask for it, such as for push notifications or access to your camera, photos or microphone, which you can withdraw at any time in your device settings. Where we process customers' information on a business's behalf, that business is responsible for having a legal basis for the processing.",
  jurisdictionalRightsStatement:
    "If you are in the UK, you can complain to the Information Commissioner's Office (ico.org.uk). If you are in the European Economic Area, you can complain to the data protection authority in your country. We would appreciate the chance to deal with your concerns first, so please contact us before you do.",
  childrenStatement:
    "NestConnect accounts are for people aged 18 and over who use it for work. We do not knowingly collect personal information from children for our own purposes. If you believe a child has given us personal information, contact us and we will delete it.",
  // Production configuration, read from the live service: Settings ->
  // Integrations (storage, Meta, Google, SMTP, Resend, Anthropic, push all
  // configured), Railway variables (SECRET_ENCRYPTION_KEY set, no
  // POSTMARK_TOKEN), EAS environment (no EXPO_PUBLIC_SENTRY_DSN), and
  // nestconnect.io response headers (served through Cloudflare).
  secretEncryptionEnabledInProduction: true,
  sentryEnabledInProduction: false,
  cloudflareInFrontOfDomain: true,
  r2StorageInProduction: true,
  whatsappCloudApiInUse: true,
  gmailIntegrationInUse: true,
  postmarkInUse: false,
  resendInUse: true,
  smtpInUse: true,
  anthropicPolishAvailable: true,
  sdkCustomerPushInUse: true,
};

/** Every owner field name, in checklist order. */
export const OWNER_FIELD_NAMES = Object.keys(OWNER_FIELDS) as (keyof PrivacyOwnerFields)[];

/* ------------------------------------------------------------------------ */
/* Placeholder detection                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Anything that reads as an unfinished draft. Checked against every owner
 * value and, as a second line of defence, against every string of the built
 * policy — so a placeholder can't reach the page through either door.
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /⟦|⟧/, // the markers used in docs/privacy-policy-draft.md
  /\{\{|\}\}/,
  /\[\s*(owner|todo|tbd|placeholder|insert|fill|confirm|your|company|address|email|date)\b/i,
  /<\s*(owner|insert|placeholder|your)\b/i,
  /\b(TODO|TBD|TBC|FIXME|XXX)\b/,
  /\bOWNER[ _-]?(FIELD|INPUT|TO[ _-]CONFIRM|DECISION)\b/i,
  /\bplaceholder\b/i,
  /lorem ipsum/i,
  /example\.(com|org|net)\b/i,
];

export function containsPlaceholderMarker(text: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(text));
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Owner fields that are not yet usable, by name. Never shown publicly. */
export function unresolvedOwnerFields(fields: PrivacyOwnerFields): (keyof PrivacyOwnerFields)[] {
  return OWNER_FIELD_NAMES.filter((name) => {
    const value = fields[name];
    if (value === null || value === undefined) return true;
    if (typeof value === "boolean") return false;
    const text = String(value).trim();
    if (!text || containsPlaceholderMarker(text)) return true;
    if (name === "contactEmail" && !EMAIL_SHAPE.test(text)) return true;
    if (name === "effectiveDate" && !isRealDate(text)) return true;
    if (name === "endCustomerDataRole" && text !== "processor" && text !== "controller") return true;
    return false;
  });
}

/* ------------------------------------------------------------------------ */
/* Document model                                                            */
/* ------------------------------------------------------------------------ */

/** A run of text, optionally a link. */
export type Run = string | { text: string; href: string };

export type Block =
  | { kind: "p"; runs: Run[] }
  | { kind: "list"; items: Run[][] }
  | { kind: "sub"; title: string };

export interface PolicySection {
  id: string;
  title: string;
  blocks: Block[];
}

export interface PolicyDocument {
  title: string;
  effectiveDate: string;
  intro: Run[];
  sections: PolicySection[];
}

export type PolicyResolution =
  | { status: "ready"; document: PolicyDocument }
  | { status: "pending" };

const p = (...runs: Run[]): Block => ({ kind: "p", runs });
const list = (...items: (string | Run[])[]): Block => ({
  kind: "list",
  items: items.map((i) => (typeof i === "string" ? [i] : i)),
});
const sub = (title: string): Block => ({ kind: "sub", title });
const mail = (address: string): Run => ({ text: address, href: `mailto:${address}` });

/** Every human-readable string in a document, for checks and tests. */
export function documentText(doc: PolicyDocument): string {
  const runs = (rs: Run[]) => rs.map((r) => (typeof r === "string" ? r : `${r.text} ${r.href}`)).join("");
  const out: string[] = [doc.title, doc.effectiveDate, runs(doc.intro)];
  for (const s of doc.sections) {
    out.push(s.title);
    for (const b of s.blocks) {
      if (b.kind === "p") out.push(runs(b.runs));
      else if (b.kind === "list") out.push(...b.items.map(runs));
      else out.push(b.title);
    }
  }
  return out.join("\n");
}

/** "8 October 2026" from "2026-10-08", without depending on the viewer's locale. */
export function formatEffectiveDate(iso: string): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

/* ------------------------------------------------------------------------ */
/* The policy                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Build the full policy. Only callable with resolved fields — the type makes a
 * half-filled policy unrepresentable here.
 */
export function buildPolicy(f: ResolvedOwnerFields): PolicyDocument {
  const processor = f.endCustomerDataRole === "processor";
  const channels: string[] = [
    ...(f.whatsappCloudApiInUse ? ["WhatsApp (including WhatsApp groups)"] : []),
    "email",
    "the NestChat chat widget on a business's website",
    ...(f.sdkCustomerPushInUse ? ["chat inside a business's own mobile app (our in-app SDK)"] : []),
  ];

  const sections: PolicySection[] = [];

  sections.push({
    id: "who-we-are",
    title: "Who we are",
    blocks: [
      p(
        `NestConnect is a shared team inbox that lets a business (a "workspace") talk to its customers over several channels from one place. It is operated by ${f.controllerName} (${f.companyDetails}), ${f.postalAddress} ("we", "us"). It is available at nestconnect.io and as the NestConnect mobile app for iOS and Android.`,
      ),
      p("For anything about this policy or your information, contact us at ", mail(f.contactEmail), "."),
    ],
  });

  sections.push({
    id: "who-this-covers",
    title: "Who this policy covers",
    blocks: [
      list(
        "Workspace users: the people at a business who sign in to NestConnect to answer conversations (agents, managers and admins).",
        `Customers of those businesses: people who contact a business, or are contacted by it, through a channel connected to NestConnect — ${channels.join(", ")}.`,
        "Website visitors on a business's site where the NestChat chat widget is installed, whether or not they start a chat.",
        "Recipients of emails sent from a NestConnect inbox.",
      ),
      processor
        ? p(
            "When a business uses NestConnect to talk to its customers, that business decides what it collects about them and why, and we process that information on the business's behalf and on its instructions. If you are a customer of a business that uses NestConnect, the business is your first point of contact for questions or requests about your conversations with it; we will help the business respond. For your own account as a workspace user, and for running and securing the service, we are responsible for the information described here.",
          )
        : p(
            "We are responsible for the information described in this policy, including the conversations that businesses hold with their customers through NestConnect.",
          ),
    ],
  });

  sections.push({
    id: "information-we-collect",
    title: "Information we collect",
    blocks: [
      sub("Workspace users"),
      list(
        "Account details: name, email address, role, team memberships, availability and online status, avatar colour, an optional profile photo, and an optional job title (shown in the email signatures of the channels they send from).",
        "Sign-in credentials: your password is stored only as a bcrypt hash. Invitation and password-reset links use single-use tokens that are stored hashed, with an expiry.",
        `Two-step verification: the method you chose, your authenticator (TOTP) secret${f.secretEncryptionEnabledInProduction ? ", which is stored encrypted" : ""}, and hashed one-time email codes and recovery codes. After you complete two-step verification, a "trusted device" cookie (valid for 30 days) can skip the code on that browser or device.`,
        "Sessions: for each sign-in we record the IP address, the browser or device user agent, when it started, when it was last used and when it was signed out, so you can see where you are signed in and sign out remotely.",
        "Mobile devices: if you allow notifications in the NestConnect app, we store the device's push token, platform, app version, operating-system version and device name, linked to the sign-in that registered it.",
        "Preferences: which push notifications you want, conversations you have muted, and in-app notifications sent to you (such as mentions, assignments and reminders).",
        "What you write and do in the inbox: replies, internal notes, templates, labels, assignments and the history of who a conversation was assigned to.",
        ...(f.gmailIntegrationInUse
          ? [
              "If you connect a Gmail mailbox: your Google account's email address and basic profile (from Google sign-in), and the access tokens that let NestConnect send and read mail for that mailbox.",
            ]
          : []),
        "On your device: the web app keeps interface preferences in your browser's storage (such as sound on/off, panel widths, a collapsed sidebar and scroll positions). The mobile app keeps your sign-in in the device's secure storage and a few preferences in app storage. The mobile app asks for camera, photo-library and microphone access only so you can attach a photo or record a voice note, and only when you use those features.",
      ),
      sub("Customers of businesses using NestConnect"),
      list(
        "Contact details: display name, company, and the identifiers you are reached on — phone number, email address, WhatsApp ID, or an identifier for chat sessions — plus tags, an owner within the business, and whether the business has blocked you.",
        ...(f.whatsappCloudApiInUse
          ? ["From WhatsApp: your WhatsApp profile name and phone number as WhatsApp provides them, and your membership of WhatsApp groups the business runs."]
          : []),
        "Messages and their content: text, email content (including formatted HTML, which is cleaned of scripts before it is stored), and attachments such as photos, videos, audio, voice notes (with their length and waveform), documents, stickers, and shared locations or contact cards.",
        "Message details: time, direction, channel, delivery status (sent, delivered, read or failed) and the reason for a failed delivery, emoji reactions, and whether a message quotes or forwards another.",
        "Extra fields the business chooses to record about you or a conversation (for example, an order or booking number), whether entered by staff, imported from a spreadsheet, or sent by the business's website or app.",
        "Conversation details: status, priority, which team or person it is assigned to, labels, internal notes written by staff, and reminders.",
        ...(f.sdkCustomerPushInUse
          ? ["If you chat inside a business's own app: the app's identifier for you and, if the app provides them, your name, email address and phone number; and, if the app enables notifications, a push token and platform (iOS, Android or web) so replies can reach your phone."]
          : []),
      ),
      sub("Website visitors using the NestChat widget"),
      list(
        "When a page with the widget loads, the widget opens a chat session. Your browser stores, for that business's widget only, a random visitor identifier, the name you gave (if any) and whether you have answered the pre-chat form. Your email address and phone number are not stored in your browser.",
        "On our side, the session creates an anonymous visitor record (shown to the business as \"Visitor\" followed by part of that identifier). A conversation is created only when you send your first message.",
        "What you type in the pre-chat form (name, email address, phone number) and the topic you choose; your messages, files and voice notes. The microphone is used only when you choose to record a voice note.",
        "While you are typing, a preview of the text you have written so far (up to 500 characters) is shown live to the business's agents, before you press send.",
        "Whether you have read the latest replies (shown to the business as read status) and whether the chat is open on screen (so you are not sent a notification for a reply you are already reading). The web address of the chat window is sent with your messages and shown to the business as part of the conversation subject.",
        "If the website signs you in to the chat, the identifier the website uses for you and the name, email address and phone number it passes to the chat.",
        "If you gave an email address, a reply from the business that you have not read within about 5 minutes is emailed to you at that address, once, in the business's name (unless the business has turned this off). It contains the reply and, where the business has given its website, a link back to it.",
      ),
      sub("Recipients of emails sent from NestConnect"),
      list(
        "Emails that agents send from a NestConnect inbox include a small invisible image unique to each To and Cc recipient. When your email program loads it, we record that you opened the email, when, and how many times, so the agent can see it was seen. Requests that look automated (such as security scanners and link previewers) are ignored.",
      ),
    ],
  });

  const pushBlocks: Block[] = [
    p(
      "Workspace users: the NestConnect app sends notifications through the Expo push notification service, which delivers them through Firebase Cloud Messaging (Android) and the Apple Push Notification service (iOS). A notification contains the sender's name, a preview of up to 140 characters of the message (or \"Sent an attachment\"), the kind of notification, a conversation reference and an unread count. You choose which notifications you get in the app, and can turn them off in your device's settings. Signing a device out stops its notifications.",
    ),
  ];
  if (f.sdkCustomerPushInUse) {
    pushBlocks.push(
      p(
        "Customers using a business's own app: when an agent replies and the chat is not open on screen, we send a notification to the push token the app registered, through Firebase Cloud Messaging using the business's own Firebase project. It contains the agent's name, a preview of up to 180 characters of the reply, conversation references and the extra fields the business recorded on that conversation. You can turn these off in your device's settings, and the app can remove its registration when you sign out.",
      ),
    );
  }

  sections.push({
    id: "how-we-use",
    title: "How we use information",
    blocks: [
      list(
        "To deliver and receive messages on each connected channel, keep each customer's conversations together across channels, and recognise when a phone number or email address belongs to a customer the business already knows (including merging duplicate records).",
        "To route and assign conversations to the right team or person (for example, by the topic a visitor chose, or in turn among available agents), and to track response times.",
        "To show read receipts and typing indicators: when an agent reads or replies to a WhatsApp message, WhatsApp is told it was read and may show that the agent is typing; visitors see when an agent is typing; agents see when emails were opened.",
        "To notify workspace users (in the app and by push) and, where described above, customers.",
        "To let a business search, filter and report on its own conversations. These reports are produced inside NestConnect.",
        "To send account emails to workspace users: invitations, password resets and two-step verification codes.",
        "To email a website-chat visitor who gave an email address the replies they have not seen.",
        "To secure the service: authentication, two-step verification, session management, rate limiting, verifying that incoming webhooks really come from the channel provider, and diagnosing faults.",
      ),
      p(
        "The NestConnect web app, chat widget and mobile app contain no advertising SDKs and no third-party analytics SDKs.",
      ),
      ...(f.anthropicPolishAvailable
        ? [
            sub("AI writing assistance (optional)"),
            p(
              "A workspace can enable \"Polish\", which rewrites an agent's draft reply using Anthropic's Claude API. It runs only when an agent taps Polish. We then send Anthropic the draft (up to 5,000 characters) and, when the draft belongs to a conversation, up to the 12 most recent messages in it, each shortened to 600 characters and labelled only as \"Customer\" or \"Agent\". Internal notes are never included as context. Names and contact details are not sent as separate fields, but they are sent if they appear in that text. The result is shown to the agent, who decides whether to use it.",
            ),
            p(
              "NestConnect can also write a short subject for new WhatsApp and website-chat conversations, so staff can see what each one is about. This runs automatically, on each of the customer's first three messages, unless it is switched off in Settings. We then send Anthropic up to the first 8 messages of the conversation, each shortened to 1,000 characters and labelled only as \"Customer\" or \"Agent\" (internal notes are never included), together with the names and values of the conversation's custom fields, such as an order number. Names and contact details are not sent as separate fields, but they are sent if they appear in that text. The subject is shown only to the business's staff.",
            ),
          ]
        : []),
      sub("Push notifications"),
      ...pushBlocks,
    ],
  });

  // What Google's OAuth verification asks every Gmail-connected app to
  // disclose: what it reads, what it does with it, who else sees it, and the
  // Limited Use pledge, linked to the policy it pledges to.
  if (f.gmailIntegrationInUse) {
    sections.push({
      id: "google-user-data",
      title: "Google user data (Gmail)",
      blocks: [
        p(
          "A workspace can connect a Gmail mailbox as a shared inbox. The person connecting it signs in with Google and grants NestConnect permission to read the mailbox's email (gmail.readonly) and to send email as it (gmail.send), along with their Google account's email address and basic profile.",
        ),
        list(
          "What we use it for: to bring email arriving in that mailbox, and its attachments, into the workspace's shared inbox, keep each email thread together as one conversation, and send the replies the workspace's team writes from NestConnect, as that mailbox. We use the account's email address to show which mailbox is connected.",
          "Who sees it: the workspace users of the business that connected the mailbox, in the shared inbox. It is stored on the infrastructure that runs NestConnect, described under \"Who we share information with\".",
          ...(f.anthropicPolishAvailable
            ? [
                "AI writing assistance: if an agent uses Polish on a reply in an email conversation, the draft and recent messages of that conversation are sent to Anthropic as described under \"AI writing assistance\", only to produce the suggestion the agent asked for.",
              ]
            : []),
          "What we never do with it: sell it, use it for advertising, or use it to develop, improve or train generalised artificial-intelligence or machine-learning models. NestConnect staff do not read it unless the workspace asks us to for a specific message, it is needed for security (such as investigating abuse), to comply with the law, or it has been aggregated and anonymised for running the service.",
          `Storing and removing it: emails become part of the workspace's conversations and are kept and deleted as described under "How long we keep information, and deletion". The mailbox's access tokens are ${f.secretEncryptionEnabledInProduction ? "stored encrypted, and are " : ""}deleted when its channel is deleted. You can also remove NestConnect's access at any time from your Google Account's security settings.`,
        ),
        p(
          "NestConnect's use and transfer of information received from Google APIs to any other app will adhere to the ",
          { text: "Google API Services User Data Policy", href: "https://developers.google.com/terms/api-services-user-data-policy" },
          ", including the Limited Use requirements.",
        ),
      ],
    });
  }

  const logs: Block[] = [
    p(
      "Our servers write operational logs (errors, warnings and diagnostic events). These can include technical identifiers and, where needed to diagnose a problem, details such as an email address a message could not be delivered to. We also keep a record of incoming channel events we could not match to a workspace, such as a phone-number identifier or email address, to diagnose set-up problems.",
    ),
  ];
  if (f.sentryEnabledInProduction) {
    logs.push(
      p(
        "The NestConnect mobile app sends crash and error reports to Sentry. Reports include technical details such as the app version, device and operating-system information and the error itself. They are configured not to include message content: request bodies, cookies and headers are removed, network breadcrumbs keep only the address and status code, default personal information is turned off, and no screenshots or session replays are taken. Performance traces are sampled for 10% of sessions.",
      ),
    );
  } else {
    logs.push(p("The NestConnect mobile app does not send crash reports to a third party."));
  }

  sections.push({ id: "diagnostics", title: "Logs and crash reports", blocks: logs });

  const providers: Run[][] = [
    [`${f.hostingProvider} — hosts our servers and database (${f.hostingRegion}).`],
    ...(f.cloudflareInFrontOfDomain ? [["Cloudflare — network and security services in front of nestconnect.io."]] : []),
    ...(f.r2StorageInProduction ? [["Cloudflare R2 — stores attachments, voice notes, profile photos and logos."]] : []),
    ...(f.whatsappCloudApiInUse ? [["Meta (WhatsApp Business Platform) — sends and receives WhatsApp messages, media, read receipts and typing indicators."]] : []),
    ...(f.gmailIntegrationInUse ? [["Google (Gmail API, Google sign-in and, where configured, Cloud Pub/Sub) — sends and receives email for connected Gmail mailboxes, and may send account emails and website-chat reply emails through a connected mailbox."]] : []),
    ...(f.postmarkInUse ? [["Postmark — sends and receives email for email inboxes, and may send account emails and website-chat reply emails."]] : []),
    ...(f.resendInUse ? [["Resend — sends account emails (invitations, password resets, verification codes) and website-chat reply emails."]] : []),
    ...(f.smtpInUse ? [["An SMTP email provider — sends account emails and website-chat reply emails."]] : []),
    ["Expo, Google Firebase Cloud Messaging and Apple Push Notification service — deliver notifications to the NestConnect app."],
    ...(f.sdkCustomerPushInUse ? [["Google Firebase Cloud Messaging (the business's own project) — delivers notifications to customers in a business's app."]] : []),
    ...(f.anthropicPolishAvailable ? [["Anthropic — processes drafts and recent conversation text when an agent uses Polish, and the opening messages and custom field values of new WhatsApp and website-chat conversations to write their subjects."]] : []),
    ...(f.sentryEnabledInProduction ? [["Sentry — receives crash and error reports from the mobile app."]] : []),
    ["Gravatar — when a workspace user views a contact or colleague who has an email address in the NestConnect web app, their browser asks Gravatar for a profile picture using a one-way (SHA-256) hash of that email address."],
  ];

  sections.push({
    id: "sharing",
    title: "Who we share information with",
    blocks: [
      p("We use the following service providers to run NestConnect. Each receives only what it needs for the purpose given:"),
      { kind: "list", items: providers },
      p(
        "Within a workspace, information is visible to that business's workspace users according to the business's own set-up. Businesses' own websites and apps that embed our chat send information to us as described above. We may also disclose information where required by law.",
      ),
    ],
  });

  sections.push({
    id: "international",
    title: "International transfers",
    blocks: [p(f.internationalTransfersStatement)],
  });

  sections.push({
    id: "retention",
    title: "How long we keep information, and deletion",
    blocks: [
      p(f.retentionStatement),
      p(
        "NestConnect does not automatically delete conversations, messages, attachments or contacts after a fixed period; they are kept until they are deleted. The following deletion tools exist in the app today:",
      ),
      list(
        "A workspace can permanently delete a customer record. This deletes that customer's one-to-one conversations, their messages and attachment records, internal notes, labels and assignment history, the customer's identifiers, their registered push devices and the email-open records for those messages.",
        "Deleting a channel deletes the conversations and messages that belong to it.",
        "Admins and managers can remove a workspace user. This deletes the account, its sessions, devices, recovery codes, notifications, team memberships and the internal notes that user wrote. Messages the user sent to customers stay in the conversation history under their name.",
        "Workspace users can sign out any of their sessions and remove their devices. A signed-out session is kept as a record marked as signed out; the devices linked to it are removed.",
        "A business's app can remove a customer's push registration (for example, when they sign out). Visitors can clear the widget's stored identifier by clearing their browser's site data.",
      ),
      p(
        "Current limitations: deleting a record in the app does not yet delete the underlying attachment files from file storage, and does not delete the extra field values recorded against that customer or conversation. A customer's messages in WhatsApp group conversations remain in those groups' history. You can ask us to remove these (see \"Your rights and choices\").",
      ),
      p(f.backupStatement),
    ],
  });

  sections.push({
    id: "security",
    title: "Security",
    blocks: [
      p("Measures built into NestConnect include:"),
      list(
        "Passwords stored only as bcrypt hashes. In production every workspace user must set up two-step verification (authenticator app or emailed code) before using the service, and recovery codes are stored hashed.",
        "Session cookies that scripts cannot read and that are sent only over HTTPS; sessions you can review and sign out remotely, which also stops that device's notifications.",
        ...(f.secretEncryptionEnabledInProduction
          ? ["Credentials for connected services (such as channel access tokens and the two-step verification secret) encrypted in the database with AES-256-GCM."]
          : []),
        "Rate limiting and standard security headers; in production, incoming WhatsApp webhooks are accepted only with a valid signature.",
        "Email content cleaned of scripts and shown in a sandbox, with remote images (including other senders' tracking pixels) blocked until an agent chooses to load them.",
        "Chat widget visitors can read and write only their own conversation, and files uploaded by visitors are limited to allowed types and served as downloads.",
      ),
      p("No system is completely secure, and we cannot guarantee the security of information sent to us."),
    ],
  });

  sections.push({
    id: "rights",
    title: "Your rights and choices",
    blocks: [
      p(
        "Depending on where you live, you may have rights to ask for access to, correction of, deletion of, or a copy of your personal information, and to object to or restrict how it is used. To make a request, email ",
        mail(f.contactEmail),
        ` or write to ${f.controllerName}, ${f.postalAddress}. We may need to confirm your identity before acting on a request.`,
      ),
      ...(processor
        ? [
            p(
              "If you are a customer of a business that uses NestConnect, please contact that business first; we will support it in answering your request.",
            ),
          ]
        : []),
      p(f.jurisdictionalRightsStatement),
      list(
        "Push notifications can be switched off in your device's settings; workspace users can also choose which notifications they receive in the app.",
        "Camera, photo and microphone access are optional and can be withdrawn in your device's settings.",
        "Website visitors can clear the chat widget's stored identifier by clearing the site data for the chat in their browser.",
      ),
    ],
  });

  sections.push({ id: "legal-bases", title: "Legal bases", blocks: [p(f.legalBasesStatement)] });
  sections.push({ id: "children", title: "Children", blocks: [p(f.childrenStatement)] });
  sections.push({
    id: "changes",
    title: "Changes to this policy",
    blocks: [p("We may update this policy. The effective date at the top of this page shows when it last changed.")],
  });
  sections.push({
    id: "contact",
    title: "Contact",
    blocks: [p(`${f.controllerName}, ${f.postalAddress}. Email: `, mail(f.contactEmail), ".")],
  });

  return {
    title: "Privacy Policy",
    effectiveDate: formatEffectiveDate(f.effectiveDate),
    intro: [
      "This policy explains what information NestConnect collects, what it is used for, who it is shared with, and the choices you have.",
    ],
    sections,
  };
}

/**
 * The one entry point the page uses. Ready only when every owner field is
 * resolved AND the built text carries no placeholder marker.
 */
export function resolvePolicy(fields: PrivacyOwnerFields = OWNER_FIELDS): PolicyResolution {
  if (unresolvedOwnerFields(fields).length) return { status: "pending" };
  const document = buildPolicy(fields as ResolvedOwnerFields);
  if (containsPlaceholderMarker(documentText(document))) return { status: "pending" };
  return { status: "ready", document };
}
