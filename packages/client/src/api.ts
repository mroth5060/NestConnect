import type {
  ConversationFilterCounts,
  Attachment,
  ChannelType,
  Contact,
  ContactDuplicateGroup,
  MergeContactsInput,
  CreateCustomFieldInput,
  CustomField,
  CustomFieldEntity,
  CustomFieldValue,
  UpdateCustomFieldInput,
  CreateTemplateInput,
  Template,
  UpdateTemplateInput,
  ContactWithConversations,
  ImportContactsInput,
  ImportContactsResult,
  Conversation,
  ConversationPage,
  ConversationStatus,
  MessagePage,
  Priority,
  ConversationWithMessages,
  CreateContactInput,
  CreateGroupInput,
  CreateInboxInput,
  CreateTeamInput,
  CreateUserInput,
  CreateLabelInput,
  ForwardResult,
  Inbox,
  IntegrationSettings,
  Label,
  Member,
  Message,
  Team,
  UpdateLabelInput,
  UpdateContactInput,
  UpdateInboxInput,
  NestChatPushTest,
  NestChatSettings,
  UpdateIntegrationSettingsInput,
  UpdateNestchatInput,
  PolishDraftInput,
  PolishDraftResult,
  UpdateTeamInput,
  Notification,
  UpdateMyPreferencesInput,
  UpdateMyProfileInput,
  ChangePasswordInput,
  SessionInfo,
  TwoFactorChallenge,
  TwoFactorStatus,
  TotpSetup,
  UpdateUserInput,
  User,
  WhatsAppBusinessProfile,
  UpdateWhatsAppBusinessProfileInput,
  WhatsAppNumberState,
  WhatsAppRegisterResult,
  SendBroadcastInput,
  BroadcastResult,
  AnalyticsResult,
  AnalyticsRange,
  DeviceInfo,
  PushPreferences,
  RegisterDeviceInput,
  SessionGrant,
  UpdatePushPreferencesInput,
} from "@ding/schemas";
import { authHeaders, clientConfig, type UploadFile, type UploadMeta } from "./config";

export interface ViewItem {
  key: string;
  title: string;
  count: number;
  channel?: ChannelType;
  handle?: string;
  groups?: { id: string; title: string }[];
  /** For "Later": how many snoozed items are now due (wake time passed). */
  due?: number;
  /** For a label view: its swatch colour. */
  color?: string;
}
export interface SidebarViews {
  my: ViewItem[];
  shared: { teams: ViewItem[]; inboxes: ViewItem[]; labels: ViewItem[] };
}
export interface MeResponse {
  user: User;
  teams: Team[];
  /** Whether this deployment holds an un-enrolled user at the 2FA setup gate.
   *  Always true in production; settable off in dev via AUTH_REQUIRE_2FA=false.
   *  Optional so a client running ahead of the API still compiles — read it as
   *  `!== false` at the gate, so an absent value keeps 2FA mandatory. */
  twoFactorEnforced?: boolean;
}
export interface CreateUserResult {
  user: User;
  /** Present when the person was invited (not seeded): the set-password link and
   *  whether it was emailed. Surface the link when `emailed` is false. */
  invite?: { url: string; emailed: boolean };
}

