import { useEffect, useRef, useState, type ChangeEvent, type ComponentType, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  embedSnippet,
  signedInSnippet,
  SIGNING_EXAMPLES,
  SPA_EXAMPLE,
  type EmbedKind,
} from "../lib/nestchat-embed";
import { appSetupGuide, type AppSetupStep } from "../lib/nestchat-app-setup";
import { WhatsAppPinField, WhatsAppRegistration } from "./WhatsAppRegistration";
import { PullMissedEmail, ReconnectEmailDialog, signedOutSince, useReconnectEmail } from "./ReconnectEmail";
import { MacrosPane } from "./MacrosPane";
import { SmsConfigEditor, SmsProviderPanel, smsDefaults } from "./SmsChannel";
import { OpsModulesPane } from "./ops/OpsModulesPane";
import { ChannelSignature, signatureDraftFor, signatureInput, type SignatureDraft } from "./ChannelSignature";
import type {
  ChannelType,
  Inbox,
  Label,
  PlatformPersonInvite,
  PlatformWorkspace,
  WorkspaceStatus,
  Role,
  CustomField,
  CustomFieldEntity,
  CustomFieldType,
  RoutingStrategy,
  Team,
  Template,
  TemplateCategory,
  WhatsAppVertical,
  BroadcastResult,
  OpeningHours,
  OpeningDay,
  OpeningHoursDay,
  NestChatApp,
  NestChatAppearance,
  NestChatCardIcon,
  NestChatIdentityMode,
  NestChatHome,
  NestChatHomeCard,
  NestChatAway,
  NestChatPreChat,
  NestChatPushTest,
  NestChatRouting,
  NestChatRoutingOption,
  NestChatTeam,
} from "@ding/schemas";
import {
  autoTemplateSlot,
  inboxLabel,
  resolveTemplateDefault,
  TEMPLATE_TOKENS,
  templatesForWaba,
  WHATSAPP_VERTICALS,
  OPENING_DAYS,
  NESTCHAT_CARD_ICONS,
  nestchatHeaderBackground,
  NESTCHAT_MAX_HOME_CARDS,
  NESTCHAT_MAX_ROUTING_OPTIONS,
  fillVisitorName,
  fillVisitorText,
} from "@ding/schemas";
import {
  useContacts,
  useCreateCustomField,
  useCreateInbox,
  useCreateLabel,
  useCreateTeam,
  useCreateTemplate,
  useCreateUser,
  useDeleteInbox,
  useDeleteLabel,
  useDeleteTeam,
  useDeleteTemplate,
  useDeleteUser,
  useInboxes,
  useCustomFields,
  useDeleteCustomField,
  useLabels,
  useUpdateCustomField,
  useNestchatSettings,
  useUpdateNestchat,
  useUpdateLabel,
  useIntegrations,
  useMyWorkspaces,
  usePlatformWorkspaces,
  useCreateWorkspace,
  useManageWorkspace,
  useWorkspacePeople,
  api as platformApi,
  useMe,
  usePeople,
  useReorderInboxes,
  useReorderTeams,
  useRegisterWhatsappNumber,
  useRerouteInbox,
  useSetDefaultInbox,
  useSetInboxSignature,
  useSetDefaultTemplate,
  useSubmitTemplate,
  useSyncTemplates,
  useTeams,
  useTemplates,
  useUpdateInbox,
  useUpdateIntegrations,
  useUpdateTeam,
  useUpdateTemplate,
  useUpdateUser,
  useWhatsappProfile,
  useUpdateWhatsappProfile,
  useSetWhatsappProfilePhoto,
  useWhatsappOba,
  useRequestWhatsappOba,
  useResendUserInvite,
  useSendBroadcast,
  useEmailCutoverPreview,
  useEmailCutoverStatus,
  useRunEmailCutover,
} from "../hooks";
import { initials, avatarBg } from "../lib/format";
import { api } from "../lib/api";
import { loadedSdk, prepareCoexistenceSignup, runCoexistenceSignup } from "../lib/meta-signup";
import { BUSINESS_APP_FINISH_EVENT, WORKSPACE_DELETE_GRACE_DAYS, smsProviderConfigSchema, type CoexistenceSetup } from "@ding/schemas";
import { TEMPLATE_CATEGORIES, approvalMeta, countVariables } from "./TemplatePicker";
import {
  BellIcon,
  BoltIcon,
  channelMeta,
  ChevronDown,
  ChevronUp,
  EditIcon,
  GmailGlyph,
  InboxIcon,
  OrganisationsIcon,
  MailIcon,
  PlusIcon,
  RefreshIcon,
  ReopenIcon,
  SearchIcon,
  SnoozeIcon,
  SparkleIcon,
  MicIcon,
  StarIcon,
  StorageIcon,
  TeamGlyph,
  TEAM_ICON_KEYS,
  TEAM_ICONS,
  TrashIcon,
  XIcon,
  AlertIcon,
} from "../lib/icons";

/** A settings destination. Leaves are grouped into the left-rail primary
 *  sections; each section surfaces its leaves as the top sub-navigation. */
type Leaf =
  | "channels"
  | "nestchat"
  | "templates"
  | "macros"
  | "profile"
  | "broadcast"
  | "gmail"
  | "teams"
  | "people"
  | "labels"
  | "fields"
  | "modules"
  | "workspaces"
  | "connections"
  | "storage"
  | "email"
  | "ai"
  | "push";
type SetupSub = "connections" | "storage" | "email" | "ai" | "push";
/** The integrations that open a credential sheet from their card. */
type SetupKey = "google" | "meta" | "storage" | "resend" | "smtp" | "anthropic" | "transcription" | "push";

interface Props {
  onClose: () => void;
  onToast: (msg: string) => void;
}

interface NavSection {
  key: string;
  label: string;
  Icon: ComponentType;
  leaves: { key: Leaf; label: string }[];
  /** The platform's own settings: shown to its owners only. */
  ownerOnly?: boolean;
}

/** Left-rail sections (primary nav) → their sub-nav leaves (secondary nav).
 *  A section's first leaf is what its rail button opens. */
const NAV: NavSection[] = [
  {
    key: "messaging",
    label: "Messaging",
    Icon: InboxIcon,
    leaves: [
      { key: "channels", label: "Channels" },
      { key: "nestchat", label: "NestChat widget" },
      { key: "templates", label: "Templates" },
      { key: "macros", label: "Macros" },
      { key: "profile", label: "Business profile" },
      { key: "broadcast", label: "Broadcast" },
      { key: "gmail", label: "Move from Gmail" },
    ],
  },
  {
    key: "org",
    label: "Organisation",
    Icon: TeamGlyph,
    leaves: [
      { key: "teams", label: "Teams" },
      { key: "people", label: "People" },
      { key: "labels", label: "Labels" },
      { key: "fields", label: "Custom fields" },
      { key: "modules", label: "Modules" },
    ],
  },
  {
    key: "workspaces",
    label: "Workspaces",
    Icon: OrganisationsIcon,
    ownerOnly: true,
    leaves: [{ key: "workspaces", label: "All workspaces" }],
  },
  {
    key: "integrations",
    label: "Integrations",
    Icon: BoltIcon,
    ownerOnly: true,
    leaves: [
      { key: "connections", label: "Connections" },
      { key: "storage", label: "Storage" },
      { key: "email", label: "Email" },
      { key: "ai", label: "AI" },
      { key: "push", label: "Push" },
    ],
  },
];

/** Per-sub heading + blurb for the Integrations panes (one component, four sub-tabs). */
const SETUP_HEAD: Record<SetupSub, { h: string; p: string }> = {
  connections: {
    h: "Connections",
    p: "App-level OAuth credentials behind one-click channel connections, set once for the whole workspace.",
  },
  storage: {
    h: "Storage",
    p: "Where sent & received media — photos, files and voice notes — is stored.",
  },
  email: {
    h: "Email",
    p: "The app’s own transactional email: invites, password resets and the test send.",
  },
  ai: {
    h: "AI assist",
    p: "Claude writes nothing on its own — it polishes what an agent has already drafted, on request.",
  },
  push: {
    h: "Push notifications",
    p: "How a new message reaches the phone app, and the Firebase project it travels through.",
  },
};

const ROLES: { value: Role; label: string }[] = [
  { value: "agent", label: "Agent" },
  { value: "manager", label: "Manager" },
  { value: "admin", label: "Admin" },
];

const STRATEGIES: { value: RoutingStrategy; label: string }[] = [
  { value: "manual", label: "Queue (manual)" },
  { value: "round_robin", label: "Round robin" },
  { value: "load_balanced", label: "Load balanced" },
  { value: "most_idle", label: "Most idle" },
];

/** Show up to `max` team names, then "+N", so a person/channel on many teams
 *  can't blow out the row. Full list stays available via the title attribute. */
function summariseTeams(names: string[], max = 2): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max}`;
}

export function Settings({ onClose, onToast }: Props) {
  const [active, setActive] = useState<Leaf>("channels");
  // Moving from Gmail deletes conversations — admins only, so only they see it.
  const me = useMe();
  const isAdmin = me.data?.user.role === "admin";
  const leafShown = (key: Leaf) => key !== "gmail" || isAdmin;
  // Workspaces and the platform-wide integrations are the platform owners'.
  const owner = useMyWorkspaces().data?.platformOwner === true;
  const nav = NAV.filter((s) => owner || !s.ownerOnly);
  // The active primary section is whichever one owns the active leaf.
  const section = nav.find((s) => s.leaves.some((l) => l.key === active)) ?? nav[0];
  // Keep one pane key per section so switching *sub*-tabs within Integrations
  // doesn't remount SetupPane (it holds unsaved form state); switching sections
  // still swaps the key and plays the pane-in transition.
  const paneKey = section.key === "integrations" ? "integrations" : active;

  return (
    <div className="settings" role="region" aria-label="Settings">
      <header className="settings__head">
        <h1>Settings</h1>
        <button className="settings__x" onClick={onClose} aria-label="Close settings" title="Close">
          <XIcon />
        </button>
      </header>
      <div className="settings__body">
        <nav className="settings__nav" aria-label="Settings sections">
          {nav.map((s) => {
            const on = s.key === section.key;
            return (
              <button
                key={s.key}
                type="button"
                className={"setnav__item" + (on ? " active" : "")}
                aria-current={on ? "page" : undefined}
                onClick={() => setActive(s.leaves[0].key)}
              >
                <span className="setnav__ic">
                  <s.Icon />
                </span>
                <span className="setnav__lbl">{s.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="settings__main">
          <nav className="settings__sub" aria-label={`${section.label} settings`}>
            {section.leaves.filter((l) => leafShown(l.key)).map((l) => (
              <button
                key={l.key}
                type="button"
                className={"setsub__btn" + (active === l.key ? " active" : "")}
                aria-current={active === l.key ? "page" : undefined}
                onClick={() => setActive(l.key)}
              >
                {l.label}
              </button>
            ))}
          </nav>

          <div className="settings__pane" key={paneKey}>
            {active === "channels" && <ChannelsPane onToast={onToast} />}
            {active === "nestchat" && <NestChatPane onToast={onToast} />}
            {active === "templates" && <TemplatesPane onToast={onToast} />}
            {active === "macros" && <MacrosPane onToast={onToast} />}
            {active === "profile" && <ProfilePane onToast={onToast} />}
            {active === "broadcast" && <BroadcastPane onToast={onToast} />}
            {active === "gmail" && isAdmin && <GmailCutoverPane onToast={onToast} />}
            {active === "teams" && <TeamsPane onToast={onToast} />}
            {active === "people" && <PeoplePane onToast={onToast} />}
            {active === "labels" && <LabelsPane onToast={onToast} />}
            {active === "fields" && <CustomFieldsPane onToast={onToast} />}
            {active === "modules" && <OpsModulesPane onToast={onToast} />}
            {active === "workspaces" && owner && <WorkspacesPane onToast={onToast} />}
            {owner && (active === "connections" ||
              active === "storage" ||
              active === "email" ||
              active === "ai" ||
              active === "push") && <SetupPane sub={active} onToast={onToast} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Channels                                                            */
/* ------------------------------------------------------------------ */

interface ChannelField {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  optional?: boolean;
}
interface ChannelKind {
  type: ChannelType;
  label: string;
  desc: string;
  handleLabel: string;
  handlePlaceholder: string;
  fields: ChannelField[];
}

const CHANNEL_KINDS: ChannelKind[] = [
  {
    type: "whatsapp",
    label: "WhatsApp",
    desc: "A WhatsApp Business number via Meta — one click, or paste credentials.",
    handleLabel: "Business phone number",
    handlePlaceholder: "+44 20 7946 0100",
    fields: [
      { key: "phoneNumberId", label: "Phone number ID", placeholder: "1029384756…" },
      { key: "accessToken", label: "Access token", placeholder: "EAAG…", secret: true },
      { key: "wabaId", label: "WhatsApp Business Account ID", placeholder: "Optional", optional: true },
      { key: "verifyToken", label: "Webhook verify token", placeholder: "A phrase you choose", optional: true },
    ],
  },
  {
    type: "nestchat",
    label: "NestChat",
    desc: "Our own live chat, embedded on your website. Nothing to connect — it's ours.",
    handleLabel: "Website",
    handlePlaceholder: "swiftee.co.uk",
    // No credentials: there is no third party to authenticate with. The widget
    // key that identifies this channel is minted for us, not pasted in.
    fields: [],
  },
  {
    type: "sms",
    label: "SMS",
    desc: "Text messages through any SMS provider — DialMyCalls, Twilio, or any other with a REST API.",
    handleLabel: "Sender number or ID",
    handlePlaceholder: "+15551234567",
    // The provider settings have their own editor (SmsChannel.tsx).
    fields: [],
  },
  {
    type: "email",
    label: "Email inbox",
    desc: "A shared mailbox, forwarded into NestConnect.",
    handleLabel: "Inbox address",
    handlePlaceholder: "support@swiftee.co.uk",
    fields: [
      { key: "providerToken", label: "Postmark server token", placeholder: "server-token…", secret: true },
      { key: "fromName", label: "From name", placeholder: "Swiftee Support", optional: true },
    ],
  },
];

function ChannelsPane({ onToast }: { onToast: (msg: string) => void }) {
  const inboxes = useInboxes();
  const teams = useTeams();
  const del = useDeleteInbox();
  const reorder = useReorderInboxes();
  const [connecting, setConnecting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // A channel just connected, however it was added: once it is in the list,
  // the connect dialog gives way to its settings. It used to wait for a
  // matching handle, and a WhatsApp number's handle is Meta's id for it rather
  // than the number the pop-up reported — so the dialog stayed on "Connect a
  // channel" until the page was refreshed.
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const teamName = (id: string) => teams.data?.find((t) => t.id === id)?.name ?? id;

  useEffect(() => {
    if (!justAdded || !inboxes.data?.some((i) => i.id === justAdded)) return;
    setConnecting(false);
    setEditingId(justAdded);
    setJustAdded(null);
  }, [justAdded, inboxes.data]);

  const remove = (id: string, name: string) => {
    if (!window.confirm(`Delete “${name}”? This removes the channel and its conversations.`)) return;
    del.mutate(id, {
      onSuccess: () => { setEditingId(null); onToast(`Channel “${name}” deleted`); },
      onError: () => onToast("Only admins & managers can delete channels"),
    });
  };

  // Already in the order the server decided; named so the arrows have
  // something to index into and the count has something to count.
  const ordered = inboxes.data ?? [];
  const move = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= ordered.length) return;
    const ids = ordered.map((i) => i.id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    reorder.mutate(ids, { onError: () => onToast("Only admins & managers can reorder channels") });
  };

  const editingInbox = ordered.find((i) => i.id === editingId) ?? null;

  return (
    <div className="setpane setpane--wide">
      <div className="setpane__head">
        <div>
          <h2>Channels <span className="setcount">{ordered.length}</span></h2>
          <p>WhatsApp numbers and shared email inboxes. Each routes to one or more teams. The arrows set the order they appear in everyone's sidebar.</p>
        </div>
        <button className="btn-primary" onClick={() => setConnecting(true)}>
          <PlusIcon /> Add channel
        </button>
      </div>

      <div className="cardgrid">
        {ordered.map((i, idx) => {
          const cm = channelMeta(i.type);
          const Glyph = cm.Glyph;
          const connected = i.connected !== false;
          return (
            <div className="chcard__wrap" key={i.id}>
            {/* Beside the card rather than inside it: the card is itself a
                button that opens the editor, and a button inside a button is
                not a thing a browser will render. */}
            <span className="chcard__ord">
              <button
                className="iconbtn"
                title="Move up in the sidebar"
                aria-label={`Move ${i.name} up`}
                disabled={idx === 0 || reorder.isPending}
                onClick={() => move(idx, -1)}
              >
                <ChevronUp />
              </button>
              <button
                className="iconbtn"
                title="Move down in the sidebar"
                aria-label={`Move ${i.name} down`}
                disabled={idx === ordered.length - 1 || reorder.isPending}
                onClick={() => move(idx, 1)}
              >
                <ChevronDown />
              </button>
            </span>
            <button className="chcard" onClick={() => setEditingId(i.id)}>
              <div className="chcard__top">
                <span className="chcard__ic" style={{ color: cm.color }}>
                  <Glyph />
                </span>
                <span className="chcard__name">
                  <b>{i.name}</b>
                  <small>
                    {i.channelConfigPublic?.coexistence === "true"
                      ? `${i.channelConfigPublic.displayNumber ?? i.handle} · Business app`
                      : i.handle}
                  </small>
                </span>
              </div>
              <div className="chcard__foot">
                <span className="chcard__route" title={i.teamIds.map(teamName).join(", ")}>
                  {summariseTeams(i.teamIds.map(teamName)) || "Unrouted"} · {i.routingStrategy.replace(/_/g, " ")}
                </span>
                {i.signedOut ? (
                  <span className="connpill bad" title={`${i.signedOut.reason}. Open it to reconnect.`}>
                    <span className="connpill__dot" />
                    Reconnect needed
                  </span>
                ) : i.channelConfigPublic?.coexistenceState === "disconnected" ? (
                  <span className="connpill bad" title="Meta says this number is no longer linked to the WhatsApp Business app. Connect it again.">
                    <span className="connpill__dot" />
                    Reconnect needed
                  </span>
                ) : (
                  <span className={"connpill " + (connected ? "on" : "off")} title={connected ? "Integration live" : "Add credentials to go live"}>
                    <span className="connpill__dot" />
                    {connected ? "Connected" : "Setup needed"}
                  </span>
                )}
              </div>
            </button>
            </div>
          );
        })}
        <button className="chcard chcard--add" onClick={() => setConnecting(true)}>
          <PlusIcon />
          <span>Add a channel</span>
        </button>
      </div>

      {connecting && (
        <ConnectChannel
          onDone={() => setConnecting(false)}
          onConnected={setJustAdded}
          onToast={onToast}
        />
      )}
      {editingInbox && (
        <ChannelEditor
          inbox={editingInbox}
          onDone={() => setEditingId(null)}
          onDelete={() => remove(editingInbox.id, editingInbox.name)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

function ChannelEditor({
  inbox,
  onDone,
  onDelete,
  onToast,
}: {
  inbox: Inbox;
  onDone: () => void;
  onDelete: () => void;
  onToast: (msg: string) => void;
}) {
  const teams = useTeams();
  const update = useUpdateInbox();
  const reroute = useRerouteInbox();
  const setDefault = useSetDefaultInbox();
  const allInboxes = useInboxes();
  // The other channels of this type — what makes "which one?" a real question.
  const siblings = (allInboxes.data ?? []).filter((i) => i.type === inbox.type);
  const defaultSibling = siblings.find((i) => i.isDefault);
  const kind = CHANNEL_KINDS.find((k) => k.type === inbox.type);
  const [name, setName] = useState(inbox.name);
  const [teamIds, setTeamIds] = useState<string[]>(inbox.teamIds);
  const [strategy, setStrategy] = useState<RoutingStrategy>(inbox.routingStrategy);
  // Filed on whatever starts here: a tag on the customer, a label on the
  // conversation. Applied once, when the conversation starts, so taking either
  // off by hand sticks.
  const labels = useLabels();
  const [contactTag, setContactTag] = useState(inbox.contactTag ?? "");
  const [labelId, setLabelId] = useState(inbox.conversationLabelId ?? "");
  // Pre-fill the non-secret config (e.g. Phone number ID) so it's visible and
  // verifiable; secret fields (tokens) stay blank and are kept unless re-entered.
  const [cfg, setCfg] = useState<Record<string, string>>(inbox.channelConfigPublic ?? {});
  const [moveOpen, setMoveOpen] = useState(false);
  // Email channels sign their mail; the design lives on its own tab and is
  // saved by the same button as everything else here.
  const isEmail = inbox.type === "email";
  const isGmail = isEmail && inbox.channelConfigPublic?.provider === "gmail";
  const reconnect = useReconnectEmail(onToast);
  const [askReconnect, setAskReconnect] = useState(false);
  const [tab, setTab] = useState<"settings" | "signature">("settings");
  const [sig, setSig] = useState<SignatureDraft>(() => signatureDraftFor(inbox));
  const saveSig = useSetInboxSignature();

  const setField = (k: string, v: string) => setCfg((c) => ({ ...c, [k]: v }));
  const toggleTeam = (id: string) =>
    setTeamIds((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const valid = name.trim().length > 0 && teamIds.length > 0;
  // Did the team routing actually change? (order-independent)
  const teamsChanged = [...teamIds].sort().join(",") !== [...inbox.teamIds].sort().join(",");

  const save = async () => {
    if (isEmail && sig.dirty) {
      try {
        await saveSig.mutateAsync({ id: inbox.id, input: signatureInput(sig) });
        setSig((d) => ({ ...d, dirty: false }));
      } catch (err) {
        onToast(err instanceof Error ? err.message : "Couldn’t save the signature");
        return;
      }
    }
    const channelConfig: Record<string, string> = {};
    for (const f of kind?.fields ?? []) {
      const v = (cfg[f.key] ?? "").trim();
      if (v) channelConfig[f.key] = v;
    }
    const wantsMove = teamsChanged && moveOpen;
    update.mutate(
      {
        id: inbox.id,
        input: {
          name: name.trim(),
          teamIds,
          routingStrategy: strategy,
          contactTag: contactTag.trim(),
          conversationLabelId: labelId || null,
          ...(Object.keys(channelConfig).length ? { channelConfig } : {}),
        },
      },
      {
        onSuccess: () => {
          if (wantsMove) {
            // Team routing changed and the admin opted in → move existing open chats.
            reroute.mutate(inbox.id, {
              onSuccess: (r) => {
                onToast(r.moved ? `Channel updated — ${r.moved} open chat${r.moved === 1 ? "" : "s"} moved` : "Channel updated");
                onDone();
              },
              onError: () => { onToast("Channel updated, but couldn't move existing chats"); onDone(); },
            });
          } else {
            onToast("Channel updated");
            onDone();
          }
        },
        onError: () => onToast("Only admins & managers can edit channels"),
      },
    );
  };

  return (
    <div className="modal" onClick={onDone}>
      <div className="modal__box modal--form" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>Edit channel</h2>
          <button type="button" className="modal__x" onClick={onDone} aria-label="Close"><XIcon /></button>
        </div>
        {isEmail && (
          <div className="pers-tabs" role="tablist" aria-label="Channel sections">
            <button type="button" role="tab" aria-selected={tab === "settings"} className={"pers-tab" + (tab === "settings" ? " on" : "")} onClick={() => setTab("settings")}>
              Settings
            </button>
            <button type="button" role="tab" aria-selected={tab === "signature"} className={"pers-tab" + (tab === "signature" ? " on" : "")} onClick={() => setTab("signature")}>
              Signature
            </button>
          </div>
        )}
        <div className="modal__body">
      {tab === "signature" && <ChannelSignature inbox={inbox} draft={sig} onChange={setSig} onToast={onToast} />}
      <div hidden={tab !== "settings"}>
      <div className="setform__grid two">
        <label className="field">
          <span>Display name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={inbox.handle} />
        </label>
        <label className="field">
          <span>Assignment</span>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as RoutingStrategy)}>
            {STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span>Route to team(s)</span>
        <div className="checks">
          {teams.data?.map((t) => (
            <label key={t.id} className={"check" + (teamIds.includes(t.id) ? " on" : "")}>
              <input type="checkbox" checked={teamIds.includes(t.id)} onChange={() => toggleTeam(t.id)} />
              {t.name}
            </label>
          ))}
        </div>
      </div>
      {teamsChanged && (
        <label className="reroutecheck">
          <input type="checkbox" checked={moveOpen} onChange={(e) => setMoveOpen(e.target.checked)} />
          <span>Also move this channel’s open conversations to the new routing (chats on a team it no longer serves).</span>
        </label>
      )}
      <div className="setform__grid two">
        <label className="field">
          <span>Tag every customer from here</span>
          <input
            value={contactTag}
            onChange={(e) => setContactTag(e.target.value)}
            placeholder="e.g. Ding"
            maxLength={40}
          />
          <em className="fieldhint">Added to the customer when they start a conversation here.</em>
        </label>
        <label className="field">
          <span>Label every conversation from here</span>
          <select value={labelId} onChange={(e) => setLabelId(e.target.value)}>
            <option value="">No label</option>
            {(labels.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <em className="fieldhint">Put on each new conversation that starts here. Labels live in Settings › Labels.</em>
        </label>
      </div>
      {/* Which of several numbers/mailboxes this channel replies from.

          Only shown when there is more than one of the type, because with one
          there is nothing to choose and the control would be a question with a
          single answer. See `sendingInbox`: this is consulted when a reply is
          switched onto a channel the thread didn't start on, which is the only
          time the thread's own inbox can't answer. */}
      {siblings.length > 1 && (
        <div className="field">
          <span>Send replies from</span>
          <label className="reroutecheck">
            <input
              type="checkbox"
              checked={inbox.isDefault}
              disabled={setDefault.isPending}
              onChange={(e) => {
                setDefault.mutate(
                  { inboxId: inbox.id, isDefault: e.target.checked },
                  {
                    onSuccess: () =>
                      onToast(
                        e.target.checked
                          ? `Replies switched to ${kind?.label ?? inbox.type} will send from ${inbox.name}`
                          : "Cleared — the oldest of this channel will be used",
                      ),
                    onError: () => onToast("Couldn’t change the default"),
                  },
                );
              }}
            />
            <span>
              Use this one when a reply is switched onto {kind?.label ?? inbox.type} from another
              channel.{" "}
              {defaultSibling && !inbox.isDefault ? (
                <>Currently <b>{defaultSibling.name}</b>.</>
              ) : inbox.isDefault ? null : (
                <>Nothing is set, so the oldest is used.</>
              )}
            </span>
          </label>
        </div>
      )}
      {/* What Meta actually says about the number, and the one action that fixes
          the state everybody gets stuck in. Only for WhatsApp: no other channel
          has a registration step. */}
      {inbox.type === "whatsapp" && inbox.channelConfigPublic?.coexistence === "true" ? (
        <CoexistenceBox inbox={inbox} />
      ) : (
        inbox.type === "whatsapp" && <WhatsAppRegistration channelId={inbox.id} onToast={onToast} />
      )}
      {/* A Gmail mailbox is signed in with Google, not set up with a token —
          so it gets its sign-in state and a way to sign in again, and not the
          Postmark token field, which would have overwritten its access token. */}
      {isGmail && (
        <div className={"reauth-box" + (inbox.signedOut ? " bad" : "")}>
          {inbox.signedOut ? (
            <>
              <div className="reauth-box__head">
                <AlertIcon /> Google signed this mailbox out{inbox.signedOut.since ? ` ${signedOutSince(inbox.signedOut.since)}` : ""}
              </div>
              <p>
                {inbox.signedOut.reason}. New email isn't arriving and replies can't be sent. Reconnect with{" "}
                <b>{inbox.handle}</b> — the channel keeps its conversations, routing and signature, and you choose whether the
                email that arrived meanwhile is brought in.
              </p>
            </>
          ) : (
            <p>
              Signed in with Google as <b>{inbox.handle}</b>. If it ever stops working, reconnect here — nothing on the channel is lost.
            </p>
          )}
          <div className="reauth-box__actions">
            <button
              type="button"
              className={inbox.signedOut ? "btn-primary" : "btn-ghost"}
              onClick={() => (inbox.signedOut ? setAskReconnect(true) : reconnect(inbox))}
            >
              {inbox.signedOut ? "Reconnect with Google" : "Reconnect"}
            </button>
            {!inbox.signedOut && <PullMissedEmail inbox={inbox} onToast={onToast} />}
          </div>
          {askReconnect && inbox.signedOut && (
            <ReconnectEmailDialog inbox={inbox} onClose={() => setAskReconnect(false)} onToast={onToast} />
          )}
        </div>
      )}
      {inbox.type === "sms" && <SmsProviderPanel inboxId={inbox.id} onToast={onToast} />}
      {kind && kind.fields.length > 0 && !isGmail && (
        <div className="connect__creds">
          <div className="connect__credhead">Update credentials <em>— leave blank to keep current</em></div>
          <div className="setform__grid two">
            {kind.fields.map((f) => (
              <label className="field" key={f.key}>
                <span>{f.label}</span>
                <input
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  value={cfg[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.secret ? "leave blank to keep current" : f.placeholder}
                />
              </label>
            ))}
          </div>
        </div>
      )}
      </div>
        </div>
        <div className="modal__foot modal__foot--split">
          <button className="btn-ghost btn-danger" type="button" onClick={onDelete}>
            <TrashIcon /> Delete channel
          </button>
          <div className="setform__footactions">
            <button className="btn-ghost" type="button" onClick={onDone}>Cancel</button>
            <button className="btn-primary" type="button" onClick={() => void save()} disabled={update.isPending || reroute.isPending || saveSig.isPending || !valid}>
              Save changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A WhatsApp number that's on the WhatsApp Business app as well (Meta's
 * coexistence): what it is, where its history import stands, and whether Meta
 * still has it linked. In place of the registration box — this number must
 * never be put through the API's register step.
 */
function CoexistenceBox({ inbox }: { inbox: Inbox }) {
  const pub = inbox.channelConfigPublic ?? {};
  const disconnected = pub.coexistenceState === "disconnected";
  const sync = pub.coexistenceSync ?? "";
  const when = (iso: string) => {
    const d = new Date(iso.trim());
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };
  const syncLine = sync.startsWith("history imported")
    ? `Chat history imported ${when(sync.replace("history imported", ""))}.`
    : sync.startsWith("requested")
      ? `History and contacts requested from Meta ${when(sync.replace("requested", ""))} — they arrive over the next minutes to hours, as closed past conversations.`
      : sync.startsWith("history not shared")
        ? "The chat history wasn’t shared when the number was connected, so only new messages appear here."
        : sync.startsWith("failed")
          ? `Asking Meta for the history failed (${sync.replace(/^failed:\s*/, "")}). Meta only allows it in the first 24 hours after connecting.`
          : "";
  return (
    <div className={"reauth-box" + (disconnected ? " bad" : "")}>
      <b>{disconnected ? "No longer linked to the WhatsApp Business app" : "On the WhatsApp Business app as well"}</b>
      <p className="fieldhint">
        {disconnected
          ? "Meta says this number was disconnected from the app (or from us). New messages won’t arrive until it’s connected again from Settings › Channels › Connect a channel › WhatsApp Business app."
          : "Replies sent from the phone show here labelled “WhatsApp Business app”, and messages sent here arrive on the phone. Open the app on the phone at least every couple of weeks, or Meta unlinks it."}
      </p>
      {syncLine && <p className="fieldhint">{syncLine}</p>}
    </div>
  );
}

function ConnectChannel({
  onDone,
  onConnected,
  onToast,
}: {
  onDone: () => void;
  /** The new channel's id; its settings open in place of this dialog. */
  onConnected: (inboxId: string) => void;
  onToast: (msg: string) => void;
}) {
  const teams = useTeams();
  const inboxes = useInboxes();
  const create = useCreateInbox();
  const registerNumber = useRegisterWhatsappNumber();
  const qc = useQueryClient();
  const [kind, setKind] = useState<ChannelKind | null>(null);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [smsCfg, setSmsCfg] = useState(() => smsDefaults());
  const [smsSecret, setSmsSecret] = useState("");
  /*
   * The two-step verification PIN, kept apart from `cfg` on purpose.
   *
   * Everything in `cfg` is written to the channel's stored config on submit.
   * This must not be: it is used for one call to Meta and discarded. Keeping it
   * in its own state is what makes that structural rather than a rule somebody
   * has to remember when they next edit the submit handler.
   */
  const [pin, setPin] = useState("");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<RoutingStrategy>("manual");

  const setField = (k: string, v: string) => setCfg((c) => ({ ...c, [k]: v }));
  const toggleTeam = (id: string) =>
    setTeamIds((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  // The channels there were when a sign-in pop-up opened. The pop-up says when
  // it's done, but a provider's sign-in page can cut it off from this window,
  // and then nothing arrives. So coming back to this window looks again, and
  // a channel that wasn't there before is the one just connected.
  const awaiting = useRef<Set<string> | null>(null);

  // Gmail & WhatsApp skip the manual credential form entirely: they run the
  // provider's consent flow in a popup, which lands on our callback and creates
  // the inbox itself.
  const connectOAuth = (path: string, label: string) => {
    const popup = window.open(path, "channel-oauth", "width=560,height=720,menubar=no,toolbar=no");
    if (!popup) return onToast(`Allow pop-ups for this site to connect ${label}`);
    awaiting.current = new Set((inboxes.data ?? []).map((i) => i.id));
  };

  useEffect(() => {
    const seen = awaiting.current;
    const added = seen && inboxes.data?.find((i) => !seen.has(i.id));
    if (!added) return;
    awaiting.current = null;
    onToast("Connected — choose where it routes");
    onConnected(added.id);
  }, [inboxes.data, onConnected, onToast]);
  useEffect(() => {
    const look = () => {
      if (awaiting.current) void qc.invalidateQueries({ queryKey: ["inboxes"] });
    };
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, [qc]);
  const connectGmail = () => connectOAuth("/api/channels/google/oauth/start", "Gmail");
  // An inbox on the platform's own mail service is the platform's alone; every
  // other workspace connects its email through Gmail.
  const hostedEmail = useMyWorkspaces().data?.workspaces.some((w) => w.current && w.platform) ?? false;
  const connectWhatsApp = () => connectOAuth("/api/channels/meta/oauth/start", "WhatsApp");

  // A WhatsApp Business app number (coexistence). Meta's sign-up must open
  // straight from the click or the browser blocks it, so its setup and SDK are
  // loaded the moment this dialog opens, ahead of any click.
  const [coexSetup, setCoexSetup] = useState<CoexistenceSetup | null>(null);
  const [coexBusy, setCoexBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .coexistenceSetup()
      .then((setup) => {
        if (!live) return;
        setCoexSetup(setup);
        if (setup.ready && !setup.mock) void prepareCoexistenceSignup(setup).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const finishCoexistence = async (result: { code: string; wabaId: string; phoneNumberId: string; finishEvent: string }) => {
    const res = await api.connectCoexistence(result);
    qc.invalidateQueries({ queryKey: ["inboxes"] });
    qc.invalidateQueries({ queryKey: ["views"] });
    if (!res.coexistence) {
      // Meta added it as an ordinary API number, not one that stays on the
      // phone. The editor shows it as such, with the Register step it needs.
      onToast(
        `Meta added ${res.displayNumber} as a regular WhatsApp API number — it isn’t linked to the WhatsApp Business app. Registering it moves it off the phone app.`,
      );
    } else if (res.sync.startsWith("failed")) {
      onToast(`${res.displayNumber} connected — but asking Meta for its history failed. See the channel.`);
    }
    onConnected(res.inboxId);
  };
  const connectBusinessApp = () => {
    if (!coexSetup) return onToast("Still loading — try again in a moment");
    if (!coexSetup.ready) {
      return onToast("Add the Meta app ID, secret and Embedded Signup configuration ID in Settings › Setup first");
    }
    setCoexBusy(true);
    const run = coexSetup.mock
      ? Promise.resolve({
          code: "mock-code",
          wabaId: "100000000000001",
          phoneNumberId: "100000000000002",
          finishEvent: BUSINESS_APP_FINISH_EVENT,
        })
      : (() => {
          const fb = loadedSdk();
          if (!fb) {
            void prepareCoexistenceSignup(coexSetup).catch(() => undefined);
            return Promise.reject(new Error("Meta’s sign-up is still loading — try again in a moment"));
          }
          return runCoexistenceSignup(fb, coexSetup);
        })();
    run
      .then(finishCoexistence)
      .catch((err) => onToast((err as Error)?.message || "Couldn’t connect the WhatsApp Business app number"))
      .finally(() => setCoexBusy(false));
  };

  // The popup posts its result back to this window when it finishes.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as
        | { source?: string; ok?: boolean; provider?: string; email?: string; number?: string; inboxId?: string; error?: string }
        | null;
      if (!data || data.source !== "ding-oauth") return; // ignore unrelated messages
      awaiting.current = null;
      if (data.ok) {
        qc.invalidateQueries({ queryKey: ["inboxes"] });
        qc.invalidateQueries({ queryKey: ["views"] });
        const who = data.provider === "whatsapp" ? data.number || "WhatsApp" : data.email || "Gmail";
        onToast(`${who} connected — choose where it routes`);
        // Its settings open next, so the admin routes it straight away.
        if (data.inboxId) onConnected(data.inboxId);
        else onDone();
      } else {
        onToast(data.error || "Couldn't connect the channel");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [qc, onToast, onDone]);

  const requiredOk = kind
    ? kind.fields.filter((f) => !f.optional).every((f) => (cfg[f.key] ?? "").trim().length > 0)
    : false;
  const valid = Boolean(kind && handle.trim() && teamIds.length && requiredOk);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!kind || !valid) return;
    const channelConfig: Record<string, string> = {};
    for (const f of kind.fields) {
      const val = (cfg[f.key] ?? "").trim();
      if (val) channelConfig[f.key] = val;
    }
    if (kind.type === "sms") {
      const parsed = smsProviderConfigSchema.safeParse(smsCfg);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return onToast(`Check the SMS settings: ${issue?.path.join(".")} — ${issue?.message}`);
      }
      channelConfig.smsConfig = JSON.stringify(parsed.data);
      if (smsSecret) channelConfig.smsSecret = smsSecret;
    }
    create.mutate(
      {
        type: kind.type,
        name: name.trim() || handle.trim(),
        handle: handle.trim(),
        teamIds,
        routingStrategy: strategy,
        channelConfig,
      },
      {
        onSuccess: (inbox) => {
          // The channel exists now, so registration can use its stored
          // credentials rather than posting the token back out of the browser.
          // Skipped when no PIN was given: plenty of numbers are already
          // registered, and this step is only for the ones Meta left Pending.
          if (kind.type === "whatsapp" && pin.length === 6) {
            registerNumber.mutate(
              { channelId: inbox.id, pin },
              {
                onSettled: () => setPin(""),
                onSuccess: (r) => {
                  onToast(
                    r.ok
                      ? `${kind.label} connected and registered with Meta`
                      : `${kind.label} connected, but registration failed: ${r.state.detail}`,
                  );
                  onConnected(inbox.id);
                },
                onError: () => {
                  onToast(`${kind.label} connected, but the number couldn't be registered`);
                  onConnected(inbox.id);
                },
              },
            );
            return;
          }
          onToast(`${kind.label} connected`);
          onConnected(inbox.id);
        },
        onError: () => onToast("Only admins/managers can add channels"),
      },
    );
  };

  // Step 1 — pick a channel type.
  if (!kind) {
    return (
      <div className="modal" onClick={onDone}>
        <div className="modal__box modal--form" onClick={(e) => e.stopPropagation()}>
          <div className="modal__head">
            <h2>Connect a channel</h2>
            <button type="button" className="modal__x" onClick={onDone} aria-label="Close"><XIcon /></button>
          </div>
          <div className="modal__body">
        <div className="kindgrid">
          {CHANNEL_KINDS.filter((k) => k.type !== "email" || hostedEmail).map((k) => {
            const cm = channelMeta(k.type);
            const Glyph = cm.Glyph;
            return (
              <button key={k.type} className="kindcard" onClick={() => setKind(k)}>
                <span className="kindcard__ic" style={{ color: cm.color }}>
                  <Glyph />
                </span>
                <b>{k.label}</b>
                <small>{k.desc}</small>
              </button>
            );
          })}
          <button className="kindcard" onClick={connectGmail}>
            <span className="kindcard__ic" style={{ color: "#EA4335" }}>
              <GmailGlyph />
            </span>
            <b>Gmail</b>
            <small>Connect with Google — one click, no tokens to copy.</small>
          </button>
          {(() => {
            const wa = channelMeta("whatsapp");
            const WaGlyph = wa.Glyph;
            return (
              <button className="kindcard" onClick={connectBusinessApp} disabled={coexBusy}>
                <span className="kindcard__ic" style={{ color: wa.color }}>
                  <WaGlyph />
                </span>
                <b>WhatsApp Business app</b>
                <small>
                  {coexBusy
                    ? "Finishing with Meta…"
                    : "Your number on the WhatsApp Business app — it keeps working on the phone too. Scan a QR code, nothing to copy."}
                </small>
              </button>
            );
          })()}
        </div>
          </div>
        </div>
      </div>
    );
  }

  // Step 2 — integration details.
  const cm = channelMeta(kind.type);
  const Glyph = cm.Glyph;
  return (
    <div className="modal" onClick={onDone}>
      <form className="modal__box modal--form" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="connect__kind">
            <span className="setrow__ic" style={{ color: cm.color }}><Glyph /></span>
            {kind.label}
          </span>
          <div className="connect__headacts">
            <button className="btn-ghost sm" type="button" onClick={() => { setKind(null); setCfg({}); }}>Change</button>
            <button type="button" className="modal__x" onClick={onDone} aria-label="Close"><XIcon /></button>
          </div>
        </div>
        <div className="modal__body">
      <div className="setform__grid two">
        <label className="field">
          <span>{kind.handleLabel}</span>
          <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={kind.handlePlaceholder} required />
        </label>
        <label className="field">
          <span>Display name <em>optional</em></span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={handle || "Shown in the sidebar"} />
        </label>
      </div>

      {kind.type === "whatsapp" && (
        <div style={{ display: "grid", gap: 8, margin: "4px 0 2px" }}>
          <button type="button" className="btn-primary" onClick={connectWhatsApp}>
            Connect with Facebook — one click
          </button>
          <div className="fieldhint" style={{ textAlign: "center" }}>
            — or paste your number’s Phone number ID + Access token from Meta’s API Setup page below —
          </div>
        </div>
      )}

      {kind.type === "sms" && (
        <div className="connect__creds">
          <div className="connect__credhead">SMS provider</div>
          <SmsConfigEditor value={smsCfg} onChange={setSmsCfg} secret={smsSecret} onSecret={setSmsSecret} onToast={onToast} />
        </div>
      )}

      {kind.fields.length > 0 && (
      <div className="connect__creds">
        <div className="connect__credhead">Integration</div>
        <div className="setform__grid two">
          {kind.fields.map((f) => (
            <label className="field" key={f.key}>
              <span>
                {f.label} {f.optional && <em>optional</em>}
              </span>
              <input
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                value={cfg[f.key] ?? ""}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
              />
            </label>
          ))}
        </div>
        {/* Optional, because a number Meta has already registered needs nothing
            here — and required in practice for the ones it hasn't, which is why
            the hint says which case is which rather than leaving somebody to
            discover it from a "Pending" badge later. */}
        {kind.type === "whatsapp" && (
          <div className="connect__pin">
            <WhatsAppPinField value={pin} onChange={setPin} optional />
            <p className="fieldhint">
              Only needed if Meta shows this number as <b>Pending</b> — “please register this phone number
              using the registration API”. You can also do it later from the channel’s settings.
            </p>
          </div>
        )}
      </div>
      )}

      <div className="setform__grid two">
        <div className="field">
          <span>Route to team(s)</span>
          <div className="checks">
            {teams.data?.map((t) => (
              <label key={t.id} className={"check" + (teamIds.includes(t.id) ? " on" : "")}>
                <input type="checkbox" checked={teamIds.includes(t.id)} onChange={() => toggleTeam(t.id)} />
                {t.name}
              </label>
            ))}
          </div>
        </div>
        <label className="field">
          <span>Assignment</span>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as RoutingStrategy)}>
            {STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>

        </div>
        <div className="modal__foot">
          <button className="btn-ghost" type="button" onClick={onDone}>Cancel</button>
          <button className="btn-primary" type="submit" disabled={create.isPending || !valid}>
            Connect channel
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Teams                                                               */
/* ------------------------------------------------------------------ */

/** First-response SLA presets offered per team (stored as minutes). */
const SLA_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: "No SLA", minutes: null },
  { label: "5 minutes", minutes: 5 },
  { label: "10 minutes", minutes: 10 },
  { label: "15 minutes", minutes: 15 },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "4 hours", minutes: 240 },
  { label: "8 hours", minutes: 480 },
  { label: "1 day", minutes: 1440 },
  { label: "48 hours", minutes: 2880 },
];

