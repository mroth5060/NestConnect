import type {
  ConversationFilterCounts,
  Attachment,
  ChannelType,
  Contact,
  ContactDuplicateGroup,
  MergeContactsInput,
  BulkContactsInput,
  BulkContactsResult,
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
  ConversationEvent,
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
  UpdateInboxSignatureInput,
  NestChatPushTest,
  NestChatSettings,
  UpdateIntegrationSettingsInput,
  UpdateNestchatInput,
  PolishDraftInput,
  PolishDraftResult,
  MediaTranscript,
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
  WhatsAppObaStatus,
  CoexistenceSetup,
  ConnectCoexistenceInput,
  RequestWhatsAppObaInput,
  UpdateWhatsAppBusinessProfileInput,
  WhatsAppNumberState,
  WhatsAppRegisterResult,
  SendBroadcastInput,
  BroadcastResult,
  EmailCutoverJob,
  Account,
  AccountActivity,
  AccountAlert,
  AccountContact,
  AccountDetail,
  AccountListItem,
  AccountNote,
  AccountResource,
  AccountSop,
  AccountSopRevision,
  AccountStatus,
  AlertInput,
  ContactAccount,
  ConversationAccountContext,
  CreateAccountInput,
  CreateMacroInput,
  Macro,
  UpdateMacroInput,
  OpsAckReport,
  ChatMemberRole,
  ChatMessage,
  ChatMessageInfo,
  ChatMessagePage,
  ChatRoom,
  ChatRoomPrefsInput,
  ChatRoomSummary,
  ChatDiscussion,
  ChatDiscussionThread,
  ChatSearchHit,
  ChatStarred,
  ChatStatusInfo,
  CreateChatGroupInput,
  SendChatMessageInput,
  ShareConversationInput,
  UpdateChatGroupInput,
  OpsCollection,
  OpsCollectionInput,
  OpsLibrary,
  OpsRevision,
  OpsSop,
  OpsSopInput,
  OpsStatusInfo,
  UpdateOpsCollectionInput,
  UpdateOpsSopInput,
  LinkContactInput,
  LinkContactsInput,
  NoteInput,
  ResourceInput,
  SopInput,
  UpdateAccountInput,
  AccountRoutingInput,
  UpdateContactLinkInput,
  UpdateResourceInput,
  UpdateSopInput,
  EmailCutoverPreview,
  AnalyticsResult,
  AnalyticsRange,
  DeviceInfo,
  PushPreferences,
  RegisterDeviceInput,
  SessionGrant,
  MyWorkspaces,
  PlatformWorkspace,
  CreateWorkspaceInput,
  CreatedWorkspace,
  PlatformPerson,
  SmsChannelSettings,
  SaveSmsConfigInput,
  SmsTestResult,
  TestSmsInput,
  SuggestedSmsConfig,
  SuggestSmsConfigInput,
  Role,
  PlatformPersonInvite,
  AddPlatformPersonInput,
  WorkspaceStatus,
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
  /** The address already signs in (to another workspace): they were added
   *  with the password they have, and told by email — no invite. */
  addedExisting?: boolean;
}