export interface ApiError extends Error {
  status: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, auth } = clientConfig();
  const res = await fetch(`${baseUrl}/api${path}`, {
    // The browser holds the session in an httpOnly cookie and needs to be told
    // to send it cross-origin; a native client carries it as a bearer header.
    ...(auth.kind === "cookie" ? { credentials: "include" as const } : {}),
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
  if (!res.ok) {
    // Surface the server's own message when it sent one (NestJS errors carry a
    // `message` string or array) so callers can show a real explanation — e.g.
    // WhatsApp's "check the Phone number ID" — instead of a bare status code.
    let serverMsg: string | undefined;
    try {
      const body = (await res.clone().json()) as { message?: string | string[] };
      if (typeof body?.message === "string") serverMsg = body.message;
      else if (Array.isArray(body?.message)) serverMsg = body.message.join(", ");
    } catch {
      /* no JSON body — fall back to the status line */
    }
    const err = new Error(serverMsg ?? `${init?.method ?? "GET"} ${path} failed: ${res.status}`) as ApiError;
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

/** Ask the server for a bearer token instead of a cookie, when that's this
 *  app's mode. Spread into the login bodies. */
const tokenAuth = () => (clientConfig().auth.kind === "bearer" ? { tokenAuth: true } : {});

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

const isUploadFile = (f: unknown): f is UploadFile =>
  typeof f === "object" && f !== null && typeof (f as UploadFile).uri === "string";

export const api = {
  // auth
  session: () => get<MeResponse>("/auth/session"),
  // Login → a session, OR a 2FA challenge when the account has 2FA on.
  //
  // `tokenAuth` follows the configured mode, so neither app has to think about
  // it: a browser gets its httpOnly cookie, a phone gets the token in the body.
  // The 2FA leg is the same story — the half-authenticated token comes back on
  // the challenge for token clients and is posted back with the code.
  // A remembered device skips the code: a browser's pass rides as a cookie,
  // a phone passes the one it was handed (`trustedDeviceToken`) back here.
  login: (email: string, password: string, trustedDeviceToken?: string) =>
    post<(MeResponse & SessionGrant) | TwoFactorChallenge>("/auth/login", {
      email,
      password,
      ...tokenAuth(),
      ...(trustedDeviceToken ? { trustedDeviceToken } : {}),
    }),
  // Second login step: submit the 2FA (or recovery) code → a session.
  // `rememberDevice` skips the code on this device for the next 30 days.
  loginTwoFactor: (code: string, pendingToken?: string, rememberDevice?: boolean) =>
    post<MeResponse & SessionGrant>("/auth/login/2fa", {
      code,
      ...tokenAuth(),
      ...(pendingToken ? { pendingToken } : {}),
      ...(rememberDevice ? { rememberDevice: true } : {}),
    }),
  resendLoginCode: (pendingToken?: string) =>
    post<{ ok: boolean }>("/auth/login/2fa/resend", pendingToken ? { pendingToken } : {}),
  // Native only: roll this device's token forward on the same session.
  refreshToken: () => post<SessionGrant>("/auth/refresh", {}),
  // Set an initial password from an emailed invite link, then sign in.
  // Answers with a session, or — when the account already has a second factor —
  // the same challenge a password login would give. A link to a mailbox is not
  // a second factor, so a reset can't be the way around one.
  setPassword: (token: string, password: string) =>
    post<MeResponse | TwoFactorChallenge>("/auth/set-password", { token, password }),
  // Request a password-reset link (always resolves; never reveals if the email exists).
  forgotPassword: (email: string) => post<{ ok: boolean }>("/auth/forgot-password", { email }),
  logout: () => post<{ ok: boolean }>("/auth/logout", {}),
  // Two-factor auth (personal settings).
  twoFactorStatus: () => get<TwoFactorStatus>("/auth/2fa/status"),
  startTotp: () => post<TotpSetup>("/auth/2fa/totp/start", {}),
  enableTotp: (code: string) => post<{ recoveryCodes: string[] }>("/auth/2fa/totp/enable", { code }),
  startEmail2fa: () => post<{ ok: boolean }>("/auth/2fa/email/start", {}),
  enableEmail2fa: (code: string) => post<{ recoveryCodes: string[] }>("/auth/2fa/email/enable", { code }),
  regenerateRecovery: () => post<{ recoveryCodes: string[] }>("/auth/2fa/recovery/regenerate", {}),
  disable2fa: () => post<{ ok: boolean }>("/auth/2fa/disable", {}),
  // workspace
  // Which of a channel's numbers/mailboxes replies go out from when a thread
  // is answered on a channel it didn't start on. `false` clears it.
  setDefaultInbox: (inboxId: string, isDefault: boolean) =>
    post<Inbox>(`/inboxes/${inboxId}/default`, { isDefault }),
  me: () => get<MeResponse>("/me"),
  // The current user's own personal settings (availability + email signature).
  updateMyPreferences: (input: UpdateMyPreferencesInput) => patch<User>("/me/preferences", input),
  // The current user's own profile — name, login email, photo.
  updateMyProfile: (input: UpdateMyProfileInput) => patch<User>("/me/profile", input),
  // Change your own password (current one is re-verified server-side).
  // `signedOutOthers` counts the other devices this signed out — a password
  // change ends every session the old one opened, keeping only the one asking.
  changePassword: (input: ChangePasswordInput) =>
    post<{ ok: boolean; signedOutOthers: number }>("/auth/change-password", input),
  // Signed-in sessions ("where you're logged in").
  sessions: () => get<SessionInfo[]>("/auth/sessions"),
  revokeSession: (id: string) => del<{ ok: boolean }>(`/auth/sessions/${id}`),
  revokeOtherSessions: () => post<{ revoked: number }>("/auth/sessions/revoke-others", {}),
  // Push devices (native). Registering is idempotent — the app calls it after
  // sign-in and on every start, because push tokens rotate.
  registerDevice: (input: RegisterDeviceInput) => post<DeviceInfo>("/devices", input),
  devices: () => get<DeviceInfo[]>("/devices"),
  deleteDevice: (id: string) => del<{ ok: boolean }>(`/devices/${id}`),
  pushPreferences: () => get<PushPreferences>("/devices/preferences"),
  updatePushPreferences: (input: UpdatePushPreferencesInput) =>
    patch<PushPreferences>("/devices/preferences", input),
  testPush: () => post<{ devices: number; sent: number; failed: number }>("/devices/test", {}),
  setConversationMuted: (conversationId: string, muted: boolean) =>
    patch<PushPreferences>(`/devices/mute/${conversationId}`, { muted }),
  // Bell notifications.
  notifications: () => get<Notification[]>("/notifications"),
  markNotificationsRead: (ids?: string[]) => post<{ ok: boolean }>("/notifications/read", ids ? { ids } : {}),
  // Insights dashboard (admin/manager). Filters ride as query params.
  analytics: (params: { range: AnalyticsRange; channel: string; teamId: string; agentUserId: string }) =>
    get<AnalyticsResult>(
      `/analytics?range=${params.range}&channel=${encodeURIComponent(params.channel)}` +
        `&teamId=${encodeURIComponent(params.teamId)}&agentUserId=${encodeURIComponent(params.agentUserId)}`,
    ),
  views: () => get<SidebarViews>("/views"),
  inboxes: () => get<Inbox[]>("/inboxes"),
  createInbox: (input: CreateInboxInput) => post<Inbox>("/inboxes", input),
  updateInbox: (id: string, input: UpdateInboxInput) => patch<Inbox>(`/inboxes/${id}`, input),
  deleteInbox: (id: string) => del<{ ok: boolean }>(`/inboxes/${id}`),
  // Move a channel's still-open conversations onto its (new) routing.
  rerouteInbox: (id: string) => post<{ moved: number }>(`/inboxes/${id}/reroute`, {}),
  // NestChat: how one channel's widget looks, and the snippet that embeds it.
  nestchatSettings: (inboxId: string) => get<NestChatSettings>(`/settings/nestchat/${inboxId}`),
  // Mint this channel's app-signing secret and return it once. A POST because
  // it replaces any existing one — every old signature stops verifying.
  rotateNestchatSecret: (inboxId: string) =>
    post<{ secret: string }>(`/settings/nestchat/${inboxId}/identity-secret`, {}),
  // Save (or clear, with an empty string) the Firebase service account this
  // channel pushes through. Write-only — the settings only say whether one is set.
  setNestchatPushCredential: (inboxId: string, serviceAccount: string) =>
    post<NestChatSettings>(`/settings/nestchat/${inboxId}/push-credential`, { serviceAccount }),
  // Ring the last phone that registered on this channel and say what happened.
  // The only way to prove the saved key and the app share a Firebase project.
  testNestchatPush: (inboxId: string) =>
    post<NestChatPushTest>(`/settings/nestchat/${inboxId}/push-test`, {}),
  updateNestchat: (inboxId: string, input: UpdateNestchatInput) =>
    patch<NestChatSettings>(`/settings/nestchat/${inboxId}`, input),
  // settings
  teams: () => get<Team[]>("/settings/teams"),
  people: () => get<Member[]>("/settings/people"),
  createTeam: (input: CreateTeamInput) => post<Team>("/settings/teams", input),
  updateTeam: (id: string, input: UpdateTeamInput) => patch<Team>(`/settings/teams/${id}`, input),
  deleteTeam: (id: string) => del<{ ok: boolean }>(`/settings/teams/${id}`),
  reorderTeams: (orderedIds: string[]) => post<Team[]>("/settings/teams/reorder", { orderedIds }),
  // The order channels are listed in, everywhere they are listed.
  reorderInboxes: (orderedIds: string[]) =>
    post<Inbox[]>("/settings/inboxes/reorder", { orderedIds }),

  // Custom fields: the org's definitions, and the values on one record.
  customFields: () => get<CustomField[]>("/custom-fields"),
  createCustomField: (input: CreateCustomFieldInput) =>
    post<CustomField>("/custom-fields", input),
  updateCustomField: (id: string, input: UpdateCustomFieldInput) =>
    patch<CustomField>(`/custom-fields/${id}`, input),
  deleteCustomField: (id: string) => del<{ ok: boolean }>(`/custom-fields/${id}`),
  customFieldValues: (entity: CustomFieldEntity, entityId: string) =>
    get<CustomFieldValue[]>(`/custom-fields/${entity}/${entityId}`),
  // Null clears a field. `unknown` names any key the workspace hasn't defined,
  // so a caller can say so rather than believe a write happened.
  setCustomFieldValues: (
    entity: CustomFieldEntity,
    entityId: string,
    values: Record<string, string | null>,
  ) =>
    post<{ values: CustomFieldValue[]; unknown: string[] }>(
      `/custom-fields/${entity}/${entityId}`,
      { values },
    ),
  labels: () => get<Label[]>("/labels"),
  createLabel: (input: CreateLabelInput) => post<Label>("/labels", input),
  updateLabel: (id: string, input: UpdateLabelInput) => patch<Label>(`/labels/${id}`, input),
  deleteLabel: (id: string) => del<{ ok: boolean }>(`/labels/${id}`),
  setConversationLabels: (id: string, labelIds: string[]) =>
    post<Conversation>(`/conversations/${id}/labels`, { labelIds }),
  createUser: (input: CreateUserInput) => post<CreateUserResult>("/settings/people", input),
  updateUser: (id: string, input: UpdateUserInput) => patch<User>(`/settings/people/${id}`, input),
  deleteUser: (id: string) => del<{ ok: boolean }>(`/settings/people/${id}`),
  // integrations (Settings › Setup)
  getIntegrations: () => get<IntegrationSettings>("/settings/integrations"),
  updateIntegrations: (input: UpdateIntegrationSettingsInput) =>
    patch<IntegrationSettings>("/settings/integrations", input),
  // Send a test email to yourself to verify the SMTP/Postmark connection.
  testSmtp: () => post<{ sent: boolean; via?: string; error?: string }>("/settings/integrations/smtp/test", {}),
  // AI assist — polish a draft reply (Settings › Integrations › AI)
  polishDraft: (input: PolishDraftInput) => post<PolishDraftResult>("/ai/polish", input),
  // One real polish against a sample, so Settings can prove the key + model work.
  testAi: () => post<{ ok: boolean; model: string; sample?: string; error?: string }>("/ai/test", {}),
  // The models this workspace's Claude key can actually use (Settings picker).
  aiModels: () => get<{ models: { id: string; name: string }[]; error?: string }>("/ai/models"),
  // pull-to-refresh: fetch any new Gmail on demand
  syncGmail: () => post<{ ok: boolean; synced: number }>("/channels/google/sync", {}),
  // …and any new Outlook / Microsoft 365 mail
  syncOutlook: () => post<{ ok: boolean; synced: number }>("/channels/microsoft/sync", {}),
  // customers (CRM)
  contacts: () => get<Contact[]>("/contacts"),
  contactDuplicates: () => get<ContactDuplicateGroup[]>("/contacts/duplicates"),
  mergeContacts: (input: MergeContactsInput) => post<{ contact: Contact }>("/contacts/merge", input),
  contact: (id: string) => get<ContactWithConversations>(`/contacts/${id}`),
  createContact: (input: CreateContactInput) =>
    post<{ contact: Contact; existed: boolean }>("/contacts", input),
  /** Bulk import. Rows that match an existing customer are tagged, not duplicated. */
  importContacts: (input: ImportContactsInput) =>
    post<ImportContactsResult>("/contacts/import", input),
  updateContact: (id: string, input: UpdateContactInput) => patch<Contact>(`/contacts/${id}`, input),
  deleteContact: (id: string) => del<{ ok: boolean }>(`/contacts/${id}`),
  // Open (or start) this customer's conversation on another channel. An explicit
  // inboxId picks which number/inbox to send from when several are connected.
  reachContact: (contactId: string, channel: "whatsapp" | "email", inboxId?: string) =>
    post<{ conversationId: string; created: boolean }>(`/contacts/${contactId}/reach`, {
      channel,
      ...(inboxId ? { inboxId } : {}),
    }),
  // conversations (cursor-paginated — one page per call, never the whole inbox)
  // `field` narrows the view to threads carrying a custom field — any value, or
  // one in particular. ANDed with the view, so it only ever shows less.
  conversations: (
    view: string,
    cursor?: string,
    field?: { key: string; value?: string },
  ) =>
    get<ConversationPage>(
      `/conversations?view=${encodeURIComponent(view)}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "") +
        (field?.key ? `&fieldKey=${encodeURIComponent(field.key)}` : "") +
        (field?.key && field.value ? `&fieldValue=${encodeURIComponent(field.value)}` : ""),
    ),
  // How many conversations each filter chip holds, over the whole view — not
  // just the pages loaded so far.
  conversationCounts: (view: string, field?: { key: string; value?: string }) =>
    get<ConversationFilterCounts>(
      `/conversations/counts?view=${encodeURIComponent(view)}` +
        (field?.key ? `&fieldKey=${encodeURIComponent(field.key)}` : "") +
        (field?.key && field.value ? `&fieldValue=${encodeURIComponent(field.value)}` : ""),
    ),
  // Search across conversations (contact, subject, preview, message body).
  // `view` scopes it to one inbox; without it the search spans everything.
  searchConversations: (q: string, view?: string, cursor?: string) =>
    get<ConversationPage>(
      `/conversations/search?q=${encodeURIComponent(q)}` +
        (view ? `&view=${encodeURIComponent(view)}` : "") +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    ),
  conversation: (id: string) => get<ConversationWithMessages>(`/conversations/${id}`),
  // Older thread history (scroll-up), before a seq cursor.
  olderMessages: (id: string, before?: string) =>
    get<MessagePage>(`/conversations/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  // Stage a composer upload; the returned attachment id is referenced on send.
  //
  // Two paths, decided by what you hand it rather than by any test of the
  // runtime. A `File`/`Blob` is a browser's idea of a file and goes out as
  // `FormData` over `fetch`, which is exactly what a browser is good at. An
  // {@link UploadFile} is a path on a device's disk, and posting one is
  // something only that device's app knows how to do — see `uploadFile` in
  // `config.ts` for the two ways of faking it that shipped and broke.
  uploadMedia: (file: File | Blob | UploadFile, meta?: UploadMeta) => {
    if (isUploadFile(file)) {
      const upload = clientConfig().uploadFile;
      if (!upload) {
        // Reached only if an app hands us a disk path without having said how
        // to post one. Better a sentence naming the missing piece than a
        // multipart body the server can't read.
        throw new Error(
          "This app was given a local file to upload but has no `uploadFile` configured — see configureClient().",
        );
      }
      return upload(file, meta ?? {}) as Promise<Attachment>;
    }

    const form = new FormData();
    form.append("file", file, meta?.filename ?? (file instanceof File ? file.name : "file"));
    if (meta?.kind) form.append("kind", meta.kind);
    if (meta?.durationMs != null) form.append("durationMs", String(Math.round(meta.durationMs)));
    if (meta?.width != null) form.append("width", String(Math.round(meta.width)));
    if (meta?.height != null) form.append("height", String(Math.round(meta.height)));
    if (meta?.waveform) form.append("waveform", JSON.stringify(meta.waveform));
    return request<Attachment>("/media", { method: "POST", body: form });
  },
  sendMessage: (
    id: string,
    body: string,
    internal = false,
    attachmentIds?: string[],
    extras?: {
      template?: { id: string; params: string[] };
      quotedMsgId?: string;
      bodyHtml?: string;
      subject?: string;
      cc?: string[];
      bcc?: string[];
      channel?: ChannelType;
      forwardTo?: string[];
    },
  ) =>
    post<Message>(`/conversations/${id}/messages`, {
      body,
      internal,
      ...(attachmentIds?.length ? { attachmentIds } : {}),
      ...(extras?.template ? { template: extras.template } : {}),
      ...(extras?.quotedMsgId ? { quotedMsgId: extras.quotedMsgId } : {}),
      ...(extras?.bodyHtml ? { bodyHtml: extras.bodyHtml } : {}),
      ...(extras?.subject !== undefined ? { subject: extras.subject } : {}),
      ...(extras?.cc?.length ? { cc: extras.cc } : {}),
      ...(extras?.bcc?.length ? { bcc: extras.bcc } : {}),
      ...(extras?.channel ? { channel: extras.channel } : {}),
      ...(extras?.forwardTo?.length ? { forwardTo: extras.forwardTo } : {}),
    }),
  // React to a message with an emoji (empty string removes the agent's reaction).
  react: (conversationId: string, messageId: string, emoji: string) =>
    post<Message>(`/conversations/${conversationId}/messages/${messageId}/react`, { emoji }),
  // Pass a message on to other customers' WhatsApp chats. Resolves to one result
  // per target — some can land while others bounce off a closed 24-hour window.
  forwardMessage: (conversationId: string, messageId: string, contactIds: string[]) =>
    post<ForwardResult[]>(`/conversations/${conversationId}/messages/${messageId}/forward`, {
      contactIds,
    }),
  // Re-queue a failed outbound message for another delivery attempt.
  retryMessage: (conversationId: string, messageId: string) =>
    post<Message>(`/conversations/${conversationId}/messages/${messageId}/retry`, {}),
  // WhatsApp message templates (for replying once a 24-hour window has closed)
  templates: () => get<Template[]>("/templates"),
  createTemplate: (input: CreateTemplateInput) => post<Template>("/templates", input),
  updateTemplate: (id: string, input: UpdateTemplateInput) => patch<Template>(`/templates/${id}`, input),
  deleteTemplate: (id: string) => del<{ ok: boolean }>(`/templates/${id}`),
  // Star a template as its WhatsApp account's default, or unstar it. The id
  // goes both ways so the server knows whose default it is clearing.
  setDefaultTemplate: (templateId: string, isDefault: boolean) =>
    post<Template[]>("/templates/default", { templateId, isDefault }),
  syncTemplates: () => post<{ synced: number; pruned: number }>("/templates/sync", {}),
  // WhatsApp business profile — the public "about" card on a number
  whatsappProfile: (inboxId: string) =>
    get<WhatsAppBusinessProfile>(`/whatsapp/business-profile/${inboxId}`),
  updateWhatsappProfile: (inboxId: string, input: UpdateWhatsAppBusinessProfileInput) =>
    patch<WhatsAppBusinessProfile>(`/whatsapp/business-profile/${inboxId}`, input),
  setWhatsappProfilePhoto: (inboxId: string, file: File | Blob) => {
    const form = new FormData();
    form.append("file", file, file instanceof File ? file.name : "profile.jpg");
    return request<WhatsAppBusinessProfile>(`/whatsapp/business-profile/${inboxId}/photo`, { method: "POST", body: form });
  },
  // WhatsApp Cloud API registration — what Meta says about a number, and the
  // one call that moves it from "Pending" to usable.
  //
  // The PIN is the only thing sent: the Phone number ID and access token are
  // read from the channel's own stored config on the server, which is the only
  // place the token has ever been.
  whatsappNumberStatus: (channelId: string) =>
    get<WhatsAppNumberState>(`/channels/${channelId}/whatsapp/status`),
  registerWhatsappNumber: (channelId: string, pin: string) =>
    post<WhatsAppRegisterResult>(`/channels/${channelId}/whatsapp/register`, { pin }),
  // WhatsApp broadcast — send an approved template to many recipients at once
  sendBroadcast: (input: SendBroadcastInput) => post<BroadcastResult>("/whatsapp/broadcast", input),
  assign: (
    id: string,
    input: { assigneeUserId?: string | null; assignedTeamId?: string | null },
  ) => post<Conversation>(`/conversations/${id}/assign`, input),
  setStatus: (id: string, status: ConversationStatus) =>
    post<Conversation>(`/conversations/${id}/status`, { status }),
  setPriority: (id: string, priority: Priority) =>
    post<Conversation>(`/conversations/${id}/priority`, { priority }),
  snooze: (id: string, until: string) =>
    post<Conversation>(`/conversations/${id}/snooze`, { until }),
  // Mark a conversation read: clears its unread badge + sends a WhatsApp read receipt.
  markRead: (id: string) => post<Conversation>(`/conversations/${id}/read`, {}),
  markUnread: (id: string) => post<Conversation>(`/conversations/${id}/unread`, {}),
  // Agent is typing → show the customer a WhatsApp "typing…" indicator.
  sendTyping: (id: string) => post<{ ok: boolean }>(`/conversations/${id}/typing`, {}),
  // groups (invite-only: members join via the link; no add-by-phone endpoint)
  createGroup: (input: CreateGroupInput) => post<ConversationWithMessages>("/groups", input),
  resetGroupInvite: (conversationId: string) =>
    post<{ inviteLink: string }>(`/groups/${conversationId}/invite/reset`, {}),
  removeParticipant: (conversationId: string, contactId: string) =>
    request<{ ok: boolean }>(`/groups/${conversationId}/participants/${contactId}`, { method: "DELETE" }),
};