/** Short human label for an SLA target, e.g. 90 → "1h 30m". */
export function slaLabel(minutes?: number | null): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

const LABEL_COLORS = ["#0FA47A", "#E68A00", "#5B8DEF", "#A06CF2", "#EF5B8D", "#E5484D", "#0EA5E9", "#8A968F"];

/** The types a field can be, in the order they're offered. */
const FIELD_TYPES: Array<{ value: CustomFieldType; label: string; hint: string }> = [
  { value: "text", label: "Text", hint: "An order number, a reference, a note" },
  { value: "number", label: "Number", hint: "A count or an amount" },
  { value: "date", label: "Date", hint: "A delivery date, a renewal" },
  { value: "url", label: "Link", hint: "Somewhere to click through to" },
  { value: "select", label: "Choice", hint: "One of a fixed set" },
];

/**
 * Where a workspace defines the facts we did not think of.
 *
 * The distinction the form asks for first is which record a field hangs off,
 * because it is the one people get wrong — and changing it afterwards clears
 * whatever was already recorded, which can't follow the field to the other
 * kind of record. A fact about the *person* should be on the contact — their account
 * number belongs to them and should surface every chat they have ever had. A
 * fact about *this conversation* belongs on the thread: the order a chat is
 * about is that chat's, and putting it on the contact would mean last week's
 * complaint silently relabelled itself when they ordered again tonight.
 */