export interface ApiError extends Error {
  status: number;
  /** The error body the server sent, when it was JSON (e.g. a 409 naming the
   *  record that already exists). */
  body?: unknown;
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
    let errBody: unknown;
    try {
      const body = (await res.clone().json()) as { message?: string | string[] };
      errBody = body;
      if (typeof body?.message === "string") serverMsg = body.message;
      else if (Array.isArray(body?.message)) serverMsg = body.message.join(", ");
    } catch {
      /* no JSON body — fall back to the status line */
    }
    const err = new Error(serverMsg ?? `${init?.method ?? "GET"} ${path} failed: ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = errBody;
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
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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
  // The workspaces you're in, and moving between them. Switching ends this
  // session and opens one in the other workspace: a browser gets a new cookie,
  // a phone a new token in the body (which it has to store).
  myWorkspaces: () => get<MyWorkspaces>("/auth/workspaces"),
  switchWorkspace: (orgId: string) =>
    post<MeResponse & Partial<SessionGrant>>("/auth/switch", { orgId, ...tokenAuth() }),
  // Platform owners: every workspace, and making a new one with its first admin.
  platformWorkspaces: () => get<PlatformWorkspace[]>("/platform/workspaces"),
  createWorkspace: (input: CreateWorkspaceInput) => post<CreatedWorkspace>("/platform/workspaces", input),
  // …and each one, managed from outside it.
  renameWorkspace: (id: string, name: string) => patch<PlatformWorkspace>(`/platform/workspaces/${id}`, { name }),
  // active | suspended | archived | deleting (wiped in 30 days; "active" restores).
  setWorkspaceStatus: (id: string, status: WorkspaceStatus) =>
    post<PlatformWorkspace>(`/platform/workspaces/${id}/status`, { status }),
  deleteWorkspaceNow: (id: string, confirmName: string) =>
    post<{ ok: boolean; files: number }>(`/platform/workspaces/${id}/delete-now`, { confirmName }),
  workspacePeople: (id: string) => get<PlatformPerson[]>(`/platform/workspaces/${id}/people`),
  addWorkspacePerson: (id: string, input: AddPlatformPersonInput) =>
    post<PlatformPersonInvite>(`/platform/workspaces/${id}/people`, input),
  setWorkspacePersonRole: (id: string, personId: string, role: Role) =>
    patch<PlatformPerson>(`/platform/workspaces/${id}/people/${personId}`, { role }),
  removeWorkspacePerson: (id: string, personId: string) =>
    del<{ ok: boolean }>(`/platform/workspaces/${id}/people/${personId}`),
  resendWorkspaceInvite: (id: string, personId: string) =>
    post<PlatformPersonInvite>(`/platform/workspaces/${id}/people/${personId}/invite`, {}),
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
  /** The number for the app icon: unread My Inbound conversations plus unread team chats. */
  appBadge: () => get<{ count: number }>("/devices/badge"),
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
  // An email channel's signature design (layout + marketing section).
  setInboxSignature: (id: string, input: UpdateInboxSignatureInput) => put<Inbox>(`/inboxes/${id}/signature`, input),
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
  // SMS channels: the provider config (any REST API), testing it, and AI
  // filling it in from pasted docs.
  smsSettings: (inboxId: string) => get<SmsChannelSettings>(`/channels/sms/${inboxId}/settings`),
  saveSmsSettings: (inboxId: string, input: SaveSmsConfigInput) => put<SmsChannelSettings>(`/channels/sms/${inboxId}/settings`, input),
  testSms: (input: TestSmsInput & { inboxId?: string }) => post<SmsTestResult>("/channels/sms/test", input),
  pollSms: (inboxId: string) => post<{ imported: number; receipts: number }>(`/channels/sms/${inboxId}/poll`, {}),
  suggestSmsConfig: (input: SuggestSmsConfigInput) => post<SuggestedSmsConfig>("/channels/sms/suggest", input),
  // integrations (Settings › Setup)
  getIntegrations: () => get<IntegrationSettings>("/settings/integrations"),
  updateIntegrations: (input: UpdateIntegrationSettingsInput) =>
    patch<IntegrationSettings>("/settings/integrations", input),
  // Send a test email to yourself to verify the SMTP/Postmark connection.
  testSmtp: () => post<{ sent: boolean; via?: string; error?: string }>("/settings/integrations/smtp/test", {}),
  // Transcribe: a voice note in words (made once, then remembered).
  transcribeMedia: (id: string) => post<MediaTranscript>(`/media/${encodeURIComponent(id)}/transcript`, {}),
  // AI assist — polish a draft reply (Settings › Integrations › AI)
  polishDraft: (input: PolishDraftInput) => post<PolishDraftResult>("/ai/polish", input),
  // One real polish against a sample, so Settings can prove the key + model work.
  testAi: () => post<{ ok: boolean; model: string; sample?: string; error?: string }>("/ai/test", {}),
  // The models this workspace's Claude key can actually use (Settings picker).
  aiModels: () => get<{ models: { id: string; name: string }[]; error?: string }>("/ai/models"),
  // pull-to-refresh: fetch any new Gmail on demand
  syncGmail: () => post<{ ok: boolean; synced: number }>("/channels/google/sync", {}),
  /** Bring in the email a connected Gmail channel had since a moment (in the background). */
  pullMissedEmail: (inboxId: string, since: string) =>
    post<{ ok: true; since: string }>(`/channels/google/inboxes/${encodeURIComponent(inboxId)}/missed`, { since }),
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
  bulkContacts: (input: BulkContactsInput) => post<BulkContactsResult>("/contacts/bulk", input),
  // Open (or start) this customer's conversation on another channel. An explicit
  // inboxId picks which number/inbox to send from when several are connected.
  reachContact: (contactId: string, channel: "whatsapp" | "email" | "sms", inboxId?: string) =>
    // `alsoOpenWith`: who has the other open conversation with them that this
    // new one was started beside — a colleague's name, or "the queue".
    post<{ conversationId: string; created: boolean; alsoOpenWith?: string }>(`/contacts/${contactId}/reach`, {
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
  /** The conversation's log — routing, assignment, status and changes, newest first. */
  conversationEvents: (id: string) => get<ConversationEvent[]>(`/conversations/${encodeURIComponent(id)}/events`),
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
      forwardOfId?: string;
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
      ...(extras?.forwardTo?.length && extras.forwardOfId ? { forwardOfId: extras.forwardOfId } : {}),
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
  /** Send a template that's linked to no account to Meta, on this account. */
  submitTemplate: (id: string, wabaId: string) => post<Template>(`/templates/${id}/submit`, { wabaId }),
  // WhatsApp business profile — the public "about" card on a number
  whatsappProfile: (inboxId: string) =>
    get<WhatsAppBusinessProfile>(`/whatsapp/business-profile/${inboxId}`),
  /** What the browser needs to open Meta's sign-up for a WhatsApp Business app number. */
  coexistenceSetup: () => get<CoexistenceSetup>("/channels/meta/coexistence/setup"),
  /** Finish connecting a WhatsApp Business app number (coexistence). */
  connectCoexistence: (input: ConnectCoexistenceInput) =>
    post<{ inboxId: string; handle: string; displayNumber: string; sync: string; coexistence: boolean }>("/channels/meta/coexistence", input),
  whatsappOba: (inboxId: string) => get<WhatsAppObaStatus>(`/whatsapp/business-profile/${inboxId}/oba`),
  requestWhatsappOba: (inboxId: string, input: RequestWhatsAppObaInput) =>
    post<WhatsAppObaStatus>(`/whatsapp/business-profile/${inboxId}/oba`, input),
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
  // Settings → Move from Gmail (admins): preview, run (deletes email
  // conversations, imports unread Gmail threads), and progress.
  emailCutoverPreview: () => get<EmailCutoverPreview & { job: EmailCutoverJob }>("/settings/email-cutover"),
  emailCutoverStatus: () => get<EmailCutoverJob>("/settings/email-cutover/status"),
  runEmailCutover: (confirm: string) => post<EmailCutoverJob>("/settings/email-cutover", { confirm }),

  // Macros: saved replies for the composer, by team inbox.
  macros: () => get<Macro[]>("/macros"),
  conversationMacros: (conversationId: string) => get<Macro[]>(`/macros/conversation/${encodeURIComponent(conversationId)}`),
  createMacro: (input: CreateMacroInput) => post<Macro>("/macros", input),
  updateMacro: (id: string, input: UpdateMacroInput) => patch<Macro>(`/macros/${encodeURIComponent(id)}`, input),
  deleteMacro: (id: string) => del<{ ok: true }>(`/macros/${encodeURIComponent(id)}`),

  // Team Chat: direct messages, groups and team chats.
  chatStatus: () => get<ChatStatusInfo>("/chat/status"),
  setChatModule: (enabled: boolean) => put<ChatStatusInfo>("/chat/module", { enabled }),
  chatRooms: (all = false) => get<ChatRoomSummary[]>(`/chat/rooms${all ? "?all=1" : ""}`),
  chatRoom: (id: string) => get<ChatRoom>(`/chat/rooms/${encodeURIComponent(id)}`),
  chatMessages: (id: string, before?: string) =>
    get<ChatMessagePage>(`/chat/rooms/${encodeURIComponent(id)}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  sendChatMessage: (id: string, input: SendChatMessageInput) => post<ChatMessage>(`/chat/rooms/${encodeURIComponent(id)}/messages`, input),
  editChatMessage: (id: string, body: string) => patch<ChatMessage>(`/chat/messages/${encodeURIComponent(id)}`, { body }),
  deleteChatMessage: (id: string) => del<ChatMessage>(`/chat/messages/${encodeURIComponent(id)}`),
  reactChatMessage: (id: string, emoji: string) => post<ChatMessage>(`/chat/messages/${encodeURIComponent(id)}/react`, { emoji }),
  starChatMessage: (id: string, starred: boolean) => put<{ ok: true }>(`/chat/messages/${encodeURIComponent(id)}/star`, { starred }),
  chatStarred: () => get<ChatStarred[]>("/chat/starred"),
  shareConversation: (input: ShareConversationInput) => post<ChatMessage>("/chat/share", input),
  chatDiscussions: (conversationId: string) => get<ChatDiscussion[]>(`/chat/discussions?conversationId=${encodeURIComponent(conversationId)}`),
  chatThread: (cardId: string) => get<ChatDiscussionThread>(`/chat/messages/${encodeURIComponent(cardId)}/thread`),
  searchChat: (q: string) => get<ChatSearchHit[]>(`/chat/search?q=${encodeURIComponent(q)}`),
  chatMessageInfo: (id: string) => get<ChatMessageInfo>(`/chat/messages/${encodeURIComponent(id)}/info`),
  readChatRoom: (id: string) => post<{ ok: true }>(`/chat/rooms/${encodeURIComponent(id)}/read`, {}),
  deliveredChatRoom: (id: string) => post<{ ok: true }>(`/chat/rooms/${encodeURIComponent(id)}/delivered`, {}),
  setChatRoomPrefs: (id: string, input: ChatRoomPrefsInput) => put<ChatRoomSummary>(`/chat/rooms/${encodeURIComponent(id)}/prefs`, input),
  openDirectChat: (userId: string) => post<ChatRoom>("/chat/direct", { userId }),
  createChatGroup: (input: CreateChatGroupInput) => post<ChatRoom>("/chat/groups", input),
  updateChatGroup: (id: string, input: UpdateChatGroupInput) => patch<ChatRoom>(`/chat/rooms/${encodeURIComponent(id)}`, input),
  addChatMembers: (id: string, userIds: string[]) => post<ChatRoom>(`/chat/rooms/${encodeURIComponent(id)}/members`, { userIds }),
  removeChatMember: (id: string, userId: string) =>
    del<ChatRoom>(`/chat/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`),
  setChatMemberRole: (id: string, userId: string, role: ChatMemberRole) =>
    put<ChatRoom>(`/chat/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/role`, { role }),
  leaveChatRoom: (id: string) => post<{ ok: true }>(`/chat/rooms/${encodeURIComponent(id)}/leave`, {}),

  // Business Ops: the workspace's own SOPs, by team.
  opsStatus: () => get<OpsStatusInfo>("/ops/status"),
  setOpsModule: (enabled: boolean) => put<OpsStatusInfo>("/ops/module", { enabled }),
  opsLibrary: (q?: string) => get<OpsLibrary>(`/ops/library${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  opsSop: (id: string) => get<OpsSop>(`/ops/sops/${encodeURIComponent(id)}`),
  createOpsSop: (input: OpsSopInput) => post<OpsSop>("/ops/sops", input),
  updateOpsSop: (id: string, input: UpdateOpsSopInput) => patch<OpsSop>(`/ops/sops/${encodeURIComponent(id)}`, input),
  deleteOpsSop: (id: string) => del<{ ok: true }>(`/ops/sops/${encodeURIComponent(id)}`),
  publishOpsSop: (id: string, note = "") => post<OpsSop>(`/ops/sops/${encodeURIComponent(id)}/publish`, { note }),
  archiveOpsSop: (id: string) => post<OpsSop>(`/ops/sops/${encodeURIComponent(id)}/archive`, {}),
  restoreOpsSop: (id: string) => post<OpsSop>(`/ops/sops/${encodeURIComponent(id)}/restore`, {}),
  reviewedOpsSop: (id: string) => post<OpsSop>(`/ops/sops/${encodeURIComponent(id)}/reviewed`, {}),
  opsVersions: (id: string) => get<OpsRevision[]>(`/ops/sops/${encodeURIComponent(id)}/versions`),
  ackOpsSop: (id: string) => post<OpsSop>(`/ops/sops/${encodeURIComponent(id)}/ack`, {}),
  opsAcks: (id: string) => get<OpsAckReport>(`/ops/sops/${encodeURIComponent(id)}/acks`),
  setOpsChecklist: (id: string, done: number[]) => put<{ done: number[] }>(`/ops/sops/${encodeURIComponent(id)}/checklist`, { done }),
  resetOpsChecklist: (id: string) => del<{ done: number[] }>(`/ops/sops/${encodeURIComponent(id)}/checklist`),
  createOpsCollection: (input: OpsCollectionInput) => post<OpsCollection>("/ops/collections", input),
  updateOpsCollection: (id: string, input: UpdateOpsCollectionInput) =>
    patch<OpsCollection>(`/ops/collections/${encodeURIComponent(id)}`, input),
  deleteOpsCollection: (id: string) => del<{ ok: true }>(`/ops/collections/${encodeURIComponent(id)}`),

  // Organisations (customer accounts) and their knowledge.
  accounts: (q?: { search?: string; status?: AccountStatus; archived?: boolean }) => {
    const p = new URLSearchParams();
    if (q?.search) p.set("q", q.search);
    if (q?.status) p.set("status", q.status);
    if (q?.archived) p.set("archived", "1");
    const qs = p.toString();
    return get<AccountListItem[]>(`/accounts${qs ? `?${qs}` : ""}`);
  },
  account: (id: string) => get<AccountDetail>(`/accounts/${encodeURIComponent(id)}`),
  createAccount: (input: CreateAccountInput) => post<Account>("/accounts", input),
  updateAccount: (id: string, input: UpdateAccountInput) => patch<Account>(`/accounts/${encodeURIComponent(id)}`, input),
  archiveAccount: (id: string, archived: boolean) =>
    post<Account>(`/accounts/${encodeURIComponent(id)}/${archived ? "archive" : "restore"}`, {}),
  deleteAccount: (id: string) => del<{ ok: true }>(`/accounts/${encodeURIComponent(id)}`),
  /** Where its people's new chats go. Admins and managers. */
  setAccountRouting: (id: string, input: AccountRoutingInput) =>
    put<AccountDetail>(`/accounts/${encodeURIComponent(id)}/routing`, input),
  accountActivity: (id: string) => get<AccountActivity[]>(`/accounts/${encodeURIComponent(id)}/activity`),
  contactAccounts: (contactId: string) => get<ContactAccount[]>(`/accounts/by-contact/${encodeURIComponent(contactId)}`),
  conversationAccount: (conversationId: string) =>
    get<ConversationAccountContext>(`/accounts/conversation/${encodeURIComponent(conversationId)}`),
  setConversationAccount: (conversationId: string, accountId: string | null) =>
    request<ConversationAccountContext>(`/accounts/conversation/${encodeURIComponent(conversationId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId }),
    }),
  linkAccountContact: (id: string, input: LinkContactInput) => post<AccountContact>(`/accounts/${encodeURIComponent(id)}/contacts`, input),
  linkAccountContacts: (id: string, input: LinkContactsInput) =>
    post<AccountContact[]>(`/accounts/${encodeURIComponent(id)}/contacts/many`, input),
  updateAccountContact: (id: string, contactId: string, input: UpdateContactLinkInput) =>
    patch<AccountContact>(`/accounts/${encodeURIComponent(id)}/contacts/${encodeURIComponent(contactId)}`, input),
  unlinkAccountContact: (id: string, contactId: string) =>
    del<{ ok: true }>(`/accounts/${encodeURIComponent(id)}/contacts/${encodeURIComponent(contactId)}`),
  createAccountAlert: (id: string, input: AlertInput) => post<AccountAlert>(`/accounts/${encodeURIComponent(id)}/alerts`, input),
  updateAccountAlert: (id: string, alertId: string, input: Partial<AlertInput>) =>
    patch<AccountAlert>(`/accounts/${encodeURIComponent(id)}/alerts/${encodeURIComponent(alertId)}`, input),
  deleteAccountAlert: (id: string, alertId: string) =>
    del<{ ok: true }>(`/accounts/${encodeURIComponent(id)}/alerts/${encodeURIComponent(alertId)}`),
  createAccountSop: (id: string, input: SopInput) => post<AccountSop>(`/accounts/${encodeURIComponent(id)}/sops`, input),
  updateAccountSop: (id: string, sopId: string, input: UpdateSopInput) =>
    patch<AccountSop>(`/accounts/${encodeURIComponent(id)}/sops/${encodeURIComponent(sopId)}`, input),
  accountSopRevisions: (id: string, sopId: string) =>
    get<AccountSopRevision[]>(`/accounts/${encodeURIComponent(id)}/sops/${encodeURIComponent(sopId)}/revisions`),
  createAccountNote: (id: string, input: NoteInput) => post<AccountNote>(`/accounts/${encodeURIComponent(id)}/notes`, input),
  updateAccountNote: (id: string, noteId: string, input: Partial<NoteInput>) =>
    patch<AccountNote>(`/accounts/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`, input),
  deleteAccountNote: (id: string, noteId: string) =>
    del<{ ok: true }>(`/accounts/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`),
  createAccountResource: (id: string, input: ResourceInput) =>
    post<AccountResource>(`/accounts/${encodeURIComponent(id)}/resources`, input),
  updateAccountResource: (id: string, resourceId: string, input: UpdateResourceInput) =>
    patch<AccountResource>(`/accounts/${encodeURIComponent(id)}/resources/${encodeURIComponent(resourceId)}`, input),
  deleteAccountResource: (id: string, resourceId: string) =>
    del<{ ok: true }>(`/accounts/${encodeURIComponent(id)}/resources/${encodeURIComponent(resourceId)}`),
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