function CustomFieldsPane({ onToast }: { onToast: (msg: string) => void }) {
  const fields = useCustomFields();
  const inboxes = useInboxes();
  const create = useCreateCustomField();
  const update = useUpdateCustomField();
  const del = useDeleteCustomField();

  const [label, setLabel] = useState("");
  const [entity, setEntity] = useState<CustomFieldEntity>("conversation");
  const [type, setType] = useState<CustomFieldType>("text");
  const [options, setOptions] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftInboxIds, setDraftInboxIds] = useState<string[]>([]);
  const [draftEntity, setDraftEntity] = useState<CustomFieldEntity>("conversation");

  const list = fields.data ?? [];
  const live = list.filter((f) => !f.archived);
  const archived = list.filter((f) => f.archived);

  /**
   * The key an integration will send, derived from the label.
   *
   * Derived rather than typed, because two things have to be true at once: it
   * has to be a valid identifier, and whoever adds the field is thinking about
   * the words on the screen, not about what an SDK payload looks like. It is
   * shown live so the derivation is never a surprise — this is the string that
   * goes into somebody's app and can never change afterwards.
   */
  const keyFor = (text: string) =>
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "f_$1")
      .slice(0, 40);
  const key = keyFor(label);
  const clash = live.some((f) => f.key === key) || archived.some((f) => f.key === key);
  const optionList = options.split("\n").map((o) => o.trim()).filter(Boolean);
  const canAdd = Boolean(key) && !clash && (type !== "select" || optionList.length > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    create.mutate(
      // Filterable from the start. Somebody defining a field right now has a
      // reason to look for it, and a toggle they must find afterwards to make
      // the thing they just made useful is a step with no decision in it. The
      // switch on its row is how it comes back off.
      { key, label: label.trim(), type, entity, options: optionList, inboxIds: [], filterable: true },
      {
        onSuccess: () => {
          setLabel("");
          setOptions("");
          onToast(`“${label.trim()}” added — integrations send it as ${key}`);
        },
        onError: (err) =>
          onToast(err instanceof Error ? err.message : "Only admins & managers can add fields"),
      },
    );
  };

  const startEdit = (f: CustomField) => {
    setEditingId(f.id);
    setDraftLabel(f.label);
    setDraftInboxIds(f.inboxIds);
    setDraftEntity(f.entity);
  };
  const saveEdit = (f: CustomField, discardValues = false) => {
    const next = draftLabel.trim();
    if (!next) return;
    const moving = draftEntity !== f.entity;
    update.mutate(
      {
        id: f.id,
        input: {
          label: next,
          inboxIds: draftInboxIds,
          ...(moving ? { entity: draftEntity, ...(discardValues ? { discardValues: true } : {}) } : {}),
        },
      },
      {
        onSuccess: () => {
          setEditingId(null);
          onToast(
            moving
              ? `“${next}” now belongs to ${draftEntity === "conversation" ? "the conversation" : "the customer"}`
              : "Field updated",
          );
        },
        onError: (err) => {
          // Values already recorded hang off records of the old kind and can't
          // follow the field, so the server stops and says how many. Asked
          // once, spelled out, then sent again with the go-ahead.
          if (moving && !discardValues && (err as { status?: number }).status === 409) {
            const from = f.entity === "conversation" ? "conversations" : "customers";
            if (
              window.confirm(
                `${err.message}.\n\nThey were recorded on ${from}, and can't move with the field. ` +
                  `Change “${next}” anyway and clear them?`,
              )
            ) {
              saveEdit(f, true);
            }
            return;
          }
          onToast(err instanceof Error ? err.message : "Couldn’t update the field");
        },
      },
    );
  };
  const setFilterable = (f: CustomField, on: boolean) =>
    update.mutate(
      { id: f.id, input: { filterable: on } },
      {
        onSuccess: () =>
          onToast(
            on
              ? `“${f.label}” added to the inbox filters`
              : `“${f.label}” removed from the inbox filters`,
          ),
        onError: (err) => onToast(err instanceof Error ? err.message : "Couldn’t change the field"),
      },
    );
  const setArchived = (f: CustomField, archivedNow: boolean) =>
    update.mutate(
      { id: f.id, input: { archived: archivedNow } },
      {
        onSuccess: () =>
          onToast(
            archivedNow
              ? `“${f.label}” retired — what was recorded is kept`
              : `“${f.label}” is back in use`,
          ),
        onError: (err) => onToast(err instanceof Error ? err.message : "Couldn’t change the field"),
      },
    );
  const remove = (f: CustomField) => {
    // Spelled out rather than a bare "are you sure": this destroys recorded
    // history, and archiving — the reversible thing most people actually want —
    // is one button to the left.
    if (
      !window.confirm(
        `Delete “${f.label}” and every value recorded against it?\n\n` +
          `This cannot be undone. To stop it being used while keeping what's already there, retire it instead.`,
      )
    ) {
      return;
    }
    del.mutate(f.id, {
      onSuccess: () => { setEditingId(null); onToast(`“${f.label}” deleted`); },
      onError: (err) => onToast(err instanceof Error ? err.message : "Couldn’t delete the field"),
    });
  };

  const waInboxes = (inboxes.data ?? []).filter((i) => i.type !== "nestchat" || true);

  const Row = ({ f }: { f: CustomField }) => {
    const editing = editingId === f.id;
    return (
      <div className="dtable__row dtable__row--static" key={f.id}>
        <span className="dcell dcell__t">
          {editing ? (
            <input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              maxLength={60}
              autoFocus
            />
          ) : (
            f.label
          )}
          {/* The key never changes, so it is shown rather than hidden: it is
              what goes into somebody's app, and the person who needs to paste
              it into an SDK call is looking at this row. */}
          <code className="cfkey">{f.key}</code>
        </span>
        <span className="dcell">
          {editing ? (
            // Changeable, because picking the wrong one is easy and its symptom
            // is quiet: an app's conversation field set up on the customer is
            // dropped by the chat without a word on this screen.
            <select
              value={draftEntity}
              onChange={(e) => setDraftEntity(e.target.value as CustomFieldEntity)}
              aria-label="Belongs to"
            >
              <option value="conversation">Conversation</option>
              <option value="contact">Customer</option>
            </select>
          ) : (
            <span className="tpl-cat">{f.entity === "conversation" ? "Conversation" : "Customer"}</span>
          )}
        </span>
        <span className="dcell dcell--muted">
          {FIELD_TYPES.find((t) => t.value === f.type)?.label ?? f.type}
        </span>
        <span className="dcell dcell--muted">
          {editing ? (
            <div className="checks">
              {waInboxes.map((i) => (
                <label key={i.id} className={"check" + (draftInboxIds.includes(i.id) ? " on" : "")}>
                  <input
                    type="checkbox"
                    checked={draftInboxIds.includes(i.id)}
                    onChange={() =>
                      setDraftInboxIds((ids) =>
                        ids.includes(i.id) ? ids.filter((x) => x !== i.id) : [...ids, i.id],
                      )
                    }
                  />
                  {i.name}
                </label>
              ))}
            </div>
          ) : f.inboxIds.length ? (
            waInboxes.filter((i) => f.inboxIds.includes(i.id)).map((i) => i.name).join(", ") ||
            `${f.inboxIds.length} channel(s)`
          ) : (
            "Every channel"
          )}
        </span>
        <span className="dcell">
          {/* Its own toggle rather than part of the edit form: it is the one
              setting here somebody changes on a whim — a chip is worth its
              place this week and clutter the next — and making that a
              three-click edit is how a filter row stays wrong. */}
          <button
            type="button"
            className={"switch sm" + (f.filterable ? " on" : "")}
            role="switch"
            aria-checked={f.filterable}
            aria-label={`Show “${f.label}” in the inbox filters`}
            disabled={update.isPending}
            title={
              f.filterable
                ? `“${f.label}” has a chip in the inbox filter row`
                : `Show “${f.label}” as a chip in the inbox filter row`
            }
            onClick={() => setFilterable(f, !f.filterable)}
          >
            <span className="switch__dot" />
          </button>
        </span>
        <span className="dcell dacts">
          {editing ? (
            <>
              <button className="btn-primary" disabled={update.isPending} onClick={() => saveEdit(f)}>Save</button>
              <button className="btn-ghost" onClick={() => setEditingId(null)}>Cancel</button>
            </>
          ) : (
            <>
              <button className="iconbtn" title="Edit field" onClick={() => startEdit(f)}><EditIcon /></button>
              <button
                className="iconbtn"
                title={f.archived ? "Put back in use" : "Retire — keeps what's recorded"}
                onClick={() => setArchived(f, !f.archived)}
              >
                {f.archived ? <ReopenIcon /> : <SnoozeIcon />}
              </button>
              <button className="iconbtn danger" title="Delete field and its values" onClick={() => remove(f)}>
                <TrashIcon />
              </button>
            </>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="setpane setpane--wide">
      <div className="setpane__head">
        <div>
          <h2>Custom fields <span className="setcount">{live.length}</span></h2>
          <p>
            Facts worth recording that aren’t built in — an order number, a booking reference, an
            account number. They show on the thread or the customer, they’re searchable, and an
            integration can set them by name.
          </p>
        </div>
      </div>

      <form className="setform" onSubmit={submit}>
        <div className="setform__grid two">
          <label className="field">
            <span>Name</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Order ID"
              maxLength={60}
            />
            <em className="fieldhint">
              {key ? (
                <>
                  Integrations will send it as <code>{key}</code>
                  {clash ? " — but that name is already taken" : ", and that never changes"}
                </>
              ) : (
                "The name agents read. The key an integration sends is derived from it."
              )}
            </em>
          </label>
          <label className="field">
            <span>Belongs to</span>
            <select value={entity} onChange={(e) => setEntity(e.target.value as CustomFieldEntity)}>
              <option value="conversation">This conversation</option>
              <option value="contact">The customer</option>
            </select>
            <em className="fieldhint">
              {entity === "conversation"
                ? "One value per thread — the order this particular chat is about."
                : "Follows the person, and shows on every conversation they open."}
            </em>
          </label>
        </div>
        <div className="setform__grid two">
          <label className="field">
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>
              {FIELD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <em className="fieldhint">{FIELD_TYPES.find((t) => t.value === type)?.hint}</em>
          </label>
          {type === "select" && (
            <label className="field">
              <span>Choices</span>
              <textarea
                value={options}
                onChange={(e) => setOptions(e.target.value)}
                placeholder={"One per line\nRefund\nRedeliver"}
                rows={3}
              />
            </label>
          )}
        </div>
        <div className="setform__foot">
          <button className="btn-primary" disabled={!canAdd || create.isPending}>
            <PlusIcon /> Add field
          </button>
        </div>
      </form>

      <div className="dwrap">
        <div className="dtable dtable--cf">
          <div className="dtable__head">
            <span>Name</span>
            <span>Belongs to</span>
            <span>Type</span>
            <span>Channels</span>
            <span title="Show a chip for this field in the inbox's filter row">Filter</span>
            <span />
          </div>
          {live.map((f) => <Row key={f.id} f={f} />)}
        </div>
      </div>
      {live.length === 0 && (
        <div className="setzero">
          <p>No custom fields yet. Add one above — an order number is the usual first.</p>
        </div>
      )}

      {archived.length > 0 && (
        <>
          <div className="setpane__head setpane__head--sub">
            <div>
              <h2>Retired <span className="setcount">{archived.length}</span></h2>
              <p>
                Not offered on new records, and nothing new can be written to them — but everything
                already recorded is still there and still searchable.
              </p>
            </div>
          </div>
          <div className="dwrap">
            <div className="dtable dtable--cf">
              {archived.map((f) => <Row key={f.id} f={f} />)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LabelsPane({ onToast }: { onToast: (msg: string) => void }) {
  const labels = useLabels();
  const create = useCreateLabel();
  const update = useUpdateLabel();
  const del = useDeleteLabel();
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState(LABEL_COLORS[0]);
  const list = labels.data ?? [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    create.mutate(
      { name: n, color },
      {
        onSuccess: () => { setName(""); onToast(`Label “${n}” created`); },
        onError: () => onToast("Only admins & managers can create labels"),
      },
    );
  };
  const startEdit = (l: Label) => { setEditingId(l.id); setDraftName(l.name); setDraftColor(l.color); };
  const saveEdit = (id: string) => {
    const n = draftName.trim();
    if (!n) return;
    update.mutate(
      { id, input: { name: n, color: draftColor } },
      {
        onSuccess: () => { setEditingId(null); onToast("Label updated"); },
        onError: () => onToast("Couldn't update label"),
      },
    );
  };
  const remove = (id: string, labelName: string) => {
    if (!window.confirm(`Delete “${labelName}”? It will be removed from every conversation.`)) return;
    del.mutate(id, {
      onSuccess: () => { setEditingId(null); onToast(`Label “${labelName}” deleted`); },
      onError: () => onToast("Couldn't delete label"),
    });
  };

  const editLabel = list.find((l) => l.id === editingId) ?? null;

  return (
    <div className="setpane setpane--wide">
      <div className="setpane__head">
        <div>
          <h2>Labels <span className="setcount">{list.length}</span></h2>
          <p>Tag conversations by topic, priority or state (Billing, Complaint, VIP…). Apply them from a thread's Tag button and filter the inbox by any label from the sidebar.</p>
        </div>
      </div>
      <form className="setadd" onSubmit={submit}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New label name…" maxLength={40} />
        <div className="lblswatches">
          {LABEL_COLORS.map((c) => (
            <button key={c} type="button" className={"lblswatch" + (color === c ? " on" : "")} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} />
          ))}
        </div>
        <button className="btn-primary" type="submit" disabled={create.isPending || !name.trim()}>
          <PlusIcon /> Create label
        </button>
      </form>

      <div className="dwrap">
        <div className="dtable dtable--label">
          <div className="dtable__head">
            <span>Label</span>
            <span />
          </div>
          {list.map((l) => (
            <div className="dtable__row dtable__row--static" key={l.id}>
              <span className="dcell dname">
                <span className="cdot" style={{ background: l.color, width: 14, height: 14 }} />
                <span className="dcell__t">{l.name}</span>
              </span>
              <span className="dcell dacts">
                <button className="iconbtn" title="Edit label" onClick={() => startEdit(l)}><EditIcon /></button>
              </span>
            </div>
          ))}
          {list.length === 0 && <div className="dtable__empty">No labels yet — create one above.</div>}
        </div>
      </div>

      {editLabel && (
        <div className="modal" onClick={() => setEditingId(null)}>
          <div className="modal__box modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h2>Edit label</h2>
              <button type="button" className="modal__x" onClick={() => setEditingId(null)} aria-label="Close"><XIcon /></button>
            </div>
            <div className="modal__body">
              <label className="field">
                <span>Label name</span>
                <input value={draftName} autoFocus maxLength={40} onChange={(e) => setDraftName(e.target.value)} />
              </label>
              <div className="field">
                <span>Colour</span>
                <div className="lblswatches">
                  {LABEL_COLORS.map((c) => (
                    <button key={c} type="button" className={"lblswatch" + (draftColor === c ? " on" : "")} style={{ background: c }} onClick={() => setDraftColor(c)} aria-label={`Colour ${c}`} />
                  ))}
                </div>
              </div>
            </div>
            <div className="modal__foot modal__foot--split">
              <button type="button" className="btn-ghost btn-danger" onClick={() => remove(editLabel.id, editLabel.name)}>
                <TrashIcon /> Delete
              </button>
              <div className="setform__footactions">
                <button className="btn-ghost" type="button" onClick={() => setEditingId(null)}>Cancel</button>
                <button className="btn-primary" type="button" onClick={() => saveEdit(editLabel.id)} disabled={update.isPending || !draftName.trim()}>
                  Save changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TeamsPane({ onToast }: { onToast: (msg: string) => void }) {
  const teams = useTeams();
  const people = usePeople();
  const create = useCreateTeam();
  const update = useUpdateTeam();
  const del = useDeleteTeam();
  const reorder = useReorderTeams();
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftIcon, setDraftIcon] = useState<string | null>(null);
  const [draftSla, setDraftSla] = useState<number | null>(null);
  const ordered = teams.data ?? [];
  const memberCount = (teamId: string) => (people.data ?? []).filter((m) => m.teamIds.includes(teamId)).length;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    create.mutate(
      { name: n },
      {
        onSuccess: () => { setName(""); onToast(`Team “${n}” created`); },
        onError: () => onToast("Only admins & managers can create teams"),
      },
    );
  };

  const startEdit = (t: Team) => {
    setEditingId(t.id);
    setDraftName(t.name);
    setDraftIcon(t.icon ?? null);
    setDraftSla(t.slaMinutes ?? null);
  };
  const saveEdit = (id: string) => {
    const n = draftName.trim();
    if (!n) return;
    update.mutate(
      { id, input: { name: n, icon: draftIcon, slaMinutes: draftSla } },
      {
        onSuccess: () => { setEditingId(null); onToast("Team updated"); },
        onError: () => onToast("Couldn't update team"),
      },
    );
  };
  const remove = (id: string, teamName: string) => {
    if (!window.confirm(`Delete “${teamName}”? Its channels and people will be detached.`)) return;
    del.mutate(id, {
      onSuccess: () => { setEditingId(null); onToast(`Team “${teamName}” deleted`); },
      onError: () => onToast("Couldn't delete team"),
    });
  };
  const move = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= ordered.length) return;
    const ids = ordered.map((t) => t.id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    reorder.mutate(ids);
  };

  const editTeam = ordered.find((t) => t.id === editingId) ?? null;

  return (
    <div className="setpane setpane--wide">
      <div className="setpane__head">
        <div>
          <h2>Teams <span className="setcount">{ordered.length}</span></h2>
          <p>Channels route to teams; a person can belong to several. Reorder with the arrows and give each an icon.</p>
        </div>
        <form className="setinlineadd" onSubmit={submit}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New team name…" />
          <button className="btn-primary" type="submit" disabled={create.isPending || !name.trim()}>
            <PlusIcon /> Create
          </button>
        </form>
      </div>

      <div className="dwrap">
        <div className="dtable dtable--team">
          <div className="dtable__head">
            <span>Team</span>
            <span>Members</span>
            <span>SLA</span>
            <span />
          </div>
          {ordered.map((t, i) => {
            const n = memberCount(t.id);
            return (
              <div className="dtable__row dtable__row--static" key={t.id}>
                <span className="dcell dname">
                  <span className="chcard__ic" style={{ width: 34, height: 34 }}><TeamGlyph icon={t.icon} /></span>
                  <span className="dname__x"><span className="dcell__t">{t.name}</span></span>
                </span>
                <span className="dcell dcell--muted">{n} member{n === 1 ? "" : "s"}</span>
                <span className="dcell dcell--muted">{slaLabel(t.slaMinutes) || "—"}</span>
                <span className="dcell dacts">
                  <button className="iconbtn" title="Move up" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}><ChevronUp /></button>
                  <button className="iconbtn" title="Move down" disabled={i === ordered.length - 1 || reorder.isPending} onClick={() => move(i, 1)}><ChevronDown /></button>
                  <button className="iconbtn" title="Edit team" onClick={() => startEdit(t)}><EditIcon /></button>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {editTeam && (
        <div className="modal" onClick={() => setEditingId(null)}>
          <div className="modal__box modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h2>Edit team</h2>
              <button type="button" className="modal__x" onClick={() => setEditingId(null)} aria-label="Close"><XIcon /></button>
            </div>
            <div className="modal__body">
              <label className="field">
                <span>Team name</span>
                <input value={draftName} autoFocus onChange={(e) => setDraftName(e.target.value)} />
              </label>
              <div className="field">
                <span>Icon</span>
                <div className="iconpick">
                  {TEAM_ICON_KEYS.map((k) => {
                    const Ic = TEAM_ICONS[k];
                    return (
                      <button key={k} type="button" className={"iconpick__btn" + (draftIcon === k ? " on" : "")} onClick={() => setDraftIcon(draftIcon === k ? null : k)} title={k} aria-label={k}>
                        <Ic />
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="field">
                <span>First-response SLA</span>
                <select value={draftSla ?? ""} onChange={(e) => setDraftSla(e.target.value ? Number(e.target.value) : null)}>
                  {SLA_OPTIONS.map((o) => (<option key={o.label} value={o.minutes ?? ""}>{o.label}</option>))}
                </select>
                <small className="fieldhint">New conversations routed to this team get a “respond within” timer; it clears on your first reply.</small>
              </label>
            </div>
            <div className="modal__foot modal__foot--split">
              <button type="button" className="btn-ghost btn-danger" onClick={() => remove(editTeam.id, editTeam.name)}>
                <TrashIcon /> Delete
              </button>
              <div className="setform__footactions">
                <button className="btn-ghost" type="button" onClick={() => setEditingId(null)}>Cancel</button>
                <button className="btn-primary" type="button" onClick={() => saveEdit(editTeam.id)} disabled={update.isPending || !draftName.trim()}>
                  Save changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Workspaces — the platform owner's view of every workspace           */
/* ------------------------------------------------------------------ */

function WorkspacesPane({ onToast }: { onToast: (msg: string) => void }) {
  const list = usePlatformWorkspaces();
  const mine = useMyWorkspaces();
  const create = useCreateWorkspace();
  const here = mine.data?.workspaces.find((w) => w.current)?.orgId;
  const all = list.data ?? [];
  // Archived ones are put away: shown only when asked for.
  const [showArchived, setShowArchived] = useState(false);
  const archived = all.filter((w) => w.status === "archived").length;
  const rows = all.filter((w) => showArchived || w.status !== "archived");
  const [managing, setManaging] = useState<string | null>(null);
  const managed = all.find((w) => w.id === managing) ?? null;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [invite, setInvite] = useState<{ workspace: string; name: string; url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const valid = Boolean(name.trim() && adminName.trim() && adminEmail.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    create.mutate(
      { name: name.trim(), adminName: adminName.trim(), adminEmail: adminEmail.trim() },
      {
        onSuccess: (made) => {
          const ws = made.workspace.name;
          if (made.admin.invited && made.admin.inviteUrl) {
            setInvite({ workspace: ws, name: made.admin.name, url: made.admin.inviteUrl, emailed: made.admin.emailed });
            setCopied(false);
            onToast(made.admin.emailed ? `“${ws}” made — invite emailed to ${made.admin.email}` : `“${ws}” made — share ${made.admin.name}’s link below`);
          } else {
            setInvite(null);
            onToast(`“${ws}” made — ${made.admin.name} already signs in, so it’s in their menu now`);
          }
          setName(""); setAdminName(""); setAdminEmail(""); setOpen(false);
        },
        onError: (err) => onToast(err instanceof Error && err.message ? err.message : "Couldn’t make the workspace"),
      },
    );
  };

  const copyInvite = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      onToast("Couldn't copy — select the link and copy manually");
    }
  };

  // Opening one you aren't in adds you to its people, as an admin — visibly,
  // so its own admins can see who has been in.
  const openWorkspace = (id: string, wsName: string, joined: boolean) => {
    if (!joined && !window.confirm(`Open “${wsName}”?\n\nYou’ll be added to its people as an admin, where its admins can see you.`)) return;
    setOpening(id);
    platformApi.switchWorkspace(id).then(
      () => window.location.assign("/"),
      (err) => {
        setOpening(null);
        onToast(err instanceof Error && err.message ? err.message : "Couldn’t open that workspace");
      },
    );
  };

  return (
    <div className="setpane setpane--wide">
      <div className="setpane__head">
        <div>
          <h2>Workspaces <span className="setcount">{all.length - archived}</span></h2>
          <p>Every workspace on the platform. Each one’s people, channels and conversations are its own — open one to work in it, or manage it from here.</p>
        </div>
        <div className="setform__footactions">
          {archived > 0 && (
            <button className="btn-ghost" type="button" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "Hide archived" : `Show archived (${archived})`}
            </button>
          )}
          <button className="btn-primary" type="button" onClick={() => setOpen(true)}>
            <PlusIcon /> New workspace
          </button>
        </div>
      </div>

      {invite && (
        <div className="invitebox">
          <div className="invitebox__head">
            <b>{invite.emailed ? `Invite emailed to ${invite.name}` : `Invite ${invite.name} to ${invite.workspace}`}</b>
            <button className="iconbtn" title="Dismiss" onClick={() => setInvite(null)}>
              <XIcon />
            </button>
          </div>
          <p>
            {invite.emailed
              ? "They’ll get an email with a link to set their password. You can also share this link directly:"
              : "Email isn’t connected yet, so send this set-password link to them directly. It expires in 7 days."}
          </p>
          <div className="copyrow">
            <input readOnly value={invite.url} onFocus={(e) => e.target.select()} />
            <button className="btn-primary" type="button" onClick={copyInvite}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      )}

      <div className="dwrap">
        <div className="dtable dtable--ws">
          <div className="dtable__head">
            <span>Workspace</span>
            <span>People</span>
            <span>Channels</span>
            <span>Conversations</span>
            <span />
          </div>
          {list.isLoading && <div className="dtable__row dtable__row--static"><span className="dcell dcell--muted">Loading…</span></div>}
          {rows.map((w) => (
            <div className="dtable__row dtable__row--static" key={w.id}>
              <span className="dcell dname">
                <span className="dname__x">
                  <span className="dcell__t">
                    {w.name} <WorkspaceStatusBadge status={w.status} purgeAt={w.purgeAt} />
                  </span>
                  <span className="dcell__s">
                    Since {new Date(w.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                    {w.sandbox ? " · demo" : ""}
                  </span>
                </span>
              </span>
              <span className="dcell dcell--muted">{w.people}</span>
              <span className="dcell dcell--muted">{w.channels}</span>
              <span className="dcell dcell--muted">{w.conversations}</span>
              <span className="dcell dacts">
                {w.id === here ? (
                  <span className="dcell--muted">You’re here</span>
                ) : w.status === "active" ? (
                  <button className="btn-ghost" type="button" disabled={!!opening} onClick={() => openWorkspace(w.id, w.name, w.joined)}>
                    {opening === w.id ? "Opening…" : "Open"}
                  </button>
                ) : null}
                <button className="btn-ghost" type="button" onClick={() => setManaging(w.id)}>
                  Manage
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      {managed && <ManageWorkspace ws={managed} here={managed.id === here} onClose={() => setManaging(null)} onToast={onToast} />}

      {open && (
        <div className="modal" onClick={() => setOpen(false)}>
          <form className="modal__box modal--form" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <div className="modal__head">
              <h2>New workspace</h2>
              <button type="button" className="modal__x" onClick={() => setOpen(false)} aria-label="Close"><XIcon /></button>
            </div>
            <div className="modal__body">
              <label className="field">
                <span>Workspace name</span>
                <input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="The client’s business name" />
              </label>
              <label className="field">
                <span>Their admin’s name</span>
                <input value={adminName} onChange={(e) => setAdminName(e.target.value)} />
              </label>
              <label className="field">
                <span>Their admin’s email</span>
                <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
                <small className="fieldhint">
                  They’re invited to set a password. Someone who already signs in here keeps theirs and finds the new workspace in their menu.
                </small>
              </label>
            </div>
            <div className="modal__foot">
              <button className="btn-ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-primary" type="submit" disabled={create.isPending || !valid}>
                {create.isPending ? "Making…" : "Make workspace"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  archived: "Archived",
  deleting: "Being deleted",
};

function WorkspaceStatusBadge({ status, purgeAt }: { status: WorkspaceStatus; purgeAt: string | null }) {
  if (status === "active") return null;
  const title = status === "deleting" && purgeAt ? `Deleted for good on ${fmtDay(purgeAt)}` : undefined;
  return (
    <span className={"wsbadge wsbadge--" + status} title={title}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * One workspace, managed from outside it: its name, its people, and its life —
 * suspend, archive, delete (restorable for 30 days) or delete now.
 */
function ManageWorkspace({
  ws,
  here,
  onClose,
  onToast,
}: {
  ws: PlatformWorkspace;
  here: boolean;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const m = useManageWorkspace();
  const people = useWorkspacePeople(ws.id);
  const [name, setName] = useState(ws.name);
  const [pName, setPName] = useState("");
  const [pEmail, setPEmail] = useState("");
  const [pRole, setPRole] = useState<Role>("agent");
  const [link, setLink] = useState<{ name: string; url: string; emailed: boolean } | null>(null);
  const [wipe, setWipe] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const err = (e: unknown, fallback: string) => onToast(e instanceof Error && e.message ? e.message : fallback);
  const closable = !ws.platform && !here;
  const busy = m.setStatus.isPending || m.deleteNow.isPending;

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === ws.name) return;
    m.rename.mutate({ id: ws.id, name: n }, { onSuccess: () => onToast(`Renamed to “${n}”`), onError: (e) => err(e, "Couldn’t rename it") });
  };

  const showInvite = (who: string, r: PlatformPersonInvite) => {
    if (r.invite) setLink({ name: who, url: r.invite.url, emailed: r.invite.emailed });
  };
  const addPerson = (e: FormEvent) => {
    e.preventDefault();
    if (!pName.trim() || !pEmail.trim()) return;
    const who = pName.trim();
    m.addPerson.mutate(
      { id: ws.id, input: { name: who, email: pEmail.trim(), role: pRole } },
      {
        onSuccess: (r) => {
          void people.refetch();
          showInvite(who, r);
          onToast(r.addedExisting ? `Added ${who} — they already sign in` : r.invite?.emailed ? `Invite emailed to ${who}` : `Invited ${who} — share their link`);
          setPName(""); setPEmail(""); setPRole("agent");
        },
        onError: (e) => err(e, "Couldn’t add them"),
      },
    );
  };
  const setRole = (personId: string, role: Role) =>
    m.setRole.mutate({ id: ws.id, personId, role }, { onSuccess: () => void people.refetch(), onError: (e) => err(e, "Couldn’t change their role") });
  const remove = (personId: string, who: string) => {
    if (!window.confirm(`Remove ${who} from “${ws.name}”?`)) return;
    m.removePerson.mutate({ id: ws.id, personId }, { onSuccess: () => { void people.refetch(); onToast(`${who} removed`); }, onError: (e) => err(e, "Couldn’t remove them") });
  };
  const resend = (personId: string, who: string) =>
    m.resendInvite.mutate({ id: ws.id, personId }, {
      onSuccess: (r) => { showInvite(who, r); onToast(r.invite?.emailed ? `Invite re-sent to ${who}` : `New invite link for ${who} below`); },
      onError: (e) => err(e, "Couldn’t re-send it"),
    });

  const setStatus = (status: WorkspaceStatus, ask?: string, done?: string) => {
    if (ask && !window.confirm(ask)) return;
    m.setStatus.mutate({ id: ws.id, status }, { onSuccess: () => onToast(done ?? STATUS_LABEL[status]), onError: (e) => err(e, "Couldn’t change it") });
  };
  const deleteNow = (e: FormEvent) => {
    e.preventDefault();
    m.deleteNow.mutate({ id: ws.id, confirmName }, {
      onSuccess: () => { onToast(`“${ws.name}” deleted for good`); onClose(); },
      onError: (e) => err(e, "Couldn’t delete it"),
    });
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box modal--form wsmanage" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>{ws.name} <WorkspaceStatusBadge status={ws.status} purgeAt={ws.purgeAt} /></h2>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>
        <div className="modal__body">
          <form className="wsmanage__row" onSubmit={saveName}>
            <label className="field" style={{ flex: 1 }}>
              <span>Workspace name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </label>
            <button className="btn-ghost" type="submit" disabled={m.rename.isPending || !name.trim() || name.trim() === ws.name}>Save</button>
          </form>

          <h3 className="wsmanage__h">People <span className="setcount">{people.data?.length ?? 0}</span></h3>
          {link && (
            <div className="invitebox">
              <div className="invitebox__head">
                <b>{link.emailed ? `Invite emailed to ${link.name}` : `Invite link for ${link.name}`}</b>
                <button className="iconbtn" title="Dismiss" onClick={() => setLink(null)}><XIcon /></button>
              </div>
              <div className="copyrow">
                <input readOnly value={link.url} onFocus={(e) => e.target.select()} />
                <button className="btn-primary" type="button" onClick={() => void navigator.clipboard.writeText(link.url).then(() => onToast("Link copied"), () => undefined)}>Copy link</button>
              </div>
            </div>
          )}
          <div className="wspeople">
            {people.isLoading && <div className="dcell--muted">Loading…</div>}
            {(people.data ?? []).map((p) => (
              <div className="wspeople__row" key={p.user.id}>
                <span className="wspeople__who">
                  <b>{p.user.name}</b>
                  <small>{p.user.email}{p.pending ? " · invited, no password yet" : ""}</small>
                </span>
                <select value={p.user.role} onChange={(e) => setRole(p.user.id, e.target.value as Role)} aria-label={`${p.user.name}'s role`}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                {p.pending && <button className="btn-ghost" type="button" onClick={() => resend(p.user.id, p.user.name)}>Re-send invite</button>}
                <button className="iconbtn" type="button" title={`Remove ${p.user.name}`} onClick={() => remove(p.user.id, p.user.name)}><TrashIcon /></button>
              </div>
            ))}
          </div>
          <form className="wsmanage__row" onSubmit={addPerson}>
            <input placeholder="Name" value={pName} onChange={(e) => setPName(e.target.value)} aria-label="New person's name" />
            <input placeholder="Email" type="email" value={pEmail} onChange={(e) => setPEmail(e.target.value)} aria-label="New person's email" />
            <select value={pRole} onChange={(e) => setPRole(e.target.value as Role)} aria-label="New person's role">
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <button className="btn-primary" type="submit" disabled={m.addPerson.isPending || !pName.trim() || !pEmail.trim()}><PlusIcon /> Add</button>
          </form>

          <h3 className="wsmanage__h">Status</h3>
          {!closable ? (
            <p className="fieldhint">
              {ws.platform ? "The platform’s own workspace can’t be suspended, archived or deleted." : "You’re in this workspace — switch to another one to suspend, archive or delete it."}
            </p>
          ) : (
            <>
              <p className="fieldhint">
                {ws.status === "active" && "Active: its people sign in and its channels send and receive."}
                {ws.status === "suspended" && "Suspended: nobody can sign in, and its channels take nothing in and send nothing out. Everything is kept."}
                {ws.status === "archived" && "Archived: put away and frozen, kept for ever. Nobody can sign in."}
                {ws.status === "deleting" && ws.purgeAt && `Being deleted: frozen now, and wiped for good on ${fmtDay(ws.purgeAt)}. Restore it before then to keep it.`}
              </p>
              <div className="wsmanage__acts">
                {ws.status === "active" && (
                  <button className="btn-ghost" type="button" disabled={busy} onClick={() => setStatus("suspended", `Suspend “${ws.name}”? Everyone in it is signed out straight away, and its channels stop.`, "Suspended")}>Suspend</button>
                )}
                {ws.status !== "active" && (
                  <button className="btn-primary" type="button" disabled={busy} onClick={() => setStatus("active", undefined, ws.status === "deleting" ? "Restored" : ws.status === "archived" ? "Unarchived" : "Reactivated")}>
                    {ws.status === "deleting" ? "Restore" : ws.status === "archived" ? "Unarchive" : "Reactivate"}
                  </button>
                )}
                {ws.status !== "archived" && ws.status !== "deleting" && (
                  <button className="btn-ghost" type="button" disabled={busy} onClick={() => setStatus("archived", `Archive “${ws.name}”? It’s frozen and put away, and kept for ever.`, "Archived")}>Archive</button>
                )}
                {ws.status !== "deleting" && (
                  <button className="btn-ghost btn-danger" type="button" disabled={busy} onClick={() => setStatus("deleting", `Delete “${ws.name}”?\n\nIt’s frozen now and wiped for good in ${WORKSPACE_DELETE_GRACE_DAYS} days. You can restore it until then.`, `Deleting — restorable for ${WORKSPACE_DELETE_GRACE_DAYS} days`)}>
                    <TrashIcon /> Delete
                  </button>
                )}
                <button className="btn-ghost btn-danger" type="button" disabled={busy} onClick={() => setWipe((v) => !v)}>Delete now…</button>
              </div>
              {wipe && (
                <form className="wsmanage__wipe" onSubmit={deleteNow}>
                  <p>
                    Everything in <b>{ws.name}</b> — its conversations, customers, files, channels and people — is wiped for good, now. This can’t be undone.
                    Type its name to confirm.
                  </p>
                  <div className="wsmanage__row">
                    <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={ws.name} aria-label="Workspace name" autoFocus />
                    <button className="btn-primary btn-danger-fill" type="submit" disabled={confirmName.trim() !== ws.name.trim() || m.deleteNow.isPending}>
                      {m.deleteNow.isPending ? "Deleting…" : "Delete for good"}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

function PeoplePane({ onToast }: { onToast: (msg: string) => void }) {
  const people = usePeople();
  const teams = useTeams();
  const me = useMe();
  const create = useCreateUser();
  const update = useUpdateUser();
  const del = useDeleteUser();
  const resend = useResendUserInvite();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [position, setPosition] = useState("");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  // The most recent invite's set-password link, shown so the admin can share it
  // when no transactional email is connected yet.
  const [invite, setInvite] = useState<{ name: string; url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [eRole, setERole] = useState<Role>("agent");
  const [ePosition, setEPosition] = useState("");
  const [eTeams, setETeams] = useState<string[]>([]);

  const toggleTeam = (id: string) => setTeamIds((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const toggleETeam = (id: string) => setETeams((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const teamName = (id: string) => teams.data?.find((t) => t.id === id)?.name ?? id;
  const valid = Boolean(name.trim() && email.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const who = name.trim();
    create.mutate(
      { name: who, email: email.trim(), role, teamIds, position: position.trim() },
      {
        onSuccess: (result) => {
          if (result.invite) {
            setInvite({ name: who, url: result.invite.url, emailed: result.invite.emailed });
            setCopied(false);
            onToast(result.invite.emailed ? `Invite emailed to ${email.trim()}` : `Invited ${who} — share their link below`);
          } else if (result.addedExisting) {
            onToast(`Added ${who} — they already sign in, so this workspace is in their menu now`);
          } else {
            onToast(`Invited ${who}`);
          }
          setName(""); setEmail(""); setRole("agent"); setPosition(""); setTeamIds([]); setOpen(false);
        },
        onError: (err) => onToast(err instanceof Error && err.message ? err.message : "Only admins/managers can add people"),
      },
    );
  };

  const copyInvite = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
      onToast("Invite link copied");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      onToast("Couldn't copy — select the link and copy manually");
    }
  };

  const startEdit = (id: string, n: string, r: Role, t: string[], pos?: string | null) => {
    setOpen(false);
    setEditId(id); setEName(n); setERole(r); setETeams(t); setEPosition(pos ?? "");
  };
  const saveEdit = (id: string) => {
    const trimmed = eName.trim();
    if (!trimmed) return;
    update.mutate(
      { id, input: { name: trimmed, role: eRole, teamIds: eTeams, position: ePosition.trim() } },
      {
        onSuccess: () => { setEditId(null); onToast("Member updated"); },
        onError: () => onToast("Couldn't update member"),
      },
    );
  };
  const resendInvite = (id: string, who: string) => {
    resend.mutate(id, {
      onSuccess: (result) => {
        if (result.invite) {
          setInvite({ name: who, url: result.invite.url, emailed: result.invite.emailed });
          setCopied(false);
        }
        setEditId(null);
        onToast(result.invite?.emailed ? `Invite re-sent to ${who}` : `New invite link for ${who} below`);
      },
      onError: (err) => onToast(err instanceof Error && err.message ? err.message : "Couldn't re-send the invite"),
    });
  };
  const remove = (id: string, who: string) => {
    if (!window.confirm(`Remove ${who}? They'll lose access and be unassigned.`)) return;
    del.mutate(id, {
      onSuccess: () => onToast(`${who} removed`),
      onError: () => onToast("Couldn't remove member"),
    });
  };

  const editMember = people.data?.find((m) => m.user.id === editId) ?? null;
  const editIsSelf = me.data?.user.id === editId;

  return (
    <div className="setpane setpane--wide">
      <div className="setpane__head">
        <div>
          <h2>People <span className="setcount">{people.data?.length ?? 0}</span></h2>
          <p>Team members who pick up conversations. Invited people get a link to set their own password.</p>
        </div>
        <button className="btn-primary" onClick={() => { setEditId(null); setOpen(true); }}>
          <PlusIcon /> Invite person
        </button>
      </div>

      {invite && (
        <div className="invitebox">
          <div className="invitebox__head">
            <b>{invite.emailed ? `Invite emailed to ${invite.name}` : `Invite ${invite.name}`}</b>
            <button className="iconbtn" title="Dismiss" onClick={() => setInvite(null)}>
              <XIcon />
            </button>
          </div>
          <p>
            {invite.emailed
              ? "They'll get an email with a link to set their own password. You can also share this link directly:"
              : "Email isn't connected yet, so send this set-password link to them directly. It expires in 7 days."}
          </p>
          <div className="copyrow">
            <input readOnly value={invite.url} onFocus={(e) => e.target.select()} />
            <button className="btn-primary" type="button" onClick={copyInvite}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      )}

      <div className="dwrap">
        <div className="dtable dtable--ppl">
          <div className="dtable__head">
            <span>Name</span>
            <span>Email</span>
            <span>Role</span>
            <span>Teams</span>
            <span>Status</span>
            <span />
          </div>
          {people.data?.map((m) => {
            const isSelf = me.data?.user.id === m.user.id;
            return (
              <div
                className="dtable__row"
                key={m.user.id}
                role="button"
                tabIndex={0}
                onClick={() => startEdit(m.user.id, m.user.name, m.user.role, m.teamIds, m.user.position)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startEdit(m.user.id, m.user.name, m.user.role, m.teamIds, m.user.position); } }}
              >
                <span className="dcell dname">
                  <span className="av dname__av" style={{ background: avatarBg(m.user.name, m.user.avatarColor) }}>
                    {m.user.avatarUrl ? <img className="av__photo" src={m.user.avatarUrl} alt="" /> : initials(m.user.name)}
                  </span>
                  <span className="dname__x">
                    <span className="dcell__t">{m.user.name}{isSelf && <span className="youtag">You</span>}</span>
                    {m.user.position && <span className="dname__pos">{m.user.position}</span>}
                  </span>
                </span>
                <span className="dcell dcell--muted">{m.user.email}</span>
                <span className="dcell"><span className="dpill dpill--off" style={{ textTransform: "capitalize" }}>{m.user.role}</span></span>
                <span className="dcell dcell--muted" title={m.teamIds.map(teamName).join(", ")}>{summariseTeams(m.teamIds.map(teamName)) || "No team"}</span>
                <span className="dcell">
                  {m.pending ? (
                    <span className="dpill dpill--wait" title="Invited — they haven't set their password yet">Invite pending</span>
                  ) : (
                    <span className="dpill dpill--on">Active</span>
                  )}
                </span>
                <span className="dcell dcell--end"><span className="dchev"><EditIcon /></span></span>
              </div>
            );
          })}
        </div>
      </div>

      {open && (
        <div className="modal" onClick={() => setOpen(false)}>
          <form className="modal__box modal--form" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <div className="modal__head">
              <h2>Invite person</h2>
              <button type="button" className="modal__x" onClick={() => setOpen(false)} aria-label="Close"><XIcon /></button>
            </div>
            <div className="modal__body">
              <div className="setform__grid two">
                <label className="field">
                  <span>Name</span>
                  <input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" required />
                </label>
                <label className="field">
                  <span>Email</span>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@swiftee.co.uk" required />
                </label>
              </div>
              <div className="setform__grid two">
                <label className="field">
                  <span>Position <em>optional</em></span>
                  <input value={position} maxLength={80} onChange={(e) => setPosition(e.target.value)} placeholder="e.g. Operations Manager" />
                </label>
                <label className="field">
                  <span>Role</span>
                  <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {ROLES.map((r) => (<option key={r.value} value={r.value}>{r.label}</option>))}
                  </select>
                </label>
              </div>
              <div className="field">
                <span>Teams</span>
                <div className="checks">
                  {teams.data?.map((t) => (
                    <label key={t.id} className={"check" + (teamIds.includes(t.id) ? " on" : "")}>
                      <input type="checkbox" checked={teamIds.includes(t.id)} onChange={() => toggleTeam(t.id)} />
                      {t.name}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="modal__foot">
              <button className="btn-ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-primary" type="submit" disabled={create.isPending || !valid}>Invite</button>
            </div>
          </form>
        </div>
      )}

      {editMember && (
        <div className="modal" onClick={() => setEditId(null)}>
          <div className="modal__box modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h2>Edit {editMember.user.name}</h2>
              <button type="button" className="modal__x" onClick={() => setEditId(null)} aria-label="Close"><XIcon /></button>
            </div>
            <div className="modal__body">
              <div className="setform__grid two">
                <label className="field">
                  <span>Name</span>
                  <input value={eName} autoFocus onChange={(e) => setEName(e.target.value)} placeholder="Full name" />
                </label>
                <label className="field">
                  <span>Role</span>
                  <select value={eRole} onChange={(e) => setERole(e.target.value as Role)}>
                    {ROLES.map((r) => (<option key={r.value} value={r.value}>{r.label}</option>))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Position</span>
                <input value={ePosition} maxLength={80} onChange={(e) => setEPosition(e.target.value)} placeholder="e.g. Operations Manager" />
                <small className="fieldhint">Shown in the signature of every email channel they send from.</small>
              </label>
              {editMember.pending && (
                <div className="invitenote">
                  <span className="dpill dpill--wait">Invite pending</span>
                  <span>They haven’t set their password yet.</span>
                  <button className="btn-ghost" type="button" disabled={resend.isPending} onClick={() => resendInvite(editMember.user.id, editMember.user.name)}>
                    Re-send invite
                  </button>
                </div>
              )}
              <div className="field">
                <span>Teams</span>
                <div className="checks">
                  {teams.data?.map((t) => (
                    <label key={t.id} className={"check" + (eTeams.includes(t.id) ? " on" : "")}>
                      <input type="checkbox" checked={eTeams.includes(t.id)} onChange={() => toggleETeam(t.id)} />
                      {t.name}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className={"modal__foot" + (editIsSelf ? "" : " modal__foot--split")}>
              {!editIsSelf && (
                <button type="button" className="btn-ghost btn-danger" onClick={() => remove(editMember.user.id, editMember.user.name)}>
                  <TrashIcon /> Remove
                </button>
              )}
              <div className="setform__footactions">
                <button className="btn-ghost" type="button" onClick={() => setEditId(null)}>Cancel</button>
                <button className="btn-primary" type="button" onClick={() => saveEdit(editMember.user.id)} disabled={update.isPending || !eName.trim()}>
                  Save changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Templates — WhatsApp message templates (24-hour window)            */
/* ------------------------------------------------------------------ */

/* ── NestChat widget ─────────────────────────────────────────────────────── */

/**
 * Everything the pane is editing for one channel.
 *
 * The three sections a NestChat channel stores, held together because they are
 * saved together: the appearance, the form shown before a chat starts, and the
 * menu that decides which team answers it.
 */
/** The tabs the widget's settings are split across. */
type SettingsSection = "brand" | "words" | "home" | "prechat" | "away" | "app";

const SETTINGS_SECTIONS: Array<{ key: SettingsSection; label: string }> = [
  { key: "brand", label: "Brand" },
  { key: "words", label: "Words" },
  { key: "home", label: "Home" },
  { key: "prechat", label: "Contact details" },
  { key: "away", label: "When nobody’s online" },
  { key: "app", label: "In-app SDK" },
];

type WidgetDraft = {
  appearance: NestChatAppearance;
  preChat: NestChatPreChat;
  routing: NestChatRouting;
  home: NestChatHome;
  away: NestChatAway;
  app: NestChatApp;
};

/** The text fields, in the order the widget reads them out loud. */
const NESTCHAT_WORDS: Array<{
  key: keyof NestChatAppearance;
  label: string;
  hint?: string;
  multiline?: boolean;
}> = [
  { key: "headline", label: "Header greeting", hint: "The quiet line above the title; {name} becomes their name" },
  { key: "title", label: "Header title", hint: "The bold line — usually a question" },
  { key: "subtitle", label: "Header subtitle", hint: "While someone is online — see “When nobody’s online” for the rest" },
  {
    key: "closedMessage",
    label: "Closing message",
    hint: "Shown when an agent closes the chat; blank says nothing",
    multiline: true,
  },
  { key: "newChatLabel", label: "New chat button", hint: "The way back in after a chat is closed" },
  { key: "greeting", label: "Greeting", hint: "The first thing in an empty chat", multiline: true },
  { key: "placeholder", label: "Message box placeholder" },
  { key: "launcherLabel", label: "Launcher tooltip", hint: "On the floating bubble" },
];

/**
 * The three things the pre-chat form can ask for.
 *
 * A table rather than three hand-written blocks because each one is the same
 * two decisions (do we ask, must they answer) plus the words the visitor reads,
 * and three copies of that is three places for them to drift apart.
 */
const PRECHAT_FIELDS: Array<{
  key: "name" | "email" | "phone";
  labelKey: "nameLabel" | "emailLabel" | "phoneLabel";
  label: string;
  /** The in-chat ask's toggle and wording, for the fields it can ask for. */
  inChat?: { toggle: "askEmail" | "askPhone"; labelKey: "askEmailLabel" | "askPhoneLabel" };
}> = [
  { key: "name", labelKey: "nameLabel", label: "Name" },
  { key: "email", labelKey: "emailLabel", label: "Email", inChat: { toggle: "askEmail", labelKey: "askEmailLabel" } },
  { key: "phone", labelKey: "phoneLabel", label: "Phone", inChat: { toggle: "askPhone", labelKey: "askPhoneLabel" } },
];

/**
 * When the widget asks for one detail: not at all, on the form before the
 * chat, or in the chat after their first message.
 *
 * Two stores hold it — the form (`preChat`) and the in-chat card
 * (`appearance.askEmail` / `askPhone`) — and they used to be set separately,
 * on different tabs, where both could be on and the card silently gave way.
 * One choice per field, written to both, makes that impossible.
 */
type AskWhen = "off" | "before" | "chat";
function askWhen(f: (typeof PRECHAT_FIELDS)[number], preChat: NestChatPreChat, appearance: NestChatAppearance): AskWhen {
  if (preChat.enabled && preChat[f.key].enabled) return "before";
  if (f.inChat && appearance[f.inChat.toggle]) return "chat";
  return "off";
}

/**
 * Where the SDK should point.
 *
 * The web app's own API base, made absolute — it is usually "" (same origin),
 * which is fine in a browser and useless in a phone. Resolved here rather than
 * sent by the server because the server only learns its public origin from the
 * request, and would have to be told it by configuration we do not otherwise
 * need.
 */
function apiOrigin(): string {
  const configured = import.meta.env.VITE_API_URL ?? "";
  try {
    return new URL(configured || "/", window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

/**
 * The steps an app developer follows, with what is missing called out.
 *
 * Numbered rather than prose because it is a checklist somebody works through
 * once, copying as they go — and the blocked lines are the point: they are the
 * only items on the page that the person reading it, rather than the developer,
 * can do anything about.
 */
function AppSetupGuide({
  steps,
  onToast,
}: {
  steps: AppSetupStep[];
  onToast: (msg: string) => void;
}) {
  return (
    <div className="ncsetup">
      {steps.map((step, i) => (
        <div className="ncsetup__step" key={step.title}>
          <span className="ncsetup__n">{i + 1}</span>
          <div className="ncsetup__body">
            <span className="ncsetup__title">{step.title}</span>
            <p className="ncsetup__text">{step.body}</p>
            {step.blocked && <p className="ncsetup__todo">{step.blocked}</p>}
            {step.code && (
              <>
                <pre className="ncw__snippet">{step.code}</pre>
                <div>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(step.code!).then(
                        () => onToast("Copied"),
                        () => onToast("Couldn’t copy — select it and copy by hand"),
                      );
                    }}
                  >
                    Copy
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Settings › NestChat widget.
 *
 * A pane rather than another section of the Edit-channel modal: this is a dozen
 * fields plus an install snippet, and it is worth seeing what you are changing
 * while you change it. The preview beside the form is a stand-in drawn from the
 * live form state — the real widget renders in its own iframe from saved
 * settings, so it can't show what you haven't saved yet.
 */
function NestChatPane({ onToast }: { onToast: (msg: string) => void }) {
  const inboxes = useInboxes();
  const channels = (inboxes.data ?? []).filter((i) => i.type === "nestchat");
  const [selected, setSelected] = useState<string>();
  const inboxId = selected ?? channels[0]?.id;
  const apiUrl = apiOrigin();
  const settings = useNestchatSettings(inboxId);
  const update = useUpdateNestchat();

  const [embed, setEmbed] = useState<EmbedKind>("script");
  const [copied, setCopied] = useState(false);

  /** The teams this channel routes to — the only ones an option may name. */
  const teams = settings.data?.teams ?? [];

  /**
   * Which half of the form is on screen.
   *
   * Four groups down one column had grown past the point where you could find
   * anything: the routing menu sat below a dozen text fields, and the preview
   * beside it had scrolled away by the time you got there. Tabs keep the thing
   * you are editing next to the thing that shows it.
   */
  const [tab, setTab] = useState<SettingsSection>("brand");
  /** The preview shows the chat as it is with nobody online — on by itself on
   *  that tab, and switchable anywhere. */
  const [previewOffline, setPreviewOffline] = useState(false);
  useEffect(() => {
    if (tab === "away") setPreviewOffline(true);
  }, [tab]);
  const logoRef = useRef<HTMLInputElement>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  /** The pasted service-account JSON. Held only while it is being saved — it is
   *  write-only at the other end, so there is nothing to read back into it. */
  const [serviceAccount, setServiceAccount] = useState("");
  const [savingPush, setSavingPush] = useState(false);
  const [pushTest, setPushTest] = useState<NestChatPushTest | null>(null);
  const [testingPush, setTestingPush] = useState(false);

  /** Upload a logo and point this channel at it. */
  const pickLogo = async (file: File | undefined) => {
    if (!file || !draft) return;
    if (!file.type.startsWith("image/")) {
      onToast("That file isn’t an image.");
      return;
    }
    if (file.size > 2_000_000) {
      onToast("Logo is too large — keep it under 2 MB.");
      return;
    }
    setUploadingLogo(true);
    try {
      const att = await api.uploadMedia(file, { kind: "image", filename: file.name });
      // The id, not the url: the public address is derived from the widget key
      // when the widget asks for its config, so a rotated key can't strand it.
      setTab("brand");
      setDrafts((m) =>
        inboxId && m[inboxId]
          ? {
              ...m,
              [inboxId]: {
                ...m[inboxId],
                appearance: { ...m[inboxId].appearance, logoAttachmentId: att.id, logoUrl: "" },
              },
            }
          : m,
      );
    } catch {
      onToast("Couldn’t upload that logo — please try again.");
    } finally {
      setUploadingLogo(false);
    }
  };

  /**
   * One draft per channel, not one draft.
   *
   * Every widget is styled separately — two NestChat channels can be two
   * different products with different colours and different words — so the form
   * has to hold an edit per channel rather than a single form the channel picker
   * points at. Keeping them keyed by inbox id also means switching channels
   * mid-edit doesn't quietly throw your work away, which a single draft did.
   *
   * All three sections travel together in one draft. They are saved in one call
   * and share one dirty marker, so splitting them into three maps would only
   * mean three of everything that has to stay in step.
   */
  const [drafts, setDrafts] = useState<Record<string, WidgetDraft>>({});
  const [saved, setSaved] = useState<Record<string, WidgetDraft>>({});
  const draft = inboxId ? drafts[inboxId] : undefined;

  // Seed a channel's draft from what's stored, once. Keyed on the id so a
  // background refetch never reverts what someone is typing.
  useEffect(() => {
    const data = settings.data;
    if (!data) return;
    const next: WidgetDraft = {
      appearance: data.appearance,
      preChat: data.preChat,
      routing: data.routing,
      home: data.home,
      away: data.away,
      app: data.app,
    };
    setSaved((m) => ({ ...m, [data.inboxId]: next }));
    setDrafts((m) => (m[data.inboxId] ? m : { ...m, [data.inboxId]: next }));
  }, [settings.data]);

  /** Replace one section of the current channel's draft. */
  const setSection = <S extends keyof WidgetDraft>(section: S, value: WidgetDraft[S]) =>
    setDrafts((m) => {
      const current = inboxId ? m[inboxId] : undefined;
      if (!inboxId || !current) return m;
      return { ...m, [inboxId]: { ...current, [section]: value } };
    });

  const set = <K extends keyof NestChatAppearance>(key: K, value: NestChatAppearance[K]) => {
    if (!draft) return;
    // Spread a typed one-key object rather than using a computed key inline:
    // `{ ...current, [key]: value }` widens the key to `string` and stops
    // being assignable to the appearance type.
    const patch = { [key]: value } as Pick<NestChatAppearance, K>;
    setSection("appearance", { ...draft.appearance, ...patch });
  };

  const setPreChat = <K extends keyof NestChatPreChat>(key: K, value: NestChatPreChat[K]) => {
    if (!draft) return;
    const patch = { [key]: value } as Pick<NestChatPreChat, K>;
    setSection("preChat", { ...draft.preChat, ...patch });
  };

  const setHome = <K extends keyof NestChatHome>(key: K, value: NestChatHome[K]) => {
    if (!draft) return;
    const patch = { [key]: value } as Pick<NestChatHome, K>;
    setSection("home", { ...draft.home, ...patch });
  };

  const setAway = <K extends keyof NestChatAway>(key: K, value: NestChatAway[K]) => {
    if (!draft) return;
    const patch = { [key]: value } as Pick<NestChatAway, K>;
    setSection("away", { ...draft.away, ...patch });
  };

  /** Set when one detail is asked for, keeping the form and the card in step. */
  const setAskWhen = (field: (typeof PRECHAT_FIELDS)[number], when: AskWhen) => {
    if (!draft) return;
    const whens = Object.fromEntries(
      PRECHAT_FIELDS.map((f) => [f.key, f.key === field.key ? when : askWhen(f, draft.preChat, draft.appearance)]),
    ) as Record<(typeof PRECHAT_FIELDS)[number]["key"], AskWhen>;
    const preChat: NestChatPreChat = { ...draft.preChat, enabled: Object.values(whens).includes("before") };
    for (const f of PRECHAT_FIELDS) {
      const before = whens[f.key] === "before";
      const was = askWhen(f, draft.preChat, draft.appearance) === "before";
      preChat[f.key] = { enabled: before, required: before && (was ? draft.preChat[f.key].required : f.key !== "phone") };
    }
    const appearance = { ...draft.appearance };
    for (const f of PRECHAT_FIELDS) if (f.inChat) appearance[f.inChat.toggle] = whens[f.key] === "chat";
    setDrafts((m) => (inboxId && m[inboxId] ? { ...m, [inboxId]: { ...m[inboxId], preChat, appearance } } : m));
  };

  const setApp = <K extends keyof NestChatApp>(key: K, value: NestChatApp[K]) => {
    if (!draft) return;
    const patch = { [key]: value } as Pick<NestChatApp, K>;
    setSection("app", { ...draft.app, ...patch });
  };

  /** Replace one home card in place. */
  const setCard = (id: string, patch: Partial<NestChatHomeCard>) => {
    if (!draft) return;
    setSection("home", {
      ...draft.home,
      cards: draft.home.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
  };

  const setRouting = <K extends keyof NestChatRouting>(key: K, value: NestChatRouting[K]) => {
    if (!draft) return;
    const patch = { [key]: value } as Pick<NestChatRouting, K>;
    setSection("routing", { ...draft.routing, ...patch });
  };

  /** Replace one routing option in place. */
  const setOption = (id: string, patch: Partial<NestChatRoutingOption>) => {
    if (!draft) return;
    setSection("routing", {
      ...draft.routing,
      options: draft.routing.options.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    });
  };

  /**
   * Where the pane itself loads the logo from.
   *
   * The session-guarded media route, not the widget's public one: this is the
   * agent app, it has a session, and the public route only serves what is
   * *saved* — so an upload you haven't saved yet would show nothing, which
   * reads as an upload that failed.
   */
  const logoSrc = draft?.appearance.logoAttachmentId
    ? `/api/media/${encodeURIComponent(draft.appearance.logoAttachmentId)}`
    : draft?.appearance.logoUrl || "";

  /** Channels with edits that haven't been saved yet — marked in the picker, so
   *  a pending change on a channel you've switched away from stays visible. */
  const dirty = (id: string) =>
    Boolean(drafts[id] && saved[id] && JSON.stringify(drafts[id]) !== JSON.stringify(saved[id]));
  const isDirty = inboxId ? dirty(inboxId) : false;

  const save = () => {
    if (!inboxId || !draft) return;
    const name = channels.find((c) => c.id === inboxId)?.name ?? "Widget";
    update.mutate(
      { inboxId, input: draft },
      {
        onSuccess: (res) => {
          const next: WidgetDraft = {
            appearance: res.appearance,
            preChat: res.preChat,
            routing: res.routing,
            home: res.home,
            away: res.away,
            app: res.app,
          };
          setSaved((m) => ({ ...m, [res.inboxId]: next }));
          setDrafts((m) => ({ ...m, [res.inboxId]: next }));
          onToast(`${name} updated`);
        },
        // The server refuses a routing option pointing at a team this channel
        // doesn't serve, and says which one — worth passing on verbatim rather
        // than flattening every failure into "you're not allowed".
        onError: (err: unknown) =>
          onToast(
            (err instanceof Error && err.message) ||
              "Only admins & managers can change the widget",
          ),
      },
    );
  };

  // Built from the draft, not the saved settings, so the snippet you copy
  // matches the colour and label you are looking at.
  const snippet =
    settings.data && draft ? embedSnippet(embed, settings.data, draft.appearance) : "";

  const copy = () => {
    void navigator.clipboard.writeText(snippet).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => onToast("Couldn’t copy — select the snippet and copy it by hand"),
    );
  };

  // The same snippet for a website with signed-in users, and the server line
  // that signs them — shown in whichever language the site is written in.
  const userSnippet = settings.data && draft ? signedInSnippet(settings.data, draft.appearance) : "";
  const [signLang, setSignLang] = useState(0);
  const copyText = (text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(
      () => onToast(`${what} copied`),
      () => onToast("Couldn’t copy — select it and copy it by hand"),
    );
  };

  if (!channels.length) {
    return (
      <div className="setpane setpane--wide">
        <div className="setpane__head">
          <h2>NestChat widget</h2>
          <p>Our own live chat, embedded on your website.</p>
        </div>
        <div className="setempty">
          <p>
            No NestChat channel yet. Add one under <strong>Channels</strong> and its widget appears
            here, ready to style and embed. Add several — one per site or product — and each keeps
            its own colours, wording and embed snippet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="setpane setpane--wide">
      <div className="setpane__head">
        <h2>NestChat widget</h2>
        <p>
          Every NestChat channel has its own look, its own words and its own embed. Pick one to
          style it.
        </p>
        <div className="setpane__headacts">
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={!draft || update.isPending || !isDirty}
          >
            {update.isPending ? "Saving…" : isDirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      {/* Always shown, even with one channel: these settings belong to a
          specific widget, and a picker that appears only once there are two
          leaves the first one looking like a global setting. */}
      <div className="ncwtabs" role="tablist" aria-label="NestChat channels">
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === inboxId}
            className={"ncwtab" + (c.id === inboxId ? " on" : "")}
            onClick={() => setSelected(c.id)}
          >
            <span className="ncwtab__name">
              {c.name}
              {dirty(c.id) && (
                <i className="ncwtab__dot" title="Unsaved changes" aria-label="Unsaved changes" />
              )}
            </span>
            <small>{c.handle}</small>
          </button>
        ))}
      </div>

      {!draft ? (
        <div className="setempty">
          <p>Loading the widget’s settings…</p>
        </div>
      ) : (
        <div className="ncw">
          <div className="ncw__form">
            <div className="ncwsub" role="tablist" aria-label="Widget settings sections">
              {SETTINGS_SECTIONS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={"ncwsub__tab" + (tab === t.key ? " on" : "")}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <section className="ncw__group" hidden={tab !== "brand"}>
              <h3>Brand</h3>
              <div className="setform__grid two">
                <label className="field">
                  <span>Brand colour</span>
                  <div className="ncw__colour">
                    <input
                      type="color"
                      value={draft.appearance.accent}
                      onChange={(e) => set("accent", e.target.value)}
                      aria-label="Brand colour"
                    />
                    <input
                      value={draft.appearance.accent}
                      onChange={(e) => set("accent", e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                </label>
                <label className="field">
                  <span>Text on the brand colour</span>
                  <div className="ncw__colour">
                    <input
                      type="color"
                      value={draft.appearance.accentText}
                      onChange={(e) => set("accentText", e.target.value)}
                      aria-label="Text on the brand colour"
                    />
                    <input
                      value={draft.appearance.accentText}
                      onChange={(e) => set("accentText", e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                </label>
              </div>
              <div className="field">
                <span>
                  Logo <em>Top-left of the header</em>
                </span>
                <div className="ncwlogo">
                  {/* Shown on the brand colour, because that is the only place
                      it is ever seen — a dark logo that looks fine on white and
                      vanishes on a blue header is exactly the mistake this
                      preview exists to catch. */}
                  <div
                    className="ncwlogo__well"
                    style={{
                      background: nestchatHeaderBackground(draft.appearance),
                    }}
                  >
                    {logoSrc ? (
                      <img src={logoSrc} alt="" />
                    ) : (
                      <span style={{ color: draft.appearance.accentText }}>No logo</span>
                    )}
                  </div>
                  <div className="ncwlogo__acts">
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => logoRef.current?.click()}
                      disabled={uploadingLogo}
                    >
                      {uploadingLogo ? "Uploading…" : logoSrc ? "Replace" : "Upload a logo"}
                    </button>
                    {logoSrc && (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          set("logoAttachmentId", "");
                          set("logoUrl", "");
                        }}
                        disabled={uploadingLogo}
                      >
                        Remove
                      </button>
                    )}
                    <small className="fieldhint">PNG, SVG or JPG, up to 2 MB. Use a light
                      version — it sits on your brand colour.</small>
                  </div>
                </div>
                <input
                  ref={logoRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    void pickLogo(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>

              <label className={"check" + (draft.appearance.headerGradient ? " on" : "")}>
                <input
                  type="checkbox"
                  checked={draft.appearance.headerGradient}
                  onChange={(e) => set("headerGradient", e.target.checked)}
                />
                Run the header as a gradient
              </label>
              {draft.appearance.headerGradient && (
                <label className="field">
                  <span>
                    Gradient runs to <em>The header only — buttons and bubbles stay flat</em>
                  </span>
                  <div className="ncw__colour">
                    <input
                      type="color"
                      value={draft.appearance.accentTo}
                      onChange={(e) => set("accentTo", e.target.value)}
                      aria-label="Second colour"
                    />
                    <input
                      value={draft.appearance.accentTo}
                      onChange={(e) => set("accentTo", e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                </label>
              )}
              <div className="setform__grid two">
                <label className="field">
                  <span>Theme</span>
                  <select
                    value={draft.appearance.theme}
                    onChange={(e) => set("theme", e.target.value as NestChatAppearance["theme"])}
                  >
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="auto">Match the visitor’s device</option>
                  </select>
                </label>
                <label className="field">
                  <span>Launcher corner</span>
                  <select
                    value={draft.appearance.position}
                    onChange={(e) =>
                      set("position", e.target.value as NestChatAppearance["position"])
                    }
                  >
                    <option value="right">Bottom right</option>
                    <option value="left">Bottom left</option>
                  </select>
                </label>
              </div>
              <label className={"check" + (draft.appearance.showTeam ? " on" : "")}>
                <input
                  type="checkbox"
                  checked={draft.appearance.showTeam}
                  onChange={(e) => set("showTeam", e.target.checked)}
                />
                Show the faces of the team that answers this channel
              </label>
              <label className={"check" + (draft.appearance.showBranding ? " on" : "")}>
                <input
                  type="checkbox"
                  checked={draft.appearance.showBranding}
                  onChange={(e) => set("showBranding", e.target.checked)}
                />
                Show “Powered by NestConnect”
              </label>
            </section>

            <section className="ncw__group" hidden={tab !== "words"}>
              <h3>Words</h3>
              {NESTCHAT_WORDS.map((f) => (
                <label className="field" key={f.key}>
                  <span>
                    {f.label} {f.hint && <em>{f.hint}</em>}
                  </span>
                  {f.multiline ? (
                    <textarea
                      rows={2}
                      value={String(draft.appearance[f.key] ?? "")}
                      onChange={(e) => set(f.key, e.target.value as never)}
                    />
                  ) : (
                    <input
                      value={String(draft.appearance[f.key] ?? "")}
                      onChange={(e) => set(f.key, e.target.value as never)}
                    />
                  )}
                </label>
              ))}
            </section>

            <section className="ncw__group" hidden={tab !== "away"}>
              <h3>When nobody’s online</h3>
              <p className="fieldhint">
                Nobody is online when everyone who answers this channel has switched themselves off
                or is outside their working hours. The preview shows it that way while you’re here.
              </p>
              <label className="field">
                <span>
                  Header line <em>In place of the subtitle</em>
                </span>
                <textarea rows={2} value={draft.appearance.awayMessage} onChange={(e) => set("awayMessage", e.target.value)} />
              </label>
              {draft.home.enabled && (
                <label className="field">
                  <span>
                    Home screen line <em>Under “{draft.home.chatLabel}”, in place of “{draft.home.chatSublabel}”</em>
                  </span>
                  <input value={draft.away.homeLine} onChange={(e) => setAway("homeLine", e.target.value)} />
                </label>
              )}

              <label className={"check" + (draft.away.autoReply ? " on" : "")}>
                <input type="checkbox" checked={draft.away.autoReply} onChange={(e) => setAway("autoReply", e.target.checked)} />
                Reply automatically when someone writes
              </label>
              {draft.away.autoReply && (
                <div className="ncw__sub">
                  <p className="fieldhint">
                    Sent once, into the conversation, so whoever picks the chat up sees what they were told — and
                    again only after someone has replied. <strong>{"{name}"}</strong> and <strong>{"{email}"}</strong> become
                    theirs.
                  </p>
                  <label className="field">
                    <span>
                      When we have their email <em>From the form, a signed-in site, or earlier</em>
                    </span>
                    <textarea rows={2} value={draft.away.withEmail} onChange={(e) => setAway("withEmail", e.target.value)} />
                  </label>
                  <label className="field">
                    <span>
                      When we don’t <em>An email box goes under it</em>
                    </span>
                    <textarea rows={2} value={draft.away.askEmail} onChange={(e) => setAway("askEmail", e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Once they’ve given it</span>
                    <input value={draft.away.thanks} onChange={(e) => setAway("thanks", e.target.value)} />
                  </label>
                </div>
              )}

              <label className={"check" + (draft.appearance.emailReplies ? " on" : "")}>
                <input
                  type="checkbox"
                  checked={draft.appearance.emailReplies}
                  onChange={(e) => set("emailReplies", e.target.checked)}
                />
                Email them the replies they haven’t seen, 5 minutes after they’re sent
              </label>
              {draft.away.autoReply && !draft.appearance.emailReplies && (
                <p className="ncw__warn">
                  The automatic reply says you’ll get back to them by email — with this off, that’s on whoever replies.
                </p>
              )}
            </section>

            {/* The app surface. Same channel as the website above it — same
                teams, same routing, same words — reached from a phone instead
                of a page. */}
            <section className="ncw__group" hidden={tab !== "app"}>
              <h3>In-app SDK</h3>
              <p className="fieldhint">
                Put this same chat inside your own app. It answers into this channel, with the
                teams and routing you’ve already set — the only differences are the key the app
                carries and how hard we check who somebody says they are.
              </p>

              <label className={"check" + (draft.app.enabled ? " on" : "")}>
                <input
                  type="checkbox"
                  checked={draft.app.enabled}
                  onChange={(e) => setApp("enabled", e.target.checked)}
                />
                Let an app open chats on this channel
              </label>

              {draft.app.enabled && (
                <>
                  {/* Only once it's saved: the key is minted server-side when the
                      surface is turned on, so showing a box before then would be
                      showing an empty one. */}
                  {settings.data?.appKey ? (
                    <label className="field">
                      <span>App key</span>
                      <div className="keyrow">
                        <input readOnly value={settings.data.appKey} onFocus={(e) => e.target.select()} />
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            void navigator.clipboard?.writeText(settings.data!.appKey!);
                            onToast("App key copied");
                          }}
                        >
                          Copy
                        </button>
                      </div>
                      <em className="fieldhint">
                        Goes in the app. It names this channel and authorises nothing else, so it
                        is safe in a binary — which is also why it is not proof of who is using it.
                      </em>
                    </label>
                  ) : (
                    <p className="fieldhint">Save to mint the key this app will carry.</p>
                  )}

                  <p className="fieldhint">
                    To tag every customer (or label every conversation) that starts here, edit the
                    channel in Settings › Channels — it works the same on every channel.
                  </p>

                  <label className="field">
                    <span>One conversation per</span>
                    <select
                      value={draft.app.threadFieldKey}
                      onChange={(e) => setApp("threadFieldKey", e.target.value)}
                    >
                      <option value="">Customer — one ongoing thread each</option>
                      {(settings.data?.threadFields ?? []).map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>
                    <em className="fieldhint">
                      {draft.app.threadFieldKey ? (
                        <>
                          Opening the chat for one starts or resumes that one’s thread, so an old
                          complaint stays separate from tonight’s.
                        </>
                      ) : (
                        <>
                          Everything a customer sends continues the same conversation. Pick a field
                          instead — an order number, a booking reference — to give each its own
                          thread. Only conversation fields are offered; define them under
                          Organisation › Custom fields.
                        </>
                      )}
                    </em>
                  </label>

                  <label className="field">
                    <span>Trusting who they say they are</span>
                    <select
                      value={draft.app.identity}
                      onChange={(e) => setApp("identity", e.target.value as NestChatIdentityMode)}
                    >
                      <option value="off">Take it at face value</option>
                      <option value="optional">Check a signature when there is one</option>
                      <option value="required">Require a signature</option>
                    </select>
                    <em className="fieldhint">
                      {draft.app.identity === "required" ? (
                        <>
                          Names, emails and phone numbers are only trusted when your backend has
                          signed them. Anything unsigned chats anonymously.
                        </>
                      ) : draft.app.identity === "optional" ? (
                        <>
                          A step on the way, not a place to stay. Until your backend signs, anyone
                          who pulls the key out of your app can claim to be any of your customers.
                        </>
                      ) : (
                        <>
                          Whatever the app sends is believed. Fine while nobody signs in; not once
                          the app knows who its user is.
                        </>
                      )}
                    </em>
                  </label>

                  <SigningSecretField
                    inboxId={inboxId!}
                    hasSecret={Boolean(settings.data?.hasIdentitySecret)}
                    onChanged={() => void settings.refetch()}
                    onToast={onToast}
                  />
                </>
              )}

              {draft.app.enabled && (
                <>
                  <h3>Notifications</h3>
                  <p className="fieldhint">
                    So a reply reaches someone who has closed the app. It goes out through your own
                    Firebase project, under your app’s name and icon — we never push from ours.
                  </p>

                  <div className="field">
                    <span>Firebase service account</span>
                    <textarea
                      rows={4}
                      spellCheck={false}
                      placeholder={
                        settings.data?.hasPushCredential
                          ? "A key is saved. Paste a new one to replace it."
                          : '{ "type": "service_account", "project_id": … }'
                      }
                      value={serviceAccount}
                      onChange={(e) => setServiceAccount(e.target.value)}
                    />
                    <div className="keyrow">
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={savingPush || !serviceAccount.trim()}
                        onClick={() => {
                          setSavingPush(true);
                          api
                            .setNestchatPushCredential(inboxId!, serviceAccount)
                            .then(() => {
                              setServiceAccount("");
                              void settings.refetch();
                              onToast("Notifications are set up");
                            })
                            .catch((err: unknown) =>
                              onToast(
                                (err instanceof Error && err.message) || "Couldn’t save that key",
                              ),
                            )
                            .finally(() => setSavingPush(false));
                        }}
                      >
                        {settings.data?.hasPushCredential ? "Replace key" : "Save key"}
                      </button>
                      {settings.data?.hasPushCredential && (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={savingPush}
                          onClick={() => {
                            if (
                              !window.confirm(
                                "Turn off notifications for this channel?\n\nCustomers will still get replies when they open the app — they just won’t be told one arrived.",
                              )
                            ) {
                              return;
                            }
                            setSavingPush(true);
                            api
                              .setNestchatPushCredential(inboxId!, "")
                              .then(() => {
                                setServiceAccount("");
                                void settings.refetch();
                                onToast("Notifications turned off");
                              })
                              .catch((err: unknown) =>
                                onToast(
                                  (err instanceof Error && err.message) || "Couldn’t clear that key",
                                ),
                              )
                              .finally(() => setSavingPush(false));
                          }}
                        >
                          Turn off
                        </button>
                      )}
                      {settings.data?.hasPushCredential && (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={testingPush || savingPush}
                          onClick={() => {
                            setTestingPush(true);
                            setPushTest(null);
                            api
                              .testNestchatPush(inboxId!)
                              .then(setPushTest)
                              .catch((err: unknown) =>
                                setPushTest({
                                  ok: false,
                                  detail:
                                    (err instanceof Error && err.message) ||
                                    "Couldn’t run the test.",
                                }),
                              )
                              .finally(() => setTestingPush(false));
                          }}
                        >
                          {testingPush ? "Sending…" : "Send test push"}
                        </button>
                      )}
                    </div>
                    {pushTest && (
                      <p className={pushTest.ok ? "pushtest ok" : "pushtest bad"}>
                        {pushTest.ok ? "✓ " : "✗ "}
                        {pushTest.detail}
                        {pushTest.error && <code> {pushTest.error}</code>}
                      </p>
                    )}
                    <em className="fieldhint">
                      Firebase console › Project settings › Service accounts › Generate new private
                      key. Paste the whole file. Like the signing secret it is stored encrypted and
                      never shown again — replace it here if it is ever rotated.
                    </em>
                  </div>
                </>
              )}

              {draft.app.enabled && settings.data && (
                <>
                  <h3>Give this to whoever builds the app</h3>
                  <p className="fieldhint">
                    Written from this channel’s own settings — the key, the fields it accepts and
                    what is still missing are the real ones, so it stays right as you change things
                    above.
                  </p>
                  <AppSetupGuide
                    steps={appSetupGuide({
                      apiUrl,
                      appKey: settings.data.appKey,
                      app: draft.app,
                      hasIdentitySecret: settings.data.hasIdentitySecret,
                      hasPushCredential: settings.data.hasPushCredential,
                      fieldKeys: settings.data.threadFields.map((f) => f.key),
                    })}
                    onToast={onToast}
                  />
                </>
              )}
            </section>

            <section className="ncw__group" hidden={tab !== "home"}>
              <h3>Home</h3>
              <p className="fieldhint">
                A screen of cards before the conversation — the chat itself, then every other way
                you answer. Worth it if you staff more than one channel; a tap in the way if you
                don’t.
              </p>

              <label className={"check" + (draft.home.enabled ? " on" : "")}>
                <input
                  type="checkbox"
                  checked={draft.home.enabled}
                  onChange={(e) => setHome("enabled", e.target.checked)}
                />
                Show a home screen before the chat
              </label>

              {draft.home.enabled && (
                <div className="ncw__sub">
                  <div className="setform__grid two">
                    <label className="field">
                      <span>Chat card</span>
                      <input
                        value={draft.home.chatLabel}
                        onChange={(e) => setHome("chatLabel", e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>Under it</span>
                      <input
                        value={draft.home.chatSublabel}
                        onChange={(e) => setHome("chatSublabel", e.target.value)}
                      />
                    </label>
                  </div>
                  <p className="fieldhint">
                    The chat is always the first card and can’t be removed — it’s the widget’s own
                    door. Everything below it is a link out.
                  </p>

                  <div className="ncwopts">
                    <div className="ncwopt ncwopt--card ncwopt--head" aria-hidden="true">
                      <span />
                      <span>Label</span>
                      <span>Under it</span>
                      <span>Link</span>
                      <span />
                    </div>
                    {draft.home.cards.map((c) => (
                      <div className="ncwopt ncwopt--card" key={c.id}>
                        {/* A fixed set, not free text: these are drawn by the
                            widget so a WhatsApp card carries the WhatsApp mark
                            on every device, rather than whatever that
                            visitor's OS makes of an emoji. */}
                        <select
                          aria-label="Icon"
                          value={c.icon ?? ""}
                          onChange={(e) =>
                            setCard(c.id, {
                              icon: (e.target.value || undefined) as NestChatCardIcon | undefined,
                            })
                          }
                        >
                          <option value="">No icon</option>
                          {NESTCHAT_CARD_ICONS.map((n) => (
                            <option key={n} value={n}>
                              {n.charAt(0).toUpperCase() + n.slice(1)}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label="What the visitor sees"
                          placeholder="Message us on WhatsApp"
                          value={c.label}
                          onChange={(e) => setCard(c.id, { label: e.target.value })}
                        />
                        <input
                          aria-label="The line under it"
                          placeholder="Usually answers within the hour"
                          value={c.sublabel}
                          onChange={(e) => setCard(c.id, { sublabel: e.target.value })}
                        />
                        <input
                          aria-label="Where it goes"
                          placeholder="https://wa.me/44…"
                          value={c.href}
                          spellCheck={false}
                          onChange={(e) => setCard(c.id, { href: e.target.value })}
                        />
                        <button
                          type="button"
                          className="ncwopt__del"
                          title="Remove this card"
                          aria-label={`Remove ${c.label || "card"}`}
                          onClick={() =>
                            setHome(
                              "cards",
                              draft.home.cards.filter((x) => x.id !== c.id),
                            )
                          }
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={draft.home.cards.length >= NESTCHAT_MAX_HOME_CARDS}
                    onClick={() =>
                      setHome("cards", [
                        ...draft.home.cards,
                        {
                          id: `card_${Math.random().toString(36).slice(2, 10)}`,
                          label: "",
                          sublabel: "",
                          href: "",
                        },
                      ])
                    }
                  >
                    {draft.home.cards.length >= NESTCHAT_MAX_HOME_CARDS
                      ? `That’s the limit of ${NESTCHAT_MAX_HOME_CARDS}`
                      : "Add a card"}
                  </button>
                  <p className="fieldhint">
                    Links must start with <code>https://</code>, <code>mailto:</code> or{" "}
                    <code>tel:</code> — a chat widget is not somewhere to run arbitrary URLs.
                  </p>
                </div>
              )}
            </section>

            <section className="ncw__group" hidden={tab !== "prechat"}>
              <h3>Contact details</h3>
              <p className="fieldhint">
                What to ask for, and when — on a form before the chat, or in the chat after their first
                message. Details are matched against your customers, so a chat from someone you already
                know opens on <strong>their</strong> record. Nothing is asked twice: not what the form
                took, not what a signed-in site sent, not what they gave before.
              </p>

              {PRECHAT_FIELDS.map((f) => {
                const when = askWhen(f, draft.preChat, draft.appearance);
                return (
                  <div className="ncwfield ncwfield--when" key={f.key}>
                    <span className="ncwfield__name">{f.label}</span>
                    <select
                      aria-label={`When to ask for their ${f.label.toLowerCase()}`}
                      value={when}
                      onChange={(e) => setAskWhen(f, e.target.value as AskWhen)}
                    >
                      <option value="off">Don’t ask</option>
                      <option value="before">On the form before the chat</option>
                      {f.inChat && <option value="chat">In the chat, after their first message</option>}
                    </select>
                    {when === "before" && (
                      <>
                        <input
                          className="ncwfield__label"
                          aria-label={`${f.label} — what the visitor sees`}
                          value={draft.preChat[f.labelKey]}
                          onChange={(e) => setPreChat(f.labelKey, e.target.value)}
                        />
                        <label className="ncwfield__req">
                          <input
                            type="checkbox"
                            checked={draft.preChat[f.key].required}
                            onChange={(e) => setPreChat(f.key, { enabled: true, required: e.target.checked })}
                          />
                          Required
                        </label>
                      </>
                    )}
                    {when === "chat" && f.inChat && (
                      <input
                        className="ncwfield__label"
                        aria-label={`${f.label} — what the visitor sees`}
                        value={draft.appearance[f.inChat.labelKey]}
                        onChange={(e) => set(f.inChat!.labelKey, e.target.value)}
                      />
                    )}
                  </div>
                );
              })}

              {draft.preChat.enabled && (
                <div className="ncw__sub">
                  <label className="field">
                    <span>Form intro</span>
                    <textarea
                      rows={2}
                      value={draft.preChat.intro}
                      onChange={(e) => setPreChat("intro", e.target.value)}
                    />
                  </label>
                  <div className="setform__grid two">
                    <label className="field">
                      <span>Button</span>
                      <input
                        value={draft.preChat.submitLabel}
                        onChange={(e) => setPreChat("submitLabel", e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>
                        Skip link <em>Only shown when nothing is required</em>
                      </span>
                      <input
                        value={draft.preChat.skipLabel}
                        onChange={(e) => setPreChat("skipLabel", e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              )}

              <h4 className="ncw__h4">What it’s about</h4>
              <label className={"check" + (draft.routing.enabled ? " on" : "")}>
                <input
                  type="checkbox"
                  checked={draft.routing.enabled}
                  onChange={(e) => setRouting("enabled", e.target.checked)}
                />
                Let them choose what it’s about, and send it to the right team
              </label>

              {draft.routing.enabled && (
                <div className="ncw__sub">
                  <label className="field">
                    <span>Question</span>
                    <input
                      value={draft.routing.prompt}
                      onChange={(e) => setRouting("prompt", e.target.value)}
                    />
                  </label>
                  <p className="fieldhint">
                    Each option is one pill the visitor taps, so keep the labels short — they
                    sit side by side and wrap onto the next line. There’s no second line to
                    explain one: if a label needs explaining, reword the label.
                  </p>
                  <label className={"check" + (draft.routing.required ? " on" : "")}>
                    <input
                      type="checkbox"
                      checked={draft.routing.required}
                      onChange={(e) => setRouting("required", e.target.checked)}
                    />
                    They must choose before they can start
                  </label>

                  {teams.length === 0 ? (
                    <p className="fieldhint">
                      This channel isn’t routed to a team yet. Give it one under{" "}
                      <strong>Channels</strong> and its teams appear here.
                    </p>
                  ) : (
                    <>
                      <div className="ncwopts">
                        {/* Column headings once, rather than a placeholder in
                            every box repeating what the column is. */}
                        <div className="ncwopt ncwopt--head" aria-hidden="true">
                          <span />
                          <span>Label</span>
                          <span>Answered by</span>
                          <span />
                        </div>
                        {draft.routing.options.map((o) => (
                          <div className="ncwopt" key={o.id}>
                            <input
                              className="ncwopt__icon"
                              aria-label="Emoji"
                              placeholder="🙂"
                              maxLength={4}
                              value={o.icon ?? ""}
                              onChange={(e) =>
                                setOption(o.id, { icon: e.target.value || undefined })
                              }
                            />
                            <input
                              className="ncwopt__label"
                              aria-label="What the visitor sees"
                              placeholder="Billing question"
                              value={o.label}
                              onChange={(e) => setOption(o.id, { label: e.target.value })}
                            />
                            {/* Only this channel's teams. An option pointing
                                anywhere else would show a visitor the faces of
                                one team in the header and hand them to another —
                                the server refuses it for the same reason. */}
                            <select
                              aria-label="Team that answers it"
                              value={o.teamId}
                              onChange={(e) => setOption(o.id, { teamId: e.target.value })}
                            >
                              {teams.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="ncwopt__del"
                              title="Remove this option"
                              aria-label={`Remove ${o.label || "option"}`}
                              onClick={() =>
                                setRouting(
                                  "options",
                                  draft.routing.options.filter((x) => x.id !== o.id),
                                )
                              }
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={draft.routing.options.length >= NESTCHAT_MAX_ROUTING_OPTIONS}
                        onClick={() =>
                          setRouting("options", [
                            ...draft.routing.options,
                            {
                              // Minted here and never reused, because it is what
                              // a visitor's signed choice carries — renaming an
                              // option must not strand anyone mid-chat.
                              id: `opt_${Math.random().toString(36).slice(2, 10)}`,
                              label: "",
                              teamId: teams[0].id,
                            },
                          ])
                        }
                      >
                        {draft.routing.options.length >= NESTCHAT_MAX_ROUTING_OPTIONS
                          ? `That’s the limit of ${NESTCHAT_MAX_ROUTING_OPTIONS}`
                          : "Add an option"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </section>
          </div>

          <div className="ncw__side">
            <div className="ncw__prevmode" role="group" aria-label="Preview">
              <button type="button" className={"setfilterchip" + (previewOffline ? "" : " on")} onClick={() => setPreviewOffline(false)}>
                Someone’s online
              </button>
              <button type="button" className={"setfilterchip" + (previewOffline ? " on" : "")} onClick={() => setPreviewOffline(true)}>
                Nobody’s online
              </button>
            </div>
            <NestChatPreview
              appearance={draft.appearance}
              preChat={draft.preChat}
              routing={draft.routing}
              away={draft.away}
              offline={previewOffline}
              team={settings.data?.team}
            />

            <section className="ncw__group">
              <h3>Install {channels.find((c) => c.id === inboxId)?.name}</h3>
              <div className="ncw__tabs" role="group" aria-label="Embed style">
                <button
                  type="button"
                  className={"setfilterchip" + (embed === "script" ? " on" : "")}
                  onClick={() => setEmbed("script")}
                >
                  Floating bubble
                </button>
                <button
                  type="button"
                  className={"setfilterchip" + (embed === "iframe" ? " on" : "")}
                  onClick={() => setEmbed("iframe")}
                >
                  Inline iframe
                </button>
              </div>
              <p className="fieldhint">
                {embed === "script"
                  ? "Paste both tags before </body> on every page. It draws the bubble and opens the chat in a frame of its own. Keep them together — the first carries the settings, and it survives plugins that combine and minify JavaScript."
                  : "Drops the chat straight into a page — a contact page, a help centre. Size it with the surrounding CSS."}
              </p>
              <pre className="ncw__snippet">{snippet}</pre>
              <button type="button" className="btn-ghost" onClick={copy}>
                {copied ? "Copied" : "Copy snippet"}
              </button>
              <p className="fieldhint">
                Widget key <code>{settings.data?.widgetKey}</code> — public by design; it identifies
                this channel and nothing more.
              </p>

              <h3>Signed-in users</h3>
              <p className="fieldhint">
                If people log in to your website, tell the chat who they are. Their name and email
                go onto their contact, agents see who they are talking to, and the chat follows them
                to any browser — and to your app, if it uses the same user ids. Your server signs
                each user’s id; without a valid signature the chat opens as an ordinary visitor, so
                nobody can pose as one of your customers from their browser.
              </p>
              {embed === "iframe" ? (
                <p className="fieldhint">
                  Signed-in users need the <b>Floating bubble</b> snippet — switch above.
                </p>
              ) : (
                <>
                  <p className="fieldhint">
                    <b>1.</b> Create the signing secret and put it in your server’s environment as{" "}
                    <code>NESTCHAT_SECRET</code>. It never goes in a page.
                  </p>
                  {inboxId && (
                    <SigningSecretField
                      inboxId={inboxId}
                      hasSecret={Boolean(settings.data?.hasIdentitySecret)}
                      onChanged={() => void settings.refetch()}
                      onToast={onToast}
                    />
                  )}

                  <p className="fieldhint">
                    <b>2.</b> On your server, sign the signed-in user’s id on every page:
                  </p>
                  <div className="ncw__tabs" role="group" aria-label="Server language">
                    {SIGNING_EXAMPLES.map((ex, i) => (
                      <button
                        key={ex.label}
                        type="button"
                        className={"setfilterchip" + (signLang === i ? " on" : "")}
                        onClick={() => setSignLang(i)}
                      >
                        {ex.label}
                      </button>
                    ))}
                  </div>
                  <pre className="ncw__snippet">{SIGNING_EXAMPLES[signLang]?.code}</pre>

                  <p className="fieldhint">
                    <b>3.</b> Use this instead of the snippet above, with your page filling in the
                    user and the <code>hash</code> from step 2. <code>name</code>,{" "}
                    <code>email</code> and <code>phone</code> (international format, +44…) are each
                    optional. Leave <code>user</code> out for visitors who aren’t signed in.
                  </p>
                  <pre className="ncw__snippet">{userSnippet}</pre>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => copyText(userSnippet, "Signed-in snippet")}
                  >
                    Copy snippet
                  </button>
                  <p className="fieldhint">
                    <code>fields</code> is optional — any <b>conversation</b> custom field from
                    Settings › Custom fields, like an order number. Agents see it on the chat, and it
                    arrives on push notifications.
                  </p>

                  <p className="fieldhint">
                    <b>Single-page app?</b> If people sign in or out without the page reloading:
                  </p>
                  <pre className="ncw__snippet">{SPA_EXAMPLE}</pre>
                </>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The channel's signing secret: what a website's or an app's server signs its
 * user ids with, so we can believe who is signed in.
 *
 * Its own component because it is offered in two places — the Install section,
 * for websites, and In-app SDK — and both are the same one secret. The minted
 * value is component state and nothing else: it is returned once, by the call
 * that mints it, and is never readable again. Putting it anywhere more durable
 * would re-invent the thing that showing it once is meant to avoid.
 */
function SigningSecretField({
  inboxId,
  hasSecret,
  onChanged,
  onToast,
}: {
  inboxId: string;
  hasSecret: boolean;
  onChanged: () => void;
  onToast: (message: string) => void;
}) {
  const [mintedSecret, setMintedSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  return (
    <div className="field">
      <span>Signing secret</span>
      <div className="keyrow">
        <input
          readOnly
          value={
            mintedSecret ??
            (hasSecret ? "•".repeat(32) : "Not set up yet")
          }
          onFocus={(e) => e.target.select()}
        />
        <button
          type="button"
          className="btn-ghost"
          disabled={rotating}
          onClick={() => {
            if (
              hasSecret &&
              !window.confirm(
                "Replace the signing secret?\n\nEvery signature made with the old one stops working, so your backend has to be updated at the same moment.",
              )
            ) {
              return;
            }
            setRotating(true);
            api
              .rotateNestchatSecret(inboxId)
              .then((r) => {
                setMintedSecret(r.secret);
                onChanged();
                onToast("Copy it now — it isn't shown again");
              })
              .catch((err: unknown) =>
                onToast(
                  (err instanceof Error && err.message) || "Couldn’t mint a secret",
                ),
              )
              .finally(() => setRotating(false));
          }}
        >
          {hasSecret ? "Replace" : "Create"}
        </button>
        {mintedSecret && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(mintedSecret);
              onToast("Signing secret copied");
            }}
          >
            Copy
          </button>
        )}
      </div>
      <em className="fieldhint">
        {mintedSecret ? (
          <b>
            This is the only time it is shown. Put it in your backend’s environment
            now — it cannot be read back.
          </b>
        ) : (
          <>
            Your server signs each user id with this, and we check the signature. Never put it
            in a web page or inside an app — anything sent to a browser or shipped in a binary
            can be read, and whoever holds this can claim to be any of your customers.
          </>
        )}
      </em>
    </div>
  );
}

/** A stand-in for the widget, drawn from the form as it is being edited. Close
 *  enough to judge colour and copy by; the real thing lives in its own bundle. */
function NestChatPreview({
  appearance,
  preChat,
  routing,
  away,
  offline,
  team,
}: {
  appearance: NestChatAppearance;
  preChat: NestChatPreChat;
  routing: NestChatRouting;
  away: NestChatAway;
  /** As it is with nobody online: after they've written, the automatic reply. */
  offline: boolean;
  team?: NestChatTeam;
}) {
  const dark = appearance.theme === "dark";
  // Same stack the visitor sees, so switching the faces on shows the faces.
  const faces = appearance.showTeam ? (team?.faces ?? []) : [];
  /**
   * Whether a first-time visitor would meet a form rather than a message box.
   *
   * The preview shows the *first* screen, which is the one being configured —
   * so the moment either half is switched on it swaps the sample conversation
   * for the form. A routing menu with nothing in it is not a form: it renders
   * as nothing in the widget too.
   */
  const gate = !offline && (preChat.enabled || (routing.enabled && routing.options.length > 0));
  return (
    <div
      className={"ncprev" + (dark ? " ncprev--dark" : "")}
      style={{
        ["--pv-accent" as string]: appearance.accent,
        ["--pv-on" as string]: appearance.accentText,
        // Same rule the widget uses: the header takes the gradient, everything
        // else keeps the flat accent.
        // The same builder the widget uses, so the toggle previews what it does.
        ["--pv-head" as string]: nestchatHeaderBackground(appearance),
      }}
      aria-hidden="true"
    >
      <div className="ncprev__head">
        <div className="ncprev__headtop">
        {appearance.logoUrl ? (
          <img className="ncprev__logo" src={appearance.logoUrl} alt="" />
        ) : (
          <span />
        )}
        {faces.length > 0 && (
          <div className="ncprev__faces">
            {faces.map((f, i) => (
              <span
                key={f.name + i}
                className={f.color ? "ncprev__face" : "ncprev__face ncprev__face--plain"}
                style={{ zIndex: faces.length - i, ...(f.color ? { background: f.color, color: "#fff" } : null) }}
              >
                {f.avatarUrl ? <img src={f.avatarUrl} alt="" /> : <b>{f.initials}</b>}
              </span>
            ))}
            {team && team.total > faces.length && (
              <span className="ncprev__face ncprev__face--plain">
                <b>+{team.total - faces.length}</b>
              </span>
            )}
          </div>
        )}
        </div>
        <div className="ncprev__headtext">
          {appearance.headline && (
            <div className="ncprev__headline">
              {fillVisitorName(appearance.headline, "Sam Whitfield")}
            </div>
          )}
          <div className="ncprev__title">{fillVisitorName(appearance.title, "Sam Whitfield")}</div>
          <div className="ncprev__sub">{fillVisitorName(offline ? appearance.awayMessage : appearance.subtitle, "Sam Whitfield")}</div>
        </div>
      </div>
      <div className="ncprev__thread">
        {/* A sample name, so the greeting shows what {name} actually does. The
            same helper the widget uses, so the spacing agrees — including for
            a greeting with no token in it, which is most of them. */}
        <div className="ncprev__in">{fillVisitorName(appearance.greeting, "Sam Whitfield")}</div>
        {gate ? (
          <div className="ncprev__gate">
            {/* Same order as the widget: what they need, then who they are. */}
            {routing.enabled && routing.options.length > 0 && (
              <>
                <p className="ncprev__gateq">{routing.prompt}</p>
                <div className="ncprev__opts" data-chosen="yes">
                  {routing.options.map((o, i) => (
                    <span key={o.id} className={"ncprev__opt" + (i === 0 ? " on" : "")}>
                      {o.icon && <span>{o.icon}</span>}
                      {o.label || "Untitled option"}
                    </span>
                  ))}
                </div>
              </>
            )}
            {preChat.enabled && (
              <>
                {preChat.intro && <p className="ncprev__gateintro">{preChat.intro}</p>}
                {PRECHAT_FIELDS.filter((f) => preChat[f.key].enabled).map((f) => (
                  <div className="ncprev__gatefield" key={f.key}>
                    <span>
                      {preChat[f.labelKey]}
                      {preChat[f.key].required ? "" : " (optional)"}
                    </span>
                    <i />
                  </div>
                ))}
              </>
            )}
            <div className="ncprev__gatego">{preChat.submitLabel}</div>
          </div>
        ) : offline ? (
          <>
            <div className="ncprev__out">Hi — do you deliver on Saturdays?</div>
            {away.autoReply && (
              <>
                <div className="ncprev__in ncprev__auto">{fillVisitorText(away.askEmail, { name: "Sam" })}</div>
                <div className="ncprev__gatefield ncprev__awaybox">
                  <span>Your email</span>
                  <i />
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="ncprev__out">Hi — do you deliver on Saturdays?</div>
            <div className="ncprev__in">We do, right up until 2pm.</div>
          </>
        )}
      </div>
      {/* The composer isn't there while the form is: the widget hides it too,
          and a preview that showed one would be showing a screen that never
          exists. */}
      {!gate && (
        <div className="ncprev__composer">
          <span>{appearance.placeholder}</span>
          <i />
        </div>
      )}
      {appearance.showBranding && <div className="ncprev__brand">Powered by NestConnect</div>}
    </div>
  );
}

/* ── templates ───────────────────────────────────────────────────────────── */

/** One WhatsApp account, as Settings › Templates shows it: the numbers on it. */
interface TemplateAccount {
  wabaId: string;
  /** "Sales · +44 20 8800 9090" for each number on the account. */
  numbers: string[];
}

/** The tab for templates linked to no account. */
const UNLINKED = "unlinked";

function TemplatesPane({ onToast }: { onToast: (msg: string) => void }) {
  const templates = useTemplates();
  const inboxes = useInboxes();
  /**
   * The WhatsApp accounts, each with its numbers. Templates belong to an
   * account at Meta, not to a number, so this is the unit the page is split
   * by: two numbers on one account share one list, and say so.
   */
  const accounts: TemplateAccount[] = (() => {
    const byWaba = new Map<string, TemplateAccount>();
    for (const i of inboxes.data ?? []) {
      if (i.type !== "whatsapp" && i.type !== "whatsapp_group") continue;
      const wabaId = i.channelConfigPublic?.wabaId;
      if (!wabaId) continue;
      const a = byWaba.get(wabaId) ?? { wabaId, numbers: [] };
      a.numbers.push(inboxLabel(i));
      byWaba.set(wabaId, a);
    }
    // An account whose numbers have all been removed still holds templates
    // here until they're deleted; it gets a tab rather than vanishing.
    for (const t of templates.data ?? []) {
      if (t.wabaId && !byWaba.has(t.wabaId)) byWaba.set(t.wabaId, { wabaId: t.wabaId, numbers: [] });
    }
    return [...byWaba.values()];
  })();
  const unlinked = (templates.data ?? []).filter((t) => !t.wabaId);
  const [picked, setPicked] = useState<string | null>(null);
  // The tab picked, if it still exists; else the first account; else unlinked.
  const tab =
    (picked && (picked === UNLINKED ? unlinked.length > 0 : accounts.some((a) => a.wabaId === picked)) && picked) ||
    accounts[0]?.wabaId ||
    (unlinked.length ? UNLINKED : null);
  const account = accounts.find((a) => a.wabaId === tab) ?? null;
  const connected = accounts.filter((a) => a.numbers.length > 0);
  // No accounts at all (nothing connected through Meta): there's nothing to
  // split by, and a number without an account can use any of these — so one
  // plain list, not a "Not linked" warning.
  const split = accounts.length > 0;
  const shown = !split
    ? (templates.data ?? [])
    : tab === UNLINKED
      ? unlinked
      : (templates.data ?? []).filter((t) => tab && t.wabaId === tab);
  const accountName = (a: TemplateAccount) =>
    a.numbers.length ? a.numbers.join(", ") : `Account …${a.wabaId.slice(-4)} (no number connected)`;

  /** "Sales", "Sales and Support", "Sales, Support and Billing". */
  const readableList = (names: string[]) =>
    names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  /** Whichever template this one would displace — same account, already starred. */
  const displaced = (t: Template) =>
    (templates.data ?? []).find((o) => o.id !== t.id && o.isDefault && o.wabaId === t.wabaId) ?? null;

  /**
   * Star or unstar, and say what happened.
   *
   * Every other action on this screen toasts; this one did not, so a refusal
   * (only admins and managers may), a failed request and a click on a star that
   * cannot be set were indistinguishable from each other and from nothing at
   * all. That silence is most of what "it doesn't work" was.
   */
  const toggleStar = (t: Template) => {
    // What gets sent is the agent's own typed text poured into the one
    // variable without a saved default; the others fill themselves in (the
    // agent's name, the customer's). A template with no variables has nowhere
    // to put the message, and one with several left open would go out blank.
    if (!t.isDefault && autoTemplateSlot(t) === null) {
      onToast(
        t.variableCount === 0
          ? `“${t.name}” has no {{1}} to put the agent's message in, so it can't be the default`
          : `“${t.name}” has ${t.variableCount} variables and more than one has no default — give every variable but the message a default (e.g. the agent's name) first`,
      );
      return;
    }
    const numbers = readableList(account?.numbers ?? []);
    const losing = t.isDefault ? null : displaced(t);
    setDefault.mutate(
      { templateId: t.id, isDefault: !t.isDefault },
      {
        onSuccess: () =>
          onToast(
            t.isDefault
              ? `${numbers || "These numbers"} will no longer send a template once a window closes`
              : losing
                ? `${numbers || "These numbers"} now re-open with “${t.name}” — it replaces “${losing.name}”`
                : `${numbers || "These numbers"} will re-open closed chats with “${t.name}”`,
          ),
        onError: (err) => onToast(errorText(err, "Couldn’t change the default template")),
      },
    );
  };
  const del = useDeleteTemplate();
  const sync = useSyncTemplates();
  const setDefault = useSetDefaultTemplate();
  const submitTo = useSubmitTemplate();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const doSync = () => {
    sync.mutate(undefined, {
      onSuccess: (r) => onToast(`Synced ${r.synced} template${r.synced === 1 ? "" : "s"} from Meta`),
      onError: (err) => onToast(errorText(err, "Couldn’t sync from Meta")),
    });
  };
  const remove = (t: Template) => {
    const where = t.wabaId
      ? ` It's deleted at Meta too, so no number on this account (${accountName(account ?? { wabaId: t.wabaId, numbers: [] })}) can send it.`
      : " Agents will no longer be able to use it.";
    if (!window.confirm(`Delete “${t.name}”?${where}`)) return;
    del.mutate(t.id, {
      onSuccess: () => { setEditingId(null); onToast(`Template “${t.name}” deleted`); },
      onError: (err) => onToast(errorText(err, "Couldn’t delete the template")),
    });
  };
  const submit = (t: Template, wabaId: string) => {
    const to = accounts.find((a) => a.wabaId === wabaId);
    submitTo.mutate(
      { id: t.id, wabaId },
      {
        onSuccess: () => {
          setPicked(wabaId);
          onToast(`“${t.name}” sent to Meta for approval on ${to ? accountName(to) : "that account"} — it usually takes a few minutes`);
        },
        onError: (err) => onToast(errorText(err, "Meta didn’t accept the template")),
      },
    );
  };

  const editingTpl = templates.data?.find((t) => t.id === editingId) ?? null;
  const showForm = open || !!editingTpl;
  const closeForm = () => { setOpen(false); setEditingId(null); };

  return (
    <div className="setpane setpane--wide">
      <div className="setpane__head">
        <div>
          <h2>Message templates</h2>
          <p>
            Pre-approved WhatsApp messages used to re-open a chat once its 24-hour window has
            closed. Templates belong to a <b>WhatsApp account</b> at Meta, so each account has its own
            list, shared by every number on it. Variables like <code>{"{{1}}"}</code> are filled in when you send.
            {" "}Star one to make it the account's <b>default</b>: agents then keep typing normally in a closed
            chat and what they write becomes its <code>{"{{1}}"}</code>.
          </p>
        </div>
        <div className="setpane__headacts">
          <button className="btn-ghost" type="button" onClick={doSync} disabled={sync.isPending || !connected.length}>
            <RefreshIcon /> {sync.isPending ? "Syncing…" : "Sync from Meta"}
          </button>
          <button className="btn-primary" onClick={() => { setEditingId(null); setOpen(true); }}>
            <PlusIcon /> New template
          </button>
        </div>
      </div>

      <p className="fieldhint tpl-synchint">
        {connected.length
          ? "New templates are sent to Meta for approval on their account. Approvals, changes made in Meta and new templates there come through by themselves every hour — every 10 minutes while one is waiting for review."
          : "Connect a WhatsApp number under Channels to see its account's templates and submit new ones to Meta."}
      </p>

      {split && (
        <div className="ncwtabs tpltabs" role="tablist" aria-label="WhatsApp accounts">
          {accounts.map((a) => {
            const count = (templates.data ?? []).filter((t) => t.wabaId === a.wabaId).length;
            return (
              <button
                key={a.wabaId}
                type="button"
                role="tab"
                aria-selected={tab === a.wabaId}
                className={"ncwtab" + (tab === a.wabaId ? " on" : "")}
                onClick={() => setPicked(a.wabaId)}
              >
                <span className="ncwtab__name">
                  {a.numbers.length ? a.numbers.join(" · ") : `Account …${a.wabaId.slice(-4)}`}
                  <span className="setcount">{count}</span>
                </span>
                <small>
                  {a.numbers.length > 1
                    ? `${a.numbers.length} numbers share this account's templates`
                    : a.numbers.length
                      ? `WhatsApp account …${a.wabaId.slice(-4)}`
                      : "No number connected"}
                </small>
              </button>
            );
          })}
          {unlinked.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === UNLINKED}
              className={"ncwtab tpltab--unlinked" + (tab === UNLINKED ? " on" : "")}
              onClick={() => setPicked(UNLINKED)}
            >
              <span className="ncwtab__name">
                Not linked to an account <span className="setcount">{unlinked.length}</span>
              </span>
              <small>No number can send these</small>
            </button>
          )}
        </div>
      )}

      {split && tab === UNLINKED && (
        <p className="fieldhint tpl-unlinkedhint">
          These were made here but never submitted to Meta, so no number can send them and they don't show in
          the composer. Submit one to an account for approval, or delete it.
        </p>
      )}

      {shown.length > 0 && (
        <div className="dwrap">
          <div className={"dtable dtable--tpl" + (split && tab === UNLINKED ? " dtable--tplunlinked" : "")}>
            <div className="dtable__head">
              <span>Name</span>
              <span>Category</span>
              <span>Language</span>
              <span>Status</span>
              <span>Message</span>
              <span />
            </div>
            {shown.map((t) => {
              const ap = approvalMeta(t.approvalStatus);
              return (
                <div className="dtable__row dtable__row--static" key={t.id}>
                  <span className="dcell dcell__t">
                    {t.name}
                    {t.isDefault && (t.wabaId || !split) && <span className="tpl-default">Default</span>}
                  </span>
                  <span className="dcell"><span className={"tpl-cat tpl-cat--" + t.category}>{t.category}</span></span>
                  <span className="dcell dcell--muted">{t.language}</span>
                  <span className="dcell"><span className={"tpl-appr " + ap.cls}><span className="tpl-appr__dot" />{ap.label}</span></span>
                  <span className="dcell dcell--muted" title={t.body}>{t.body}</span>
                  <span className="dcell dacts">
                    {t.wabaId || !split ? (
                      /* The default is what the composer sends once a 24-hour
                         window has closed, with the agent's typed text filling
                         its variable — so only a one-variable template can carry
                         it. Not `disabled`: a star that cannot be set is the one
                         a person most needs an explanation for, so it stays
                         clickable and says why. */
                      <button
                        className={
                          "iconbtn" +
                          (t.isDefault ? " on" : "") +
                          (!t.isDefault && autoTemplateSlot(t) === null ? " iconbtn--inert" : "")
                        }
                        title={
                          t.isDefault
                            ? "Default template — click to unset"
                            : autoTemplateSlot(t) !== null
                              ? "Use as this account's default for closed windows"
                              : t.variableCount === 0
                                ? "Needs a variable for the agent's message to be the default"
                                : "Needs every variable but one to have a default (the one left is the agent's message)"
                        }
                        aria-pressed={t.isDefault}
                        disabled={setDefault.isPending}
                        onClick={() => toggleStar(t)}
                      >
                        <StarIcon filled={t.isDefault} />
                      </button>
                    ) : (
                      connected.length > 0 && (
                        <select
                          className="tpl-submitto"
                          value=""
                          disabled={submitTo.isPending}
                          aria-label={`Submit “${t.name}” to a WhatsApp account`}
                          title="Send it to Meta for approval on one of your accounts"
                          onChange={(e) => {
                            if (e.target.value) submit(t, e.target.value);
                            e.currentTarget.selectedIndex = 0;
                          }}
                        >
                          <option value="">{submitTo.isPending ? "Submitting…" : "Submit to…"}</option>
                          {connected.map((a) => (
                            <option key={a.wabaId} value={a.wabaId}>{accountName(a)}</option>
                          ))}
                        </select>
                      )
                    )}
                    <button className="iconbtn" title={t.wabaId ? "Edit what its variables pre-fill with" : "Edit template"} onClick={() => { setOpen(false); setEditingId(t.id); }}><EditIcon /></button>
                    <button className="iconbtn danger" title={t.wabaId ? "Delete — at Meta too" : "Delete template"} onClick={() => remove(t)}><TrashIcon /></button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {templates.data && shown.length === 0 && (
        <div className="setzero">
          <p>
            {account
              ? `No templates on this account yet. Create one and it's sent to Meta for approval, or sync if you've made some in Meta.`
              : connected.length
                ? "No templates yet. Create one, or sync the ones you've made in Meta."
                : "No templates yet. Connect a WhatsApp number under Channels to bring in its account's templates."}
          </p>
        </div>
      )}

      {showForm && (
        <div className="modal" onClick={closeForm}>
          <div className="modal__box modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h2>{editingTpl ? "Edit template" : "New template"}</h2>
              <button type="button" className="modal__x" onClick={closeForm} aria-label="Close"><XIcon /></button>
            </div>
            <div className="modal__body">
              <TemplateForm
                template={editingTpl ?? undefined}
                accounts={connected.map((a) => ({ wabaId: a.wabaId, label: accountName(a) }))}
                initialWabaId={account && account.numbers.length ? account.wabaId : connected[0]?.wabaId}
                onDone={(saved) => {
                  closeForm();
                  if (saved?.wabaId) setPicked(saved.wabaId);
                }}
                onToast={onToast}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The server's own words for a failed request, where it gave some. */
function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * One variable's pre-fill: a text box, a menu of things we can put in it, and a
 * preview of what it comes out as.
 *
 * One box rather than a "type" dropdown plus a value, because the useful cases
 * mix: "Hi from {{agent.name}}" is text *and* a token, and making somebody
 * choose between the two would rule that out. The preview earns its place
 * because a token is invisible until it resolves — without it the only way to
 * find out that {{contact.frist_name}} is a typo is to send it to a customer.
 */
function VariableDefaultRow({
  index,
  value,
  onChange,
}: {
  index: number;
  value: string;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    // At the cursor, so a token can be dropped into the middle of a sentence
    // rather than only appended. Falls back to the end when the box was never
    // focused (picking straight from the menu).
    const at = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, at)}{{${token}}}${value.slice(el?.selectionEnd ?? at)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = at + token.length + 4;
      el?.setSelectionRange(caret, caret);
    });
  };
  const preview = value
    ? resolveTemplateDefault(
        value,
        Object.fromEntries(
          TEMPLATE_TOKENS.map((t) => [
            // The context keys the resolver reads, from the same table the menu
            // is built from — so a token added there previews without any
            // further wiring here.
            ({
              "contact.name": "contactName",
              "contact.first_name": "contactName",
              "contact.company": "contactCompany",
              "contact.phone": "contactPhone",
              "contact.email": "contactEmail",
              "agent.name": "agentName",
              "agent.first_name": "agentName",
              "channel.name": "channelName",
            } as Record<string, string>)[t.token],
            t.token.endsWith("first_name")
              ? TEMPLATE_TOKENS.find((x) => x.token === t.token.replace("first_name", "name"))?.sample
              : t.sample,
          ]),
        ),
      )
    : "";

  return (
    <div className="tplvar">
      <span className="tplvar__n">{`{{${index + 1}}}`}</span>
      <div className="tplvar__field">
        <input
          ref={ref}
          value={value}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type text, or insert a value →"
        />
        {preview && <small className="tplvar__preview">Sends as: {preview}</small>}
      </div>
      <select
        className="tplvar__insert"
        value=""
        onChange={(e) => {
          if (e.target.value) insert(e.target.value);
          e.currentTarget.selectedIndex = 0;
        }}
        aria-label={`Insert a value into variable ${index + 1}`}
      >
        <option value="">Insert…</option>
        {TEMPLATE_TOKENS.map((t) => (
          <option key={t.token} value={t.token}>{t.label}</option>
        ))}
      </select>
    </div>
  );
}

function TemplateForm({
  template,
  accounts,
  initialWabaId,
  onDone,
  onToast,
}: {
  template?: Template;
  /** The connected WhatsApp accounts a new template can be submitted to. */
  accounts: Array<{ wabaId: string; label: string }>;
  initialWabaId?: string;
  onDone: (saved?: Template) => void;
  onToast: (msg: string) => void;
}) {
  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const editing = !!template;
  /** On an account, the wording is what Meta approved: only the pre-fill is ours. */
  const metaOwned = !!template?.wabaId;
  const [wabaId, setWabaId] = useState(initialWabaId ?? accounts[0]?.wabaId ?? "");
  const [name, setName] = useState(template?.name ?? "");
  const [category, setCategory] = useState<TemplateCategory>(template?.category ?? "utility");
  const [language, setLanguage] = useState(template?.language ?? "en");
  const [body, setBody] = useState(template?.body ?? "");
  const [defaults, setDefaults] = useState<string[]>(template?.variableDefaults ?? []);

  const nameOk = /^[a-z0-9_]+$/.test(name);
  const varCount = countVariables(body);
  const setDefaultAt = (i: number, v: string) =>
    setDefaults((d) => {
      const next = [...d];
      // Pad rather than leave holes: the array is index-aligned with {{1}}…{{n}},
      // and a sparse one would put {{3}}'s default under {{2}} on the way back.
      while (next.length < i) next.push("");
      next[i] = v;
      return next;
    });
  const valid = nameOk && language.trim().length >= 2 && body.trim().length > 0;
  const pending = create.isPending || update.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const input = {
      name,
      category,
      language: language.trim(),
      body,
      // Trimmed to the body's own variable count: editing "Hi {{1}} {{2}}" down
      // to one variable should not leave a second default stranded behind it.
      variableDefaults: Array.from({ length: varCount }, (_, i) => defaults[i] ?? ""),
    };
    if (editing) {
      update.mutate(
        { id: template.id, input: metaOwned ? { variableDefaults: input.variableDefaults } : input },
        {
          onSuccess: (saved) => { onToast("Template updated"); onDone(saved); },
          onError: (err) => onToast(errorText(err, "Couldn’t save the template")),
        },
      );
    } else {
      const to = accounts.find((a) => a.wabaId === wabaId);
      create.mutate(to ? { ...input, wabaId: to.wabaId } : input, {
        onSuccess: (saved) => {
          onToast(
            to
              ? `“${name}” sent to Meta for approval — it usually takes a few minutes`
              : `Template “${name}” created`,
          );
          onDone(saved);
        },
        onError: (err) => onToast(errorText(err, "Couldn’t create the template")),
      });
    }
  };

  return (
    <form className={"setform setform--flush" + (metaOwned ? " tplform--locked" : "")} onSubmit={submit}>
      {!editing && accounts.length > 0 && (
        <label className="field">
          <span>WhatsApp account</span>
          <select value={wabaId} onChange={(e) => setWabaId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.wabaId} value={a.wabaId}>{a.label}</option>
            ))}
          </select>
          <small className="fieldhint">
            It's sent to Meta for approval on this account, and every number on it can use it once approved.
          </small>
        </label>
      )}
      {metaOwned && (
        <p className="fieldhint tpl-metaowned">
          Meta approved this template as written, so its name and wording can't be changed here. You can still
          set what its variables pre-fill with. To change the wording, create a new template.
        </p>
      )}
      <div className="setform__grid two">
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            autoComplete="off"
            autoFocus={!metaOwned}
            disabled={metaOwned}
            onChange={(e) => setName(e.target.value)}
            placeholder="order_confirmation"
          />
          <small className="fieldhint">
            Lower-case letters, numbers and underscores only.
            {name && !nameOk ? " That name isn’t valid." : ""}
          </small>
        </label>
        <label className="field">
          <span>Category</span>
          <select value={category} disabled={metaOwned} onChange={(e) => setCategory(e.target.value as TemplateCategory)}>
            {TEMPLATE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field tpl-langfield">
        <span>Language</span>
        <input value={language} autoComplete="off" disabled={metaOwned} onChange={(e) => setLanguage(e.target.value)} placeholder="en" />
      </label>
      <label className="field">
        <span>
          Body {varCount > 0 && <em>{varCount} variable{varCount === 1 ? "" : "s"}</em>}
        </span>
        <textarea
          value={body}
          rows={4}
          disabled={metaOwned}
          maxLength={1024}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Hi {{1}}, your order {{2}} is on its way!"
        />
        <small className="fieldhint">
          Use <code>{"{{1}}"}</code>, <code>{"{{2}}"}</code> … for values filled in when the template is sent.
        </small>
      </label>

      {/* What each variable starts out as. Pre-filled, not fixed — the send form
          still opens and an agent can change any of it. */}
      {varCount > 0 && (
        <div className="tplvars">
          <div className="tplvars__head">
            Pre-fill <em>— what each variable starts as when you send this</em>
          </div>
          {Array.from({ length: varCount }, (_, i) => (
            <VariableDefaultRow
              key={i}
              index={i}
              value={defaults[i] ?? ""}
              onChange={(v) => setDefaultAt(i, v)}
            />
          ))}
          <small className="fieldhint">
            Leave one blank to keep typing it each time. Anything here can still be changed before sending.
          </small>
        </div>
      )}

      <div className="setform__foot">
        <button className="btn-ghost" type="button" onClick={() => onDone()}>Cancel</button>
        <button className="btn-primary" type="submit" disabled={pending || !valid}>
          {editing ? "Save changes" : accounts.some((a) => a.wabaId === wabaId) ? "Submit to Meta" : "Create template"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* WhatsApp business profile                                           */
/* ------------------------------------------------------------------ */

/** Friendly labels for Meta's fixed `vertical` (business category) enum. */
const VERTICAL_LABELS: Record<WhatsAppVertical, string> = {
  UNDEFINED: "Not set",
  OTHER: "Other",
  AUTO: "Automotive",
  BEAUTY: "Beauty, spa & salon",
  APPAREL: "Clothing & apparel",
  EDU: "Education",
  ENTERTAIN: "Entertainment",
  EVENT_PLAN: "Event planning & service",
  FINANCE: "Finance & banking",
  GROCERY: "Food & grocery",
  GOVT: "Public service",
  HOTEL: "Hotel & lodging",
  HEALTH: "Medical & health",
  NONPROFIT: "Non-profit",
  PROF_SERVICES: "Professional services",
  RETAIL: "Shopping & retail",
  TRAVEL: "Travel & transportation",
  RESTAURANT: "Restaurant",
  NOT_A_BIZ: "Not a business",
};

/** Add https:// to a bare domain so Meta accepts it (empty stays empty). */
function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function ProfilePane({ onToast }: { onToast: (msg: string) => void }) {
  const inboxes = useInboxes();
  const waNumbers = (inboxes.data ?? []).filter((i) => i.type === "whatsapp");
  const [inboxId, setInboxId] = useState<string | null>(null);
  // Default to the first WhatsApp number once the list loads.
  useEffect(() => {
    if (!inboxId && waNumbers.length) setInboxId(waNumbers[0].id);
  }, [waNumbers, inboxId]);
  const selected = waNumbers.find((n) => n.id === inboxId) ?? null;
  const profile = useWhatsappProfile(selected?.connected ? inboxId : null);

  return (
    <div className="setpane">
      <div className="setpane__head">
        <div>
          <h2>Business profile</h2>
          <p>
            The public card customers see on your WhatsApp number — your “about” line,
            description, category and contact details. Changes go straight to Meta.
          </p>
        </div>
      </div>

      {inboxes.isSuccess && waNumbers.length === 0 && (
        <div className="setempty">
          Connect a WhatsApp number under Channels first — a business profile lives on a number.
        </div>
      )}

      {waNumbers.length > 0 && (
        <label className="field">
          <span>WhatsApp number{waNumbers.length > 1 ? " — each number has its own profile" : ""}</span>
          <select value={inboxId ?? ""} onChange={(e) => setInboxId(e.target.value)}>
            {waNumbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
                {n.channelConfigPublic?.displayNumber ? ` · ${n.channelConfigPublic.displayNumber}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && !selected.connected && (
        <div className="setempty">
          This number isn’t connected yet — add its Phone number ID and access token under
          Channels to edit its profile.
        </div>
      )}

      {selected && selected.connected && (
        <>
          {profile.isLoading && <div className="setempty">Loading profile from WhatsApp…</div>}
          {profile.isError && (
            <div className="setempty">
              Couldn’t load the profile from WhatsApp. {(profile.error as Error)?.message ?? ""}
            </div>
          )}
          {profile.data && (
            <ProfileForm key={inboxId} inboxId={inboxId as string} profile={profile.data} onToast={onToast} />
          )}
          {/* Its own read from Meta, so it shows even if the profile didn't load. */}
          <ObaSection key={`oba-${inboxId}`} inboxId={inboxId as string} website={profile.data?.websites?.[0]} onToast={onToast} />
        </>
      )}
    </div>
  );
}

/** Meta's oba_status, said the way a person would. */
const OBA_STATUS: Record<string, { label: string; tone: "muted" | "amber" | "green" | "red"; hint: string }> = {
  NOT_STARTED: { label: "Not requested", tone: "muted", hint: "This number doesn’t have the verified badge, and nobody has applied for it yet." },
  PENDING: { label: "Under review", tone: "amber", hint: "Meta is reviewing the request. It usually takes a few days — check back here." },
  APPROVED: { label: "Approved", tone: "green", hint: "The verified badge shows next to your business name in WhatsApp." },
  REJECTED: { label: "Rejected", tone: "red", hint: "Meta turned the request down. Strengthen the supporting links and apply again once Meta allows (usually after 30 days)." },
  CANCELLED: { label: "Withdrawn", tone: "muted", hint: "The last request was withdrawn. You can apply again." },
};

/**
 * WhatsApp's Official Business Account — the verified badge by the business
 * name. Shows where this number stands (read live from Meta) and lets an
 * admin or manager apply. Meta decides, from the business's notability:
 * independent press coverage counts most.
 */
function ObaSection({ inboxId, website, onToast }: { inboxId: string; website?: string; onToast: (msg: string) => void }) {
  const oba = useWhatsappOba(inboxId);
  const request = useRequestWhatsappOba();
  const [open, setOpen] = useState(false);
  const [site, setSite] = useState(website ?? "");
  // The profile can arrive after this does: take its website if nothing's typed.
  useEffect(() => {
    if (website) setSite((cur) => cur || website);
  }, [website]);
  const [country, setCountry] = useState("United Kingdom");
  const [language, setLanguage] = useState("English");
  const [parent, setParent] = useState("");
  const [links, setLinks] = useState("");
  const [extra, setExtra] = useState("");
  // What Meta said when it refused, kept on screen: a toast is gone before
  // anyone can copy the reference Meta's support will ask for.
  const [refusal, setRefusal] = useState<string | null>(null);

  const status = oba.data?.status ?? "";
  const known = OBA_STATUS[status] ?? { label: status.replace(/_/g, " ").toLowerCase() || "Unknown", tone: "muted" as const, hint: "" };
  // Applying again only makes sense when there's nothing live: never while one
  // is being reviewed, and not once it's approved.
  const canApply = !!oba.data && status !== "PENDING" && status !== "APPROVED";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const supportingLinks = links
      .split(/[\n,]+/)
      .map((l) => normalizeUrl(l.trim()))
      .filter(Boolean);
    setRefusal(null);
    request.mutate(
      {
        inboxId,
        input: {
          businessWebsiteUrl: normalizeUrl(site.trim()),
          primaryCountryOfOperation: country.trim(),
          primaryLanguage: language.trim(),
          ...(parent.trim() ? { parentBusinessOrBrand: parent.trim() } : {}),
          supportingLinks,
          ...(extra.trim() ? { additionalSupportingInformation: extra.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          onToast("Sent to Meta — the status will show here");
        },
        onError: (err) => setRefusal((err as Error)?.message || "Meta didn’t accept the request."),
      },
    );
  };

  return (
    <div className="setform oba">
      <div className="oba__head">
        <div>
          <h3>Official Business Account</h3>
          <p className="fieldhint">The verified badge next to your business name in WhatsApp.</p>
        </div>
        <button type="button" className="btn-ghost sm" onClick={() => void oba.refetch()} disabled={oba.isFetching}>
          {oba.isFetching ? "Checking…" : "Check status"}
        </button>
      </div>

      {oba.isLoading && <p className="fieldhint">Asking WhatsApp…</p>}
      {oba.isError && <p className="fieldhint">Couldn’t read the status from WhatsApp. {(oba.error as Error)?.message ?? ""}</p>}
      {oba.data && (
        <div className="oba__status">
          <span className={`oba__pill oba__pill--${known.tone}`}>{known.label}</span>
          <span className="oba__hint">{oba.data.message || known.hint}</span>
        </div>
      )}

      {canApply && !open && (
        <div>
          <button type="button" className="btn-primary sm" onClick={() => setOpen(true)}>
            {status === "REJECTED" || status === "CANCELLED" ? "Apply again" : "Request the verified badge"}
          </button>
        </div>
      )}

      {canApply && open && (
        <form className="oba__form" onSubmit={submit}>
          <p className="fieldhint">
            Meta grants the badge to notable, authentic brands. Before applying: the number needs two-step
            verification on, an approved display name, and your business verified in Meta Business Manager.
          </p>
          <div className="setform__grid two">
            <label className="field">
              <span>Business website</span>
              <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://swiftee.co.uk" required />
            </label>
            <label className="field">
              <span>Parent business or brand <em>optional</em></span>
              <input value={parent} onChange={(e) => setParent(e.target.value)} placeholder="If you’re part of a larger group" />
            </label>
            <label className="field">
              <span>Main country of operation</span>
              <input value={country} onChange={(e) => setCountry(e.target.value)} required />
            </label>
            <label className="field">
              <span>Main language</span>
              <input value={language} onChange={(e) => setLanguage(e.target.value)} required />
            </label>
          </div>
          <label className="field">
            <span>Supporting links <em>up to 5, one per line</em></span>
            <textarea
              rows={3}
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              placeholder={"https://www.bbc.co.uk/news/…\nhttps://www.thetimes.co.uk/article/…"}
            />
            <small className="fieldhint">
              News articles or other coverage of your business by someone else — not your own site, social media or paid
              ads. This is what Meta weighs most.
            </small>
          </label>
          <label className="field">
            <span>Anything else <em>optional</em></span>
            <textarea rows={2} maxLength={1000} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Awards, notable customers, how long you’ve traded…" />
          </label>
          {refusal && (
            <div className="oba__refusal" role="alert">
              {refusal}
            </div>
          )}
          <div className="setform__foot">
            <button type="button" className="btn-ghost sm" onClick={() => setOpen(false)} disabled={request.isPending}>
              Cancel
            </button>
            <button type="submit" className="btn-primary sm" disabled={request.isPending || !site.trim()}>
              {request.isPending ? "Sending…" : "Send to Meta"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

const DAY_LABELS: Record<OpeningDay, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const DEFAULT_DAY: OpeningHoursDay = { closed: false, open: "09:00", close: "17:00" };
function defaultHours(): OpeningHours {
  return {
    mon: { ...DEFAULT_DAY },
    tue: { ...DEFAULT_DAY },
    wed: { ...DEFAULT_DAY },
    thu: { ...DEFAULT_DAY },
    fri: { ...DEFAULT_DAY },
    sat: { closed: true, open: "10:00", close: "16:00" },
    sun: { closed: true, open: "10:00", close: "16:00" },
  };
}

function ProfileForm({
  inboxId,
  profile,
  onToast,
}: {
  inboxId: string;
  profile: import("@ding/schemas").WhatsAppBusinessProfile;
  onToast: (msg: string) => void;
}) {
  const update = useUpdateWhatsappProfile();
  const [about, setAbout] = useState(profile.about ?? "");
  const [description, setDescription] = useState(profile.description ?? "");
  const [address, setAddress] = useState(profile.address ?? "");
  const [email, setEmail] = useState(profile.email ?? "");
  const [vertical, setVertical] = useState<WhatsAppVertical>(profile.vertical ?? "UNDEFINED");
  const [web1, setWeb1] = useState(profile.websites?.[0] ?? "");
  const [web2, setWeb2] = useState(profile.websites?.[1] ?? "");
  const setPhoto = useSetWhatsappProfilePhoto();
  const fileRef = useRef<HTMLInputElement>(null);
  const [hours, setHours] = useState<OpeningHours>(profile.openingHours ?? defaultHours());
  const setDay = (d: OpeningDay, patch: Partial<OpeningHoursDay>) =>
    setHours((prev) => ({ ...prev, [d]: { ...prev[d], ...patch } }));
  const onPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhoto.mutate(
      { inboxId, file },
      {
        onSuccess: () => onToast("Profile photo updated"),
        onError: (err) => onToast((err as Error)?.message ?? "Couldn’t update the photo"),
      },
    );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const websites = [web1, web2].map(normalizeUrl).filter(Boolean);
    update.mutate(
      { inboxId, input: { about, description, address, email, vertical, websites, openingHours: hours } },
      {
        onSuccess: () => onToast("Business profile saved"),
        onError: (err) => onToast((err as Error)?.message ?? "Couldn’t save the profile"),
      },
    );
  };

  return (
    <form className="setform" onSubmit={submit}>
      <div className="wa-photo">
        <div className="wa-photo__img">
          {profile.profilePictureUrl ? (
            <img src={profile.profilePictureUrl} alt="WhatsApp profile photo" />
          ) : (
            <span className="wa-photo__ph">No photo</span>
          )}
        </div>
        <div className="wa-photo__ctl">
          <button type="button" className="btn-ghost sm" onClick={() => fileRef.current?.click()} disabled={setPhoto.isPending}>
            {setPhoto.isPending ? "Uploading…" : profile.profilePictureUrl ? "Change photo" : "Add photo"}
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png" hidden onChange={onPhoto} />
          <small className="fieldhint">JPG or PNG, shown on your WhatsApp business card.</small>
        </div>
      </div>

      <label className="field">
        <span>
          About <em>{about.length}/139</em>
        </span>
        <input
          value={about}
          maxLength={139}
          autoComplete="off"
          onChange={(e) => setAbout(e.target.value)}
          placeholder="Here to help — reply anytime"
        />
        <small className="fieldhint">The short status line under your business name.</small>
      </label>

      <label className="field">
        <span>
          Description <em>{description.length}/512</em>
        </span>
        <textarea
          value={description}
          rows={3}
          maxLength={512}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What your business does, in a sentence or two."
        />
      </label>

      <div className="setform__grid two">
        <label className="field">
          <span>Category</span>
          <select value={vertical} onChange={(e) => setVertical(e.target.value as WhatsAppVertical)}>
            {WHATSAPP_VERTICALS.map((v) => (
              <option key={v} value={v}>
                {VERTICAL_LABELS[v]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Contact email</span>
          <input
            value={email}
            type="email"
            autoComplete="off"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="hello@swiftee.co.uk"
          />
        </label>
      </div>

      <label className="field">
        <span>Address</span>
        <input
          value={address}
          autoComplete="off"
          onChange={(e) => setAddress(e.target.value)}
          placeholder="123 High Street, London"
        />
      </label>

      <div className="setform__grid two">
        <label className="field">
          <span>Website</span>
          <input
            value={web1}
            autoComplete="off"
            onChange={(e) => setWeb1(e.target.value)}
            placeholder="swiftee.co.uk"
          />
        </label>
        <label className="field">
          <span>Website 2</span>
          <input
            value={web2}
            autoComplete="off"
            onChange={(e) => setWeb2(e.target.value)}
            placeholder="Optional"
          />
        </label>
      </div>

      <div className="field">
        <span>Opening hours <em>synced to WhatsApp call hours</em></span>
        <div className="wa-hours">
          {OPENING_DAYS.map((d) => {
            const day = hours[d];
            return (
              <div className={"wa-hours__row" + (day.closed ? " off" : "")} key={d}>
                <span className="wa-hours__day">{DAY_LABELS[d]}</span>
                <label className="wa-hours__sw">
                  <input
                    type="checkbox"
                    checked={!day.closed}
                    onChange={(e) => setDay(d, { closed: !e.target.checked })}
                  />
                  <span>{day.closed ? "Closed" : "Open"}</span>
                </label>
                {!day.closed && (
                  <span className="wa-hours__times">
                    <input type="time" value={day.open} onChange={(e) => setDay(d, { open: e.target.value })} />
                    <span className="wa-hours__to">–</span>
                    <input type="time" value={day.close} onChange={(e) => setDay(d, { close: e.target.value })} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <small className="fieldhint">
          Saved in NestConnect and pushed to WhatsApp as your <strong>call hours</strong> — when the number accepts
          WhatsApp voice calls (saving enables Calling on the number). WhatsApp has no general profile-hours field, so
          these don’t appear on the business card. Changes can take a few days to show for customers.
        </small>
      </div>

      <div className="setform__foot">
        <button className="btn-primary" type="submit" disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* WhatsApp broadcast                                                  */
/* ------------------------------------------------------------------ */

/** Parse a recipients textarea — one per line, "phone" or "phone, Name" —
 *  into de-duplicated {phone, name} rows, keeping only digits and a leading +. */
function parseRecipients(raw: string): { phone: string; name?: string }[] {
  const seen = new Set<string>();
  const out: { phone: string; name?: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const [rawPhone, ...rest] = line.split(",");
    const phone = rawPhone.replace(/[^\d+]/g, "");
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    const name = rest.join(",").trim();
    out.push({ phone, name: name || undefined });
  }
  return out;
}

/**
 * Settings → Move from Gmail. One step from "the team works in Gmail" to "the
 * team works in Nest": delete the email conversations Nest is holding (a trial
 * left hundreds open that were finished in Gmail), then bring in every Gmail
 * thread with an unread message as an open conversation. Preview first; the
 * run needs DELETE typed, because nothing brings the deleted ones back.
 */
function GmailCutoverPane({ onToast }: { onToast: (msg: string) => void }) {
  const [checked, setChecked] = useState(false);
  const preview = useEmailCutoverPreview(checked);
  const run = useRunEmailCutover();
  const [confirm, setConfirm] = useState("");
  // A run started earlier (or in another tab) is picked up from the preview.
  const startedHere = run.data?.status === "running";
  const previewJob = preview.data?.job;
  const polling = startedHere || previewJob?.status === "running";
  const status = useEmailCutoverStatus(polling);
  const job = status.data ?? run.data ?? previewJob;
  const running = job?.status === "running";
  const p = preview.data;
  const totalThreads = (p?.mailboxes ?? []).reduce((n, m) => n + m.unreadThreads, 0);

  useEffect(() => {
    if (job?.status === "done") onToast(`Imported ${job.imported} conversation${job.imported === 1 ? "" : "s"} from Gmail`);
    if (job?.status === "failed") onToast(job.error ?? "The move from Gmail stopped");
    // Toast once per finish, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  return (
    <div className="setpane">
      <div className="setpane__head">
        <div>
          <h2>Move from Gmail</h2>
          <p>
            Start the team working in Nest with an inbox that holds only what still needs an answer. Every email
            conversation in Nest is deleted, then each Gmail thread with an unread message from the last{" "}
            {p?.days ?? 90} days is brought in — full history, as an open conversation, shared out by your routing
            rules. Nobody is notified for the imported ones. WhatsApp and website chats aren’t touched.
          </p>
        </div>
      </div>

      {!checked && (
        <div className="setform">
          <button type="button" className="btn-primary" onClick={() => setChecked(true)}>
            Check what would happen
          </button>
        </div>
      )}

      {checked && preview.isLoading && <div className="setempty">Reading your mailboxes…</div>}
      {checked && preview.isError && (
        <div className="setempty">{(preview.error as Error)?.message ?? "Couldn’t read the mailboxes"}</div>
      )}

      {p && (
        <div className="setform">
          <ul className="cutover__list">
            <li>
              <strong>{p.emailConversations}</strong> email conversation{p.emailConversations === 1 ? "" : "s"} in Nest
              will be <strong>deleted</strong>
            </li>
            {p.mailboxes.length === 0 && <li>No Gmail mailboxes are connected — connect them under Channels first.</li>}
            {p.mailboxes.map((m) => (
              <li key={m.inboxId}>
                {m.error ? (
                  <>
                    {m.address}: <span className="cutover__err">couldn’t be read — {m.error}</span>
                  </>
                ) : (
                  <>
                    <strong>{m.unreadThreads}</strong> unread thread{m.unreadThreads === 1 ? "" : "s"} will be imported
                    from {m.address}
                  </>
                )}
              </li>
            ))}
          </ul>

          {!running && job?.status !== "done" && (
            <>
              <label className="field">
                <span>
                  Type <strong>DELETE</strong> to delete {p.emailConversations} conversation
                  {p.emailConversations === 1 ? "" : "s"} and import {totalThreads}
                </span>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="DELETE" autoComplete="off" />
              </label>
              <div>
                <button
                  type="button"
                  className="btn-primary btn-danger"
                  disabled={confirm !== "DELETE" || run.isPending || p.mailboxes.length === 0}
                  onClick={() =>
                    run.mutate(confirm, {
                      onError: (err) => onToast((err as Error)?.message ?? "Couldn’t start the move"),
                    })
                  }
                >
                  Delete and import
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {job && job.status !== "idle" && (
        <div className="setform cutover__job" aria-live="polite">
          <div>
            <strong>
              {job.status === "running" ? job.step ?? "Working…" : job.status === "done" ? "Done" : "Stopped"}
            </strong>
          </div>
          <div>
            Deleted {job.deleted} · Imported {job.imported}
            {job.total ? ` of ${job.total}` : ""}
            {job.skipped ? ` · ${job.skipped} already in Nest` : ""}
            {job.failed ? ` · ${job.failed} couldn’t be imported` : ""}
          </div>
          {job.error && <div className="cutover__err">{job.error}</div>}
        </div>
      )}
    </div>
  );
}

function BroadcastPane({ onToast }: { onToast: (msg: string) => void }) {
  const inboxes = useInboxes();
  const me = useMe();
  const templates = useTemplates();
  const send = useSendBroadcast();

  const waNumbers = (inboxes.data ?? []).filter((i) => i.type === "whatsapp");

  const [inboxId, setInboxId] = useState<string | null>(null);
  useEffect(() => {
    if (!inboxId && waNumbers.length) setInboxId(waNumbers[0].id);
  }, [waNumbers, inboxId]);
  const selected = waNumbers.find((n) => n.id === inboxId) ?? null;

  // Only the templates the chosen number's account actually holds. Sending
  // another account's is a broadcast that fails at Meta for every recipient —
  // the one place where getting this wrong is wrong hundreds of times over.
  const approved = templatesForWaba(templates.data ?? [], selected?.channelConfigPublic?.wabaId).filter(
    (t) => t.approvalStatus === "approved",
  );

  const [templateId, setTemplateId] = useState<string>("");
  const template = approved.find((t) => t.id === templateId) ?? null;
  // Changing the number can strand a template that belongs to the old one.
  useEffect(() => {
    if (templateId && !approved.some((t) => t.id === templateId)) setTemplateId("");
  }, [templateId, approved]);
  const [params, setParams] = useState<string[]>([]);
  const [recipientsRaw, setRecipientsRaw] = useState("");
  const [result, setResult] = useState<BroadcastResult | null>(null);

  // Recipients can be picked from the customer directory or pasted as numbers.
  const contacts = useContacts();
  const [mode, setMode] = useState<"contacts" | "paste">("contacts");
  const [cq, setCq] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Only customers reachable on WhatsApp (have a number) and not blocked.
  const reachable = (contacts.data ?? []).filter((c) => c.phone && !c.blocked);
  const cqFiltered = reachable.filter((c) => {
    const s = cq.trim().toLowerCase();
    return !s || [c.displayName, c.phone, c.company].some((v) => (v ?? "").toLowerCase().includes(s));
  });
  const togglePick = (id: string) =>
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allChecked = cqFiltered.length > 0 && cqFiltered.every((c) => picked.has(c.id));
  const toggleAll = () =>
    setPicked((p) => {
      const n = new Set(p);
      if (allChecked) cqFiltered.forEach((c) => n.delete(c.id));
      else cqFiltered.forEach((c) => n.add(c.id));
      return n;
    });

  /** A recipient plus the facts a template's pre-fill can draw on. The extra
   *  fields are local: only phone, name and the resolved params are sent. */
  const recipients: Array<{ phone: string; name?: string; company?: string; email?: string }> =
    mode === "contacts"
      ? reachable
          .filter((c) => picked.has(c.id))
          .map((c) => ({
            phone: c.phone as string,
            name: c.displayName,
            company: c.company,
            email: c.email,
          }))
      : parseRecipients(recipientsRaw);
  const varCount = template?.variableCount ?? 0;
  const paramsReady = Array.from({ length: varCount }).every((_, i) => (params[i] ?? "").trim().length > 0);
  const canSend =
    !!selected?.connected && !!template && recipients.length > 0 && paramsReady && !send.isPending;

  const doSend = () => {
    if (!selected || !template) return;
    setResult(null);
    // Each recipient gets the boxes resolved against their own record, so one
    // "{{contact.first_name}}" greets two hundred people by name. Anything with
    // no token in it is the same for everyone, which is the ordinary case and
    // costs nothing.
    const agentName = me.data?.user.name;
    const channelName = selected.name;
    // Only phone, name and the resolved params go over the wire — the company
    // and email are read here to resolve tokens and go no further, because the
    // send has no use for them.
    const withParams = recipients.map((r) => ({
      phone: r.phone,
      name: r.name,
      params: params.slice(0, varCount).map((p) =>
        resolveTemplateDefault(p ?? "", {
          contactName: r.name,
          contactCompany: r.company,
          contactPhone: r.phone,
          contactEmail: r.email,
          agentName,
          channelName,
        }),
      ),
    }));
    send.mutate(
      {
        inboxId: selected.id,
        templateId: template.id,
        // The unresolved patterns are still sent as the fallback the service
        // uses when a recipient carries none of their own.
        params: params.slice(0, varCount).map((p) => p ?? ""),
        recipients: withParams,
      },
      {
        onSuccess: (r) => {
          setResult(r);
          onToast(`Broadcast sent to ${r.sent}/${r.total} recipient${r.total === 1 ? "" : "s"}`);
        },
        onError: (err) => onToast((err as Error)?.message ?? "Couldn’t send the broadcast"),
      },
    );
  };

  return (
    <div className="setpane">
      <div className="setpane__head">
        <div>
          <h2>Broadcast</h2>
          <p>
            Send an approved template to many people at once. Each person gets their own 1:1
            WhatsApp message — the compliant way to reach a list. Replies land back in your inbox.
          </p>
        </div>
      </div>

      {inboxes.isSuccess && waNumbers.length === 0 && (
        <div className="setempty">
          Connect a WhatsApp number under Channels first — a broadcast is sent from a number.
        </div>
      )}

      {waNumbers.length > 0 && (
        <div className="setform">
          {waNumbers.length > 1 && (
            <label className="field">
              <span>Send from</span>
              <select value={inboxId ?? ""} onChange={(e) => setInboxId(e.target.value)}>
                {waNumbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                    {n.channelConfigPublic?.displayNumber ? ` · ${n.channelConfigPublic.displayNumber}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          {selected && !selected.connected && (
            <div className="setempty">
              This number isn’t connected yet — add its Phone number ID and access token under
              Channels first.
            </div>
          )}

          <label className="field">
            <span>Template</span>
            <select
              value={templateId}
              onChange={(e) => {
                const next = approved.find((t) => t.id === e.target.value);
                setTemplateId(e.target.value);
                // The template's saved pre-fill, left as written rather than
                // resolved: a broadcast has many recipients, so
                // "{{contact.first_name}}" here is one box that becomes a
                // different name for each of them at send time.
                setParams(
                  next ? Array.from({ length: next.variableCount }, (_, i) => next.variableDefaults[i] ?? "") : [],
                );
                setResult(null);
              }}
            >
              <option value="">Choose an approved template…</option>
              {approved.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </select>
            {templates.isSuccess && approved.length === 0 && (
              <small className="fieldhint">
                No approved templates yet. Create and approve one under Templates, or sync from Meta.
              </small>
            )}
            {template && <small className="fieldhint">{template.body}</small>}
          </label>

          {varCount > 0 && (
            <div className="setform__grid two">
              {Array.from({ length: varCount }).map((_, i) => (
                <label className="field" key={i}>
                  <span>{`Value for {{${i + 1}}}`}</span>
                  <input
                    value={params[i] ?? ""}
                    autoComplete="off"
                    onChange={(e) => {
                      const next = params.slice();
                      next[i] = e.target.value;
                      setParams(next);
                    }}
                    placeholder={`{{${i + 1}}}`}
                  />
                </label>
              ))}
            </div>
          )}
          {varCount > 0 && params.some((p) => /\{\{[a-z_.]+\}\}/i.test(p ?? "")) && (
            <small className="fieldhint">
              Values like <code>{"{{contact.first_name}}"}</code> are filled in per recipient — each person gets
              their own.
            </small>
          )}
          {varCount > 0 && (
            <small className="fieldhint">
              These values fill the template for every recipient. Per-person values aren’t
              supported here yet.
            </small>
          )}

          <div className="field">
            <span>
              Recipients {recipients.length > 0 && <em>{recipients.length}</em>}
            </span>
            <div className="bseg">
              <button type="button" className={mode === "contacts" ? "on" : ""} onClick={() => setMode("contacts")}>
                From customers
              </button>
              <button type="button" className={mode === "paste" ? "on" : ""} onClick={() => setMode("paste")}>
                Paste numbers
              </button>
            </div>

            {mode === "contacts" ? (
              <div className="bpick">
                <div className="setsearch bpick__search">
                  <SearchIcon />
                  <input value={cq} onChange={(e) => setCq(e.target.value)} placeholder="Search customers by name or number…" />
                </div>
                {reachable.length === 0 ? (
                  <div className="setempty">No customers with a WhatsApp number yet — add some under Customers.</div>
                ) : (
                  <>
                    <label className="bpick__all">
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                      Select all{cq.trim() ? ` matching · ${cqFiltered.length}` : ` customers · ${cqFiltered.length}`}
                    </label>
                    <div className="bpick__list">
                      {cqFiltered.map((c) => (
                        <label key={c.id} className={"bpick__row" + (picked.has(c.id) ? " on" : "")}>
                          <input type="checkbox" checked={picked.has(c.id)} onChange={() => togglePick(c.id)} />
                          <span className="bpick__name">{c.displayName}</span>
                          <span className="bpick__phone">{c.phone}</span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
                <small className="fieldhint">Only customers with a WhatsApp number appear; blocked customers are excluded.</small>
              </div>
            ) : (
              <>
                <textarea
                  value={recipientsRaw}
                  rows={6}
                  onChange={(e) => setRecipientsRaw(e.target.value)}
                  placeholder={"One phone number per line, e.g.\n+447700900123\n+447700900124, Jane Smith"}
                />
                <small className="fieldhint">
                  Include the country code. Optionally add a name after a comma. Up to 500 per broadcast.
                </small>
              </>
            )}
          </div>

          <div className="setform__foot">
            <button className="btn-primary" type="button" onClick={doSend} disabled={!canSend}>
              {send.isPending
                ? "Sending…"
                : recipients.length > 0
                  ? `Send to ${recipients.length}`
                  : "Send broadcast"}
            </button>
          </div>

          {result && (
            <div className="bcast-result">
              <div className="bcast-result__summary">
                <span className="bcast-pill bcast-pill--ok">{result.sent} sent</span>
                {result.failed > 0 && (
                  <span className="bcast-pill bcast-pill--fail">{result.failed} failed</span>
                )}
              </div>
              {result.results.some((r) => !r.ok) && (
                <ul className="bcast-fails">
                  {result.results
                    .filter((r) => !r.ok)
                    .map((r, i) => (
                      <li key={`${r.phone}-${i}`}>
                        <b>{r.phone}</b> — {r.error ?? "failed"}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Setup — app-level integration credentials                          */
/* ------------------------------------------------------------------ */

/** One integration, as a card in the grid — the same shape a channel, label or
 *  team uses: identity on top, state along the bottom, click to edit. The
 *  credentials themselves live in a modal, so the pane stays scannable instead
 *  of being five stacked forms. */
function IntegrationCard({
  color,
  glyph,
  name,
  blurb,
  summary,
  on,
  label,
  onClick,
}: {
  color: string;
  glyph: React.ReactNode;
  name: string;
  blurb: string;
  summary: string;
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className="chcard" type="button" onClick={onClick}>
      <div className="chcard__top">
        <span className="chcard__ic" style={{ color }}>
          {glyph}
        </span>
        <span className="chcard__name">
          <b>{name}</b>
          <small>{blurb}</small>
        </span>
      </div>
      <div className="chcard__foot">
        <span className="chcard__route chcard__route--plain" title={summary}>
          {summary}
        </span>
        <span className={"connpill " + (on ? "on" : "off")}>
          <span className="connpill__dot" />
          {label}
        </span>
      </div>
    </button>
  );
}

/** The credential sheet behind a card. Plain .modal/.modal--form so it inherits
 *  every other settings dialog's chrome, scroll behaviour and mobile sheet. */
function SetupModal({
  title,
  onClose,
  foot,
  children,
}: {
  title: string;
  onClose: () => void;
  foot: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box modal--form" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <h2>{title}</h2>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close">
            <XIcon />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        <div className="modal__foot">{foot}</div>
      </div>
    </div>
  );
}

function SetupPane({ sub, onToast }: { sub: SetupSub; onToast: (msg: string) => void }) {
  const integrations = useIntegrations();
  const update = useUpdateIntegrations();
  // Which credential sheet is open, if any.
  const [editing, setEditing] = useState<SetupKey | null>(null);
  const google = integrations.data?.google;
  const configured = Boolean(google?.configured);
  const meta = integrations.data?.meta;
  const metaConfigured = Boolean(meta?.configured);
  const storage = integrations.data?.storage;
  const storageConfigured = Boolean(storage?.configured);
  const smtp = integrations.data?.smtp;
  const smtpConfigured = Boolean(smtp?.configured);
  const resend = integrations.data?.resend;
  const resendConfigured = Boolean(resend?.configured);
  const anthropic = integrations.data?.anthropic;
  const anthropicConfigured = Boolean(anthropic?.configured);
  const transcription = integrations.data?.transcription;
  const transcriptionConfigured = Boolean(transcription?.configured);
  const push = integrations.data?.push;
  const pushConfigured = Boolean(push?.configured);
  // A test send goes via whichever transport is configured (Mailer tries Resend
  // first, then Gmail/SMTP), so enable the test whenever either is set up.
  const emailConfigured = resendConfigured || smtpConfigured;

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pubsubTopic, setPubsubTopic] = useState("");
  const [metaAppId, setMetaAppId] = useState("");
  const [metaAppSecret, setMetaAppSecret] = useState("");
  const [metaConfigId, setMetaConfigId] = useState("");
  const [r2AccountId, setR2AccountId] = useState("");
  const [r2Bucket, setR2Bucket] = useState("");
  const [r2AccessKeyId, setR2AccessKeyId] = useState("");
  const [r2SecretAccessKey, setR2SecretAccessKey] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpFrom, setSmtpFrom] = useState("");
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendFrom, setResendFrom] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [transcribeModel, setTranscribeModel] = useState("");
  const [expoAccessToken, setExpoAccessToken] = useState("");
  const [firebaseProjectId, setFirebaseProjectId] = useState("");
  const [firebaseProjectNumber, setFirebaseProjectNumber] = useState("");
  const [firebaseAppId, setFirebaseAppId] = useState("");
  const [firebaseStorageBucket, setFirebaseStorageBucket] = useState("");
  const [polishPrompt, setPolishPrompt] = useState("");
  const [subjectPrompt, setSubjectPrompt] = useState("");
  const [aiSubjects, setAiSubjects] = useState(true);
  const [aiTesting, setAiTesting] = useState(false);
  // Models this key can use. Empty + an error => the field degrades to free text.
  const [aiModels, setAiModels] = useState<{ id: string; name: string }[]>([]);
  const [aiModelsError, setAiModelsError] = useState("");
  const [aiModelsLoading, setAiModelsLoading] = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Prefill non-secret values from the stored settings once they load.
  useEffect(() => {
    if (google?.clientId !== undefined) setClientId(google.clientId);
  }, [google?.clientId]);
  useEffect(() => {
    if (google?.pubsubTopic !== undefined) setPubsubTopic(google.pubsubTopic);
  }, [google?.pubsubTopic]);
  useEffect(() => {
    if (meta?.appId !== undefined) setMetaAppId(meta.appId);
  }, [meta?.appId]);
  useEffect(() => {
    if (meta?.configId !== undefined) setMetaConfigId(meta.configId);
  }, [meta?.configId]);
  useEffect(() => {
    if (storage?.accountId !== undefined) setR2AccountId(storage.accountId);
  }, [storage?.accountId]);
  useEffect(() => {
    if (storage?.bucket !== undefined) setR2Bucket(storage.bucket);
  }, [storage?.bucket]);
  useEffect(() => {
    if (smtp?.host !== undefined) setSmtpHost(smtp.host);
  }, [smtp?.host]);
  useEffect(() => {
    if (smtp?.port !== undefined) setSmtpPort(String(smtp.port));
  }, [smtp?.port]);
  useEffect(() => {
    if (smtp?.username !== undefined) setSmtpUsername(smtp.username);
  }, [smtp?.username]);
  useEffect(() => {
    if (anthropic?.model !== undefined) setAnthropicModel(anthropic.model);
  }, [anthropic?.model]);
  useEffect(() => {
    if (push?.projectId !== undefined) setFirebaseProjectId(push.projectId);
  }, [push?.projectId]);
  useEffect(() => {
    if (push?.projectNumber !== undefined) setFirebaseProjectNumber(push.projectNumber);
  }, [push?.projectNumber]);
  useEffect(() => {
    if (push?.appId !== undefined) setFirebaseAppId(push.appId);
  }, [push?.appId]);
  useEffect(() => {
    if (push?.storageBucket !== undefined) setFirebaseStorageBucket(push.storageBucket);
  }, [push?.storageBucket]);
  // The prompt is long and hand-edited, so it prefills from the server (which
  // seeds it with DEFAULT_POLISH_PROMPT) rather than starting blank.
  useEffect(() => {
    if (anthropic?.polishPrompt !== undefined) setPolishPrompt(anthropic.polishPrompt);
  }, [anthropic?.polishPrompt]);
  useEffect(() => {
    if (anthropic?.subjectPrompt !== undefined) setSubjectPrompt(anthropic.subjectPrompt);
  }, [anthropic?.subjectPrompt]);
  useEffect(() => {
    if (anthropic?.subjects !== undefined) setAiSubjects(anthropic.subjects);
  }, [anthropic?.subjects]);
  useEffect(() => {
    if (smtp?.from !== undefined) setSmtpFrom(smtp.from);
  }, [smtp?.from]);
  useEffect(() => {
    if (resend?.from !== undefined) setResendFrom(resend.from);
  }, [resend?.from]);

  const saveGoogle = () => {
    const input: {
      googleClientId?: string;
      googleClientSecret?: string;
      googlePubsubTopic?: string;
    } = {};
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (id) input.googleClientId = id;
    if (secret) input.googleClientSecret = secret; // only send the secret when set
    // Send the topic only when it changed (empty clears it → polling-only).
    if (pubsubTopic.trim() !== (google?.pubsubTopic ?? "")) {
      input.googlePubsubTopic = pubsubTopic.trim();
    }
    if (input.googleClientId === undefined && input.googleClientSecret === undefined && input.googlePubsubTopic === undefined) {
      onToast("Enter a Client ID and Secret to save");
      return;
    }
    update.mutate(input, {
      onSuccess: () => {
        setClientSecret("");
        onToast("Google settings saved");
        setEditing(null);
      },
      onError: () => onToast("Only admins & managers can change setup"),
    });
  };

  const saveMeta = () => {
    const input: { metaAppId?: string; metaAppSecret?: string; metaConfigId?: string } = {};
    const id = metaAppId.trim();
    const secret = metaAppSecret.trim();
    if (id) input.metaAppId = id;
    if (secret) input.metaAppSecret = secret; // only send the secret when set
    if (metaConfigId.trim() !== (meta?.configId ?? "")) input.metaConfigId = metaConfigId.trim();
    if (input.metaAppId === undefined && input.metaAppSecret === undefined && input.metaConfigId === undefined) {
      onToast("Enter an App ID and Secret to save");
      return;
    }
    update.mutate(input, {
      onSuccess: () => {
        setMetaAppSecret("");
        onToast("Meta settings saved");
        setEditing(null);
      },
      onError: () => onToast("Only admins & managers can change setup"),
    });
  };

  const savePush = () => {
    const input: {
      expoAccessToken?: string;
      firebaseProjectId?: string;
      firebaseProjectNumber?: string;
      firebaseAppId?: string;
      firebaseStorageBucket?: string;
    } = {};
    // The Firebase values are the project's public identifiers, so they send on
    // any change and an empty one clears back to the environment.
    if (firebaseProjectId.trim() !== (push?.projectId ?? "")) input.firebaseProjectId = firebaseProjectId.trim();
    if (firebaseProjectNumber.trim() !== (push?.projectNumber ?? ""))
      input.firebaseProjectNumber = firebaseProjectNumber.trim();
    if (firebaseAppId.trim() !== (push?.appId ?? "")) input.firebaseAppId = firebaseAppId.trim();
    if (firebaseStorageBucket.trim() !== (push?.storageBucket ?? ""))
      input.firebaseStorageBucket = firebaseStorageBucket.trim();
    // The token is write-only — only sent when the field has something in it,
    // so leaving it blank keeps whatever is already stored.
    const token = expoAccessToken.trim();
    if (token) input.expoAccessToken = token;
    if (Object.keys(input).length === 0) {
      onToast("Nothing to save — change a field first");
      return;
    }
    update.mutate(input, {
      onSuccess: () => {
        setExpoAccessToken("");
        onToast("Push settings saved");
        setEditing(null);
      },
      onError: () => onToast("Only admins & managers can change setup"),
    });
  };

  const saveStorage = () => {
    const input: {
      r2AccountId?: string;
      r2Bucket?: string;
      r2AccessKeyId?: string;
      r2SecretAccessKey?: string;
    } = {};
    // Account id + bucket are non-secret — send when changed (empty clears).
    if (r2AccountId.trim() !== (storage?.accountId ?? "")) input.r2AccountId = r2AccountId.trim();
    if (r2Bucket.trim() !== (storage?.bucket ?? "")) input.r2Bucket = r2Bucket.trim();
    // Keys are write-only — only send when the field has a value.
    const akid = r2AccessKeyId.trim();
    const secret = r2SecretAccessKey.trim();
    if (akid) input.r2AccessKeyId = akid;
    if (secret) input.r2SecretAccessKey = secret;
    if (Object.keys(input).length === 0) {
      onToast("Enter your R2 details to save");
      return;
    }
    update.mutate(input, {
      onSuccess: () => {
        setR2AccessKeyId("");
        setR2SecretAccessKey("");
        onToast("Storage settings saved");
        setEditing(null);
      },
      onError: () => onToast("Only admins & managers can change setup"),
    });
  };

  const saveSmtp = () => {
    const input: {
      smtpHost?: string;
      smtpPort?: number;
      smtpUsername?: string;
      smtpPassword?: string;
      smtpFrom?: string;
    } = {};
    // Host/port/username/from are non-secret — send when changed (empty clears).
    if (smtpHost.trim() !== (smtp?.host ?? "")) input.smtpHost = smtpHost.trim();
    if (smtpPort.trim() && Number(smtpPort) !== (smtp?.port ?? 587)) input.smtpPort = Number(smtpPort);
    if (smtpUsername.trim() !== (smtp?.username ?? "")) input.smtpUsername = smtpUsername.trim();
    if (smtpFrom.trim() !== (smtp?.from ?? "")) input.smtpFrom = smtpFrom.trim();
    // The app password is write-only — send only when the field has a value.
    const pw = smtpPassword.trim();
    if (pw) input.smtpPassword = pw;
    if (Object.keys(input).length === 0) {
      onToast("Enter your SMTP details to save");
      return;
    }
    update.mutate(input, {
      onSuccess: () => {
        setSmtpPassword("");
        onToast("Email settings saved");
        setEditing(null);
      },
      onError: () => onToast("Only admins & managers can change setup"),
    });
  };

  const saveResend = () => {
    const input: { resendApiKey?: string; resendFrom?: string } = {};
    // From is non-secret — send when changed (empty clears). The API key is
    // write-only — send only when the field has a value.
    if (resendFrom.trim() !== (resend?.from ?? "")) input.resendFrom = resendFrom.trim();
    const key = resendApiKey.trim();
    if (key) input.resendApiKey = key;
    if (Object.keys(input).length === 0) {
      onToast("Enter your Resend API key to save");
      return;
    }
    update.mutate(input, {
      onSuccess: () => {
        setResendApiKey("");
        onToast("Resend settings saved");
        setEditing(null);
      },
      onError: () => onToast("Only admins & managers can change setup"),
    });
  };

  // Ask the key what it can run, when the sheet opens. Nothing is hardcoded:
  // available model ids differ per account and change over time.
  useEffect(() => {
    if (editing !== "anthropic" || !anthropicConfigured) return;
    let cancelled = false;
    setAiModelsLoading(true);
    setAiModelsError("");
    api
      .aiModels()
      .then((res) => {
        if (cancelled) return;
        setAiModels(res.models);
        setAiModelsError(res.error ?? "");
      })
      .catch(() => {
        if (!cancelled) setAiModelsError("Couldn't reach the server to list models");
      })
      .finally(() => {
        if (!cancelled) setAiModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editing, anthropicConfigured]);

  const saveAnthropic = () => {
    const input: {
      anthropicApiKey?: string;
      anthropicModel?: string;
      anthropicPolishPrompt?: string;
      anthropicSubjects?: boolean;
      anthropicSubjectPrompt?: string;
    } = {};
    // Model + prompt are non-secret — send when changed (empty resets to the
    // built-in default). The API key is write-only — send only when entered.
    if (anthropicModel.trim() !== (anthropic?.model ?? "")) input.anthropicModel = anthropicModel.trim();
    if (polishPrompt.trim() !== (anthropic?.polishPrompt ?? "")) input.anthropicPolishPrompt = polishPrompt.trim();
    if (aiSubjects !== (anthropic?.subjects ?? true)) input.anthropicSubjects = aiSubjects;
    if (subjectPrompt.trim() !== (anthropic?.subjectPrompt ?? "")) input.anthropicSubjectPrompt = subjectPrompt.trim();
    const key = anthropicApiKey.trim();
    if (key) input.anthropicApiKey = key;
    if (Object.keys(input).length === 0) {
      onToast("Enter your Claude API key to save");
      return;
    }
    update.mutate(input, {
      onSuccess: () => {
        setAnthropicApiKey("");
        onToast("AI settings saved");
        setEditing(null);
      },
      onError: () => onToast("Only admins & managers can change setup"),
    });
  };

  useEffect(() => {
    if (transcription?.model !== undefined) setTranscribeModel(transcription.model);
  }, [transcription?.model]);

  const saveTranscription = () => {
    const input: { openaiApiKey?: string; transcribeModel?: string } = {};
    if (transcribeModel.trim() !== (transcription?.model ?? "")) input.transcribeModel = transcribeModel.trim();
    const key = openaiApiKey.trim();
    if (key) input.openaiApiKey = key;
    if (Object.keys(input).length === 0) {
      onToast("Enter your OpenAI API key to save");
      return;
    }
    update.mutate(input, {
      onSuccess: () => {
        setOpenaiApiKey("");
        onToast("Transcription settings saved");
        setEditing(null);
      },
      onError: () => onToast("Only admins & managers can change setup"),
    });
  };

  const testAi = async () => {
    setAiTesting(true);
    try {
      const res = await api.testAi();
      // Show Claude's own words on failure — that's what names a bad model.
      onToast(res.ok ? `Claude replied: “${res.sample ?? ""}”` : res.error || "Claude couldn't be reached");
    } catch {
      onToast("Couldn't reach the server to test Claude");
    } finally {
      setAiTesting(false);
    }
  };

  const testSmtp = async () => {
    setSmtpTesting(true);
    try {
      const res = await api.testSmtp();
      onToast(res.sent ? "Test email sent — check your inbox" : `Couldn't send: ${res.error ?? "not configured"}`);
    } catch {
      onToast("Couldn't send test email");
    } finally {
      setSmtpTesting(false);
    }
  };

  const copy = async (value: string | undefined, key: string, label: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      onToast(`${label} copied`);
      window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      onToast("Couldn't copy — select the URL and copy manually");
    }
  };


  // Close the sheet once a save lands, so the card's summary + status pill are
  // the confirmation — the same rhythm as editing a channel, label or team.
  const close = () => setEditing(null);

  return (
    <div className="setpane setpane--wide">
      <div className="setpane__head">
        <div>
          <h2>{SETUP_HEAD[sub].h}</h2>
          <p>{SETUP_HEAD[sub].p}</p>
        </div>
      </div>

      <div className="cardgrid">
        {sub === "connections" && (
          <>
            <IntegrationCard
              color="#EA4335"
              glyph={<GmailGlyph />}
              name="Google / Gmail"
              blurb="One-click Gmail connect"
              summary={google?.clientId || "No client ID yet"}
              on={configured}
              label={configured ? "Configured" : "Not configured"}
              onClick={() => setEditing("google")}
            />
            <IntegrationCard
              color={channelMeta("whatsapp").color}
              glyph={(() => {
                const G = channelMeta("whatsapp").Glyph;
                return <G />;
              })()}
              name="Meta / WhatsApp"
              blurb="One-click WhatsApp connect"
              summary={meta?.appId ? `App ID ${meta.appId}` : "No app ID yet"}
              on={metaConfigured}
              label={metaConfigured ? "Configured" : "Not configured"}
              onClick={() => setEditing("meta")}
            />
          </>
        )}

        {sub === "storage" && (
          <IntegrationCard
            color="#F6821F"
            glyph={<StorageIcon />}
            name="Cloudflare R2"
            blurb="Media storage bucket"
            summary={storage?.bucket ? `Bucket ${storage.bucket}` : "Local disk — wiped on redeploy"}
            on={storageConfigured}
            label={storageConfigured ? "Storing in R2" : "Ephemeral disk"}
            onClick={() => setEditing("storage")}
          />
        )}

        {sub === "ai" && (
          <IntegrationCard
            color="#D97757"
            glyph={<SparkleIcon />}
            name="Claude"
            blurb="Polishes drafts on request, and writes conversation subjects"
            summary={anthropicConfigured ? (anthropic?.model ?? "") : "No API key yet"}
            on={anthropicConfigured}
            label={anthropicConfigured ? "Connected" : "Not connected"}
            onClick={() => setEditing("anthropic")}
          />
        )}

        {sub === "ai" && (
          <IntegrationCard
            color="#10A37F"
            glyph={<MicIcon />}
            name="Transcription"
            blurb="Turns voice notes into words when someone taps Transcribe"
            summary={transcriptionConfigured ? (transcription?.model ?? "") : "No OpenAI key yet"}
            on={transcriptionConfigured}
            label={transcriptionConfigured ? "Connected" : "Not connected"}
            onClick={() => setEditing("transcription")}
          />
        )}

        {sub === "push" && (
          <IntegrationCard
            color="#FFA000"
            glyph={<BellIcon />}
            name="Firebase / Expo push"
            blurb="How a new message reaches the phone"
            summary={push?.projectId ? `Project ${push.projectId}` : "No Firebase project recorded"}
            on={pushConfigured}
            label={pushConfigured ? "Token set" : "Unauthenticated sends"}
            onClick={() => setEditing("push")}
          />
        )}

        {sub === "email" && (
          <>
            <IntegrationCard
              color="#5B8DEF"
              glyph={<MailIcon />}
              name="Resend"
              blurb="Recommended sender"
              summary={resend?.from || "No sender set"}
              on={resendConfigured}
              label={resendConfigured ? "Connected" : "Not connected"}
              onClick={() => setEditing("resend")}
            />
            <IntegrationCard
              color="#EA4335"
              glyph={<MailIcon />}
              name="SMTP"
              blurb="Fallback sender"
              summary={smtp?.host ? `${smtp.host}:${smtp.port ?? 587}` : "No server set"}
              on={smtpConfigured}
              label={smtpConfigured ? "Connected" : "Not connected"}
              onClick={() => setEditing("smtp")}
            />
          </>
        )}
      </div>

      {editing === "google" && (
        <SetupModal
          title="Google / Gmail"
          onClose={close}
          foot={
            <>
              <button className="btn-ghost" type="button" onClick={close}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={saveGoogle} disabled={update.isPending || integrations.isLoading}>
                Save
              </button>
            </>
          }
        >
          <p className="fieldhint">
            These are the app-level Google OAuth credentials from your Google Cloud project’s OAuth 2.0 Client ID. People then connect their own Gmail with one click.
          </p>

          <div className="setform__grid two">
            <label className="field">
              <span>Client ID</span>
              <input
                value={clientId}
                autoComplete="off"
                onChange={(e) => setClientId(e.target.value)}
                placeholder="1029384756-abc123.apps.googleusercontent.com"
              />
            </label>
            <label className="field">
              <span>Client Secret</span>
              <input
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={configured ? "••••• (hidden)" : "GOCSPX-…"}
              />
            </label>
          </div>

          <div className="field">
            <span>Redirect URI</span>
            <div className="copyrow">
              <input readOnly value={google?.redirectUri ?? ""} onFocus={(e) => e.target.select()} />
              <button className="btn-ghost" type="button" onClick={() => copy(google?.redirectUri, "redirect", "Redirect URI")}>
                {copiedKey === "redirect" ? "Copied" : "Copy"}
              </button>
            </div>
            <small className="fieldhint">Add this exact URL to your Google Cloud OAuth client’s Authorized redirect URIs.</small>
          </div>

          <div className="setform__sub">
            <b>Real-time delivery (optional)</b>
            <small>
              Gmail is checked every minute by default. For near-instant delivery, create a Google Cloud Pub/Sub
              topic, add the push endpoint below as its subscription, then paste the topic name here. Leave blank to
              keep polling.
            </small>
          </div>

          <div className="field">
            <span>Pub/Sub topic</span>
            <input
              value={pubsubTopic}
              autoComplete="off"
              onChange={(e) => setPubsubTopic(e.target.value)}
              placeholder="projects/your-project/topics/gmail-push"
            />
          </div>

          <div className="field">
            <span>Push endpoint</span>
            <div className="copyrow">
              <input readOnly value={google?.pushEndpoint ?? ""} onFocus={(e) => e.target.select()} />
              <button className="btn-ghost" type="button" onClick={() => copy(google?.pushEndpoint, "push", "Push endpoint")}>
                {copiedKey === "push" ? "Copied" : "Copy"}
              </button>
            </div>
            <small className="fieldhint">Register this as your Pub/Sub push subscription’s endpoint URL.</small>
          </div>
        </SetupModal>
      )}

      {editing === "meta" && (
        <SetupModal
          title="Meta / WhatsApp"
          onClose={close}
          foot={
            <>
              <button className="btn-ghost" type="button" onClick={close}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={saveMeta} disabled={update.isPending || integrations.isLoading}>
                Save
              </button>
            </>
          }
        >
          <p className="fieldhint">
            These are the app-level credentials from your Meta app (App ID + Secret). People then connect their
            WhatsApp Business number with one click via Meta Business Suite.
          </p>

          <div className="setform__grid two">
            <label className="field">
              <span>App ID</span>
              <input
                value={metaAppId}
                autoComplete="off"
                onChange={(e) => setMetaAppId(e.target.value)}
                placeholder="1234567890123456"
              />
            </label>
            <label className="field">
              <span>App Secret</span>
              <input
                type="password"
                autoComplete="off"
                value={metaAppSecret}
                onChange={(e) => setMetaAppSecret(e.target.value)}
                placeholder={metaConfigured ? "••••• (hidden)" : "app secret"}
              />
            </label>
          </div>

          <div className="field">
            <span>Redirect URI</span>
            <div className="copyrow">
              <input readOnly value={meta?.redirectUri ?? ""} onFocus={(e) => e.target.select()} />
              <button className="btn-ghost" type="button" onClick={() => copy(meta?.redirectUri, "meta-redirect", "Redirect URI")}>
                {copiedKey === "meta-redirect" ? "Copied" : "Copy"}
              </button>
            </div>
            <small className="fieldhint">Add this exact URL under Facebook Login → Valid OAuth Redirect URIs.</small>
          </div>

          <div className="setform__sub">
            <b>Guided onboarding (optional)</b>
            <small>
              Paste your WhatsApp Embedded Signup configuration id to turn the popup into Meta’s guided number
              onboarding. Leave blank to connect an existing number via standard login.
            </small>
          </div>

          <div className="field">
            <span>Embedded Signup config id</span>
            <input
              value={metaConfigId}
              autoComplete="off"
              onChange={(e) => setMetaConfigId(e.target.value)}
              placeholder="Optional — e.g. 987654321098765"
            />
          </div>
        </SetupModal>
      )}

      {editing === "push" && (
        <SetupModal
          title="Firebase / Expo push"
          onClose={close}
          foot={
            <>
              <button className="btn-ghost" type="button" onClick={close}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={savePush} disabled={update.isPending || integrations.isLoading}>
                Save
              </button>
            </>
          }
        >
          <p className="fieldhint">
            A notification travels app → Expo → Firebase → phone. Expo does the Firebase call using the service-account
            key uploaded to <b>EAS credentials</b> — that key is never held here, and there is nothing to paste for it.
            What this screen holds is the access token that authenticates <i>our</i> sends to Expo, and a record of which
            Firebase project the app is pointed at. Takes effect within seconds of saving — no redeploy.
          </p>

          <label className="field">
            <span>Expo access token</span>
            <input
              type="password"
              value={expoAccessToken}
              autoComplete="off"
              onChange={(e) => setExpoAccessToken(e.target.value)}
              placeholder={pushConfigured ? "Saved — leave blank to keep it" : "Optional, but recommended"}
            />
          </label>
          <p className="fieldhint">
            Expo accepts sends without a token. With one — and “enhanced security” switched on in your Expo account —
            anyone who learns a device’s push token still can’t send to that phone in your name.
          </p>

          <div className="setform__grid two">
            <label className="field">
              <span>Firebase project ID</span>
              <input
                value={firebaseProjectId}
                autoComplete="off"
                onChange={(e) => setFirebaseProjectId(e.target.value)}
                placeholder="e.g. nestconnect-d5489"
              />
            </label>
            <label className="field">
              <span>Sender ID (project number)</span>
              <input
                value={firebaseProjectNumber}
                autoComplete="off"
                onChange={(e) => setFirebaseProjectNumber(e.target.value)}
                placeholder="e.g. 186082168787"
              />
            </label>
            <label className="field">
              <span>Android app ID</span>
              <input
                value={firebaseAppId}
                autoComplete="off"
                onChange={(e) => setFirebaseAppId(e.target.value)}
                placeholder="1:000000000000:android:…"
              />
            </label>
            <label className="field">
              <span>Storage bucket</span>
              <input
                value={firebaseStorageBucket}
                autoComplete="off"
                onChange={(e) => setFirebaseStorageBucket(e.target.value)}
                placeholder="your-project.firebasestorage.app"
              />
            </label>
          </div>
          <p className="fieldhint">
            These four are the project’s public identifiers, copied from <code>google-services.json</code> in the mobile
            app. Nothing sends them anywhere — they’re recorded so that when pushes stop, “which Firebase project is the
            app actually on?” has an answer here rather than inside a build artefact. The app itself reads its copy at
            build time, so changing them here does not repoint a phone that’s already installed.
          </p>
        </SetupModal>
      )}

      {editing === "storage" && (
        <SetupModal
          title="Cloudflare R2"
          onClose={close}
          foot={
            <>
              <button className="btn-ghost" type="button" onClick={close}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={saveStorage} disabled={update.isPending || integrations.isLoading}>
                Save
              </button>
            </>
          }
        >
          <p className="fieldhint">
            Without R2, uploaded media lives on the server’s local disk, which is wiped on every redeploy. Add a
            Cloudflare R2 bucket and an <b>Object Read &amp; Write</b> API token to keep media permanently. Takes effect
            within a few seconds of saving — no redeploy needed.
          </p>

          <div className="setform__grid two">
            <label className="field">
              <span>Account ID</span>
              <input
                value={r2AccountId}
                autoComplete="off"
                onChange={(e) => setR2AccountId(e.target.value)}
                placeholder="e.g. 8f2a…c1 (Cloudflare account id)"
              />
            </label>
            <label className="field">
              <span>Bucket</span>
              <input
                value={r2Bucket}
                autoComplete="off"
                onChange={(e) => setR2Bucket(e.target.value)}
                placeholder="e.g. nest-media"
              />
            </label>
          </div>

          <div className="setform__grid two">
            <label className="field">
              <span>Access Key ID</span>
              <input
                type="password"
                autoComplete="off"
                value={r2AccessKeyId}
                onChange={(e) => setR2AccessKeyId(e.target.value)}
                placeholder={storageConfigured ? "••••• (hidden)" : "R2 token access key id"}
              />
            </label>
            <label className="field">
              <span>Secret Access Key</span>
              <input
                type="password"
                autoComplete="off"
                value={r2SecretAccessKey}
                onChange={(e) => setR2SecretAccessKey(e.target.value)}
                placeholder={storageConfigured ? "••••• (hidden)" : "R2 token secret"}
              />
            </label>
          </div>

          <p className="fieldhint">
            In Cloudflare → R2: create a bucket, then under <b>Manage R2 API Tokens</b> create a token with
            Object Read &amp; Write permission. Copy the Account ID, Access Key ID and Secret here. Clear the bucket to
            switch back to disk.
          </p>
        </SetupModal>
      )}

      {editing === "resend" && (
        <SetupModal
          title="Email sending · Resend"
          onClose={close}
          foot={
            <>
              <button className="btn-ghost" type="button" onClick={testSmtp} disabled={smtpTesting || !emailConfigured}>
                {smtpTesting ? "Sending…" : "Send test email"}
              </button>
              <button className="btn-primary" type="button" onClick={saveResend} disabled={update.isPending || integrations.isLoading}>
                Save
              </button>
            </>
          }
        >
          <p className="fieldhint">
            Create an API key at <b>resend.com</b> → API Keys, and verify your sending domain (Domains). The from-address
            must be on a verified domain. Takes effect immediately — no redeploy needed.
          </p>

          <div className="setform__grid two">
            <label className="field">
              <span>Resend API key</span>
              <input
                type="password"
                autoComplete="off"
                value={resendApiKey}
                onChange={(e) => setResendApiKey(e.target.value)}
                placeholder={resendConfigured ? "••••• (hidden)" : "re_…"}
              />
            </label>
            <label className="field">
              <span>From address</span>
              <input
                value={resendFrom}
                autoComplete="off"
                onChange={(e) => setResendFrom(e.target.value)}
                placeholder="NestConnect <noreply@yourdomain.com>"
              />
            </label>
          </div>
        </SetupModal>
      )}

      {editing === "transcription" && (
        <SetupModal
          title="Transcription (OpenAI)"
          onClose={close}
          foot={
            <button className="btn-primary" type="button" onClick={saveTranscription} disabled={update.isPending || integrations.isLoading}>
              Save
            </button>
          }
        >
          <p className="fieldhint">
            Every voice note — WhatsApp, website chat and Team Chat, on the web and in the app — has a{" "}
            <b>Transcribe</b> button under it. The first tap sends that one recording to OpenAI and keeps the words on
            the note, so everyone sees them from then on and it's only paid for once. Nothing is transcribed unless
            someone asks.
          </p>
          <p className="fieldhint">
            Create a key at <b>platform.openai.com</b> → API keys. Claude can't listen to audio, which is why this one
            is separate.
          </p>
          <div className="setform__grid two">
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                autoComplete="off"
                value={openaiApiKey}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
                placeholder={transcriptionConfigured ? "••••• (hidden)" : "sk-…"}
              />
            </label>
            <label className="field">
              <span>Model</span>
              <input
                value={transcribeModel}
                autoComplete="off"
                onChange={(e) => setTranscribeModel(e.target.value)}
                placeholder="gpt-4o-mini-transcribe"
              />
              <em>Clear it and save to go back to the default.</em>
            </label>
          </div>
        </SetupModal>
      )}

      {editing === "anthropic" && (
        <SetupModal
          title="Claude (Anthropic)"
          onClose={close}
          foot={
            <>
              <button className="btn-ghost" type="button" onClick={testAi} disabled={aiTesting || !anthropicConfigured}>
                {aiTesting ? "Testing…" : "Test"}
              </button>
              <button className="btn-primary" type="button" onClick={saveAnthropic} disabled={update.isPending || integrations.isLoading}>
                Save
              </button>
            </>
          }
        >
          <p className="fieldhint">
            Create a key at <b>console.anthropic.com</b> → API Keys. With one set, a <b>Polish</b> button appears in the
            composer: one tap tidies the agent’s draft before they send it. Claude never sends anything itself, and
            never replies on its own — it only rewrites a draft the agent has already written.
          </p>
          <p className="fieldhint">
            Save the key first — the <b>Model</b> list below then fills itself from your own account, so there is no
            id to look up. Hit <b>Test</b> afterwards: it runs one real polish and reports back what Claude said.
          </p>

          <div className="setform__grid two">
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                autoComplete="off"
                value={anthropicApiKey}
                onChange={(e) => setAnthropicApiKey(e.target.value)}
                placeholder={anthropicConfigured ? "••••• (hidden)" : "sk-ant-…"}
              />
            </label>
            <label className="field">
              <span>Model</span>
              {aiModels.length > 0 ? (
                <select value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)}>
                  {/* Keep whatever is saved selectable even if the key no longer
                      lists it, so opening this sheet never silently changes it. */}
                  {anthropicModel && !aiModels.some((m) => m.id === anthropicModel) && (
                    <option value={anthropicModel}>{anthropicModel} (not offered by this key)</option>
                  )}
                  {aiModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name === m.id ? m.id : `${m.name} — ${m.id}`}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={anthropicModel}
                  autoComplete="off"
                  onChange={(e) => setAnthropicModel(e.target.value)}
                  placeholder="claude-sonnet-4-5"
                />
              )}
              <em>
                {aiModelsLoading
                  ? "Loading the models your key can use…"
                  : aiModels.length > 0
                    ? `${aiModels.length} models available on this key`
                    : aiModelsError || "Save an API key, then reopen this to pick from your available models."}
              </em>
            </label>
          </div>

          <div className="setform__sub">
            <b>Polish instruction</b>
            <small>
              What Claude is told before it sees a draft. The rules below are what keep Polish safe: it may change
              how a message reads, never what it says. Edit to match your tone of voice — clear the box and save to
              restore the default.
            </small>
          </div>

          <label className="field">
            <span>Prompt</span>
            <textarea
              className="prompttext"
              rows={14}
              spellCheck={false}
              value={polishPrompt}
              onChange={(e) => setPolishPrompt(e.target.value)}
              placeholder="Loading the default instruction…"
            />
          </label>

          <div className="setform__sub">
            <b>Conversation subjects</b>
            <small>
              New WhatsApp and website-chat conversations get a subject written from the customer's first messages
              — “Refund for damaged parcel” — so the inbox list says what each one is about. Any custom field
              values on the conversation are put in front automatically (“Order ID DG-88412 · …”), whatever the
              prompt says. Turning this on sends those first messages to Claude.
            </small>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              className={"switch sm" + (aiSubjects ? " on" : "")}
              role="switch"
              aria-checked={aiSubjects}
              aria-label="Write conversation subjects with AI"
              onClick={() => setAiSubjects((v) => !v)}
            >
              <span className="switch__dot" />
            </button>
            <span>Write subjects for new WhatsApp and website-chat conversations</span>
          </div>

          <label className="field">
            <span>Subject prompt</span>
            <textarea
              className="prompttext"
              rows={12}
              spellCheck={false}
              value={subjectPrompt}
              disabled={!aiSubjects}
              onChange={(e) => setSubjectPrompt(e.target.value)}
              placeholder="Loading the default instruction…"
            />
            <em className="fieldhint">Clear the box and save to restore the default.</em>
          </label>
        </SetupModal>
      )}

      {editing === "smtp" && (
        <SetupModal
          title="Email sending · SMTP"
          onClose={close}
          foot={
            <>
              <button className="btn-ghost" type="button" onClick={testSmtp} disabled={smtpTesting || !emailConfigured}>
                {smtpTesting ? "Sending…" : "Send test email"}
              </button>
              <button className="btn-primary" type="button" onClick={saveSmtp} disabled={update.isPending || integrations.isLoading}>
                Save
              </button>
            </>
          }
        >
          <p className="fieldhint">
            Works with Gmail using an <b>app password</b> (Google Account → Security → 2-Step Verification → App
            passwords). Host <b>smtp.gmail.com</b>, port <b>587</b>, username = your Gmail address. Takes effect
            immediately — no redeploy needed.
          </p>

          <div className="setform__grid two">
            <label className="field">
              <span>SMTP host</span>
              <input value={smtpHost} autoComplete="off" onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.gmail.com" />
            </label>
            <label className="field">
              <span>Port</span>
              <input value={smtpPort} autoComplete="off" inputMode="numeric" onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" />
            </label>
          </div>
          <div className="setform__grid two">
            <label className="field">
              <span>Username (email)</span>
              <input value={smtpUsername} autoComplete="off" onChange={(e) => setSmtpUsername(e.target.value)} placeholder="you@gmail.com" />
            </label>
            <label className="field">
              <span>App password</span>
              <input
                type="password"
                autoComplete="off"
                value={smtpPassword}
                onChange={(e) => setSmtpPassword(e.target.value)}
                placeholder={smtpConfigured ? "••••• (hidden)" : "16-character app password"}
              />
            </label>
          </div>
          <div className="setform__grid two">
            <label className="field">
              <span>From address</span>
              <input value={smtpFrom} autoComplete="off" onChange={(e) => setSmtpFrom(e.target.value)} placeholder="Defaults to the username" />
            </label>
          </div>
        </SetupModal>
      )}
    </div>
  );
}

