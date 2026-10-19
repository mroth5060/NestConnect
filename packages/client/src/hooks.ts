import { useCallback, useEffect, useRef, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  ClientEvent,
  ServerEvent,
  type Conversation,
  type ConversationStatus,
  type AccountStatus,
  type ConversationWithMessages,
  type Label,
  type Priority,
  type CreateContactInput,
  type ImportContactsInput,
  type MergeContactsInput,
  type CreateGroupInput,
  type CreateInboxInput,
  type CreateCustomFieldInput,
  type CustomFieldEntity,
  type CreateLabelInput,
  type UpdateCustomFieldInput,
  type CreateTeamInput,
  type CreateTemplateInput,
  type CreateUserInput,
  type UpdateLabelInput,
  type ChannelType,
  type Message,
  type Notification,
  type UpdateContactInput,
  type UpdateInboxInput,
  type UpdateInboxSignatureInput,
  type UpdateIntegrationSettingsInput,
  type CreateWorkspaceInput,
  type AddPlatformPersonInput,
  type SaveSmsConfigInput,
  type WorkspaceStatus,
  type Role,
  type UpdateNestchatInput,
  type UpdateMyPreferencesInput,
  type UpdatePushPreferencesInput,
  type UpdateMyProfileInput,
  type ChangePasswordInput,
  type UpdateTeamInput,
  type UpdateTemplateInput,
  type UpdateUserInput,
  type UpdateWhatsAppBusinessProfileInput,
  type RequestWhatsAppObaInput,
  type SendBroadcastInput,
  type AnalyticsRange,
  templatesForWaba,
} from "@ding/schemas";
import { api, type MeResponse } from "./api";
import { clientConfig } from "./config";
import { getSocket, resetSocket } from "./socket";

/** Sound cues, if this app has any. The web plays them; native leaves the sound
 *  to the OS notification, so both are optional and default to nothing. */
const playReceived = () => clientConfig().cues.received?.();
const playSent = (channel?: string) => clientConfig().cues.sent?.(channel);

/** Statuses that mean an outbound message actually left our system — the point
 *  at which the "sent" cue should play (never on queued/sending/failed). */
const SENT_CUE_STATUSES = new Set<Message["status"]>(["sent", "delivered", "read"]);
/** Message ids we've already sounded, so the sent cue fires once per message
 *  (a message climbs sent → delivered → read, all as separate updates). */
const sentCuePlayed = new Set<string>();

export const useSession = () =>
  useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: 30_000 });

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) => api.login(v.email, v.password),
    onSuccess: (data) => {
      // A 2FA challenge isn't a session yet — the LoginScreen shows the code step.
      if ("twoFactorRequired" in data) return;
      seedIdentity(qc, data);
      qc.invalidateQueries();
    },
  });
}

/**
 * Hand a fresh login response to every cache that answers "who am I".
 *
 * There are two — `["session"]` from `/auth/session` and `["me"]` from `/me` —
 * and they return the identical payload, so the answer we are already holding
 * is the right answer for both. Seeding both means the screens that mount
 * straight after sign-in (Settings, and the tab bar deciding whether this person
 * may see Insights) have their answer on the first frame instead of after a
 * round trip, and it saves a request.
 *
 * It also makes the pair robust in a way an invalidate is not. If `["me"]` has
 * already been fetched and failed — signed out, or a flaky first request — it
 * parks in an error state, and `invalidateQueries` only marks such a query
 * stale: a stale errored query with no observer mounted does not refetch, so a
 * screen mounting later can read `undefined` and keep reading it. Writing the
 * value in clears the error outright.
 *
 * Exported because the two apps sign in differently: the web goes through
 * `useLogin` below, while the phone has to get its token into the Keychain
 * before any query runs and so calls `api.login` directly. Both end up here, so
 * *which* caches hold the identity is stated once.
 */
export function seedIdentity(qc: QueryClient, data: MeResponse) {
  qc.setQueryData(["session"], data);
  qc.setQueryData(["me"], data);
}

export function useLoginTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: string | { code: string; pendingToken?: string; rememberDevice?: boolean }) =>
      typeof v === "string"
        ? api.loginTwoFactor(v)
        : api.loginTwoFactor(v.code, v.pendingToken, v.rememberDevice),
    onSuccess: (data) => {
      seedIdentity(qc, data);
      qc.invalidateQueries();
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(["session"], null);
      // The socket authenticated with the session we just ended — drop it so the
      // next sign-in handshakes fresh instead of reusing a dead connection.
      resetSocket();
      // What "back to sign-in" means differs per app: the web hard-navigates
      // (clear() re-triggers the active ["session"] query, which can race and
      // bounce you back into the app; a reload guarantees a clean
      // unauthenticated start), while native resets its router and drops the
      // stored token.
      clientConfig().onSignedOut?.();
    },
  });
}

export function useCreateInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInboxInput) => api.createInbox(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["inboxes"] });
    },
  });
}

export function useUpdateInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: UpdateInboxInput }) => api.updateInbox(v.id, v.input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inboxes"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

/** Save an email channel's signature; every composer's "signed as" follows. */
export function useSetInboxSignature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: UpdateInboxSignatureInput }) => api.setInboxSignature(v.id, v.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inboxes"] }),
  });
}

export function useDeleteInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteInbox(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inboxes"] });
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useRerouteInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rerouteInbox(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGroupInput) => api.createGroup(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useRemoveParticipant(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) => api.removeParticipant(conversationId, contactId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversation", conversationId] }),
  });
}

/** Revoke a group's invite link and get a fresh one (people re-join via the new link). */
export function useResetGroupInvite(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.resetGroupInvite(conversationId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversation", conversationId] }),
  });
}

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: api.me });

/** The insights dashboard feed (admin/manager). Keeps the previous data on
 *  screen while a new range/filter loads, so the charts don't flash empty. */
export function useAnalytics(params: { range: AnalyticsRange; channel: string; teamId: string; agentUserId: string }) {
  return useQuery({
    queryKey: ["analytics", params.range, params.channel, params.teamId, params.agentUserId],
    queryFn: () => api.analytics(params),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Update the current user's own personal settings (availability + signature). */
export function useUpdateMyPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMyPreferencesInput) => api.updateMyPreferences(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["people"] });
    },
  });
}

/** What this person wants to be pushed about. Only the native app surfaces
 *  these, but they live here because they're the account's, not the device's. */
export const usePushPreferences = () =>
  useQuery({ queryKey: ["push-prefs"], queryFn: api.pushPreferences });

/** Silence, or un-silence, one thread for this person. The server returns the
 *  merged preferences, so the cache is seeded rather than refetched. */
export function useSetConversationMuted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { conversationId: string; muted: boolean }) =>
      api.setConversationMuted(v.conversationId, v.muted),
    onSuccess: (next) => qc.setQueryData(["push-prefs"], next),
  });
}

export function useUpdatePushPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePushPreferencesInput) => api.updatePushPreferences(input),
    // The server returns the merged result, so seed the cache with it rather
    // than refetching — a toggle that visibly waits feels broken.
    onSuccess: (next) => qc.setQueryData(["push-prefs"], next),
  });
}

/**
 * Send a real push to your own devices and report what happened.
 *
 * The only question worth asking while setting notifications up is "did it
 * arrive?", and no amount of reading configuration answers it. The server side
 * of this deliberately bypasses preferences and quiet hours, so a silent result
 * means something is actually broken rather than merely switched off.
 *
 * The three numbers separate the three failures that otherwise look identical
 * from the outside: `devices` at zero is a registration that never happened,
 * `failed` is the push service rejecting the token or the credentials, and
 * `sent` with nothing arriving is the phone or the OS.
 */
export const useTestPush = () => useMutation({ mutationFn: () => api.testPush() });

/** Update the current user's own profile (name, login email, photo). */
export function useUpdateMyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMyProfileInput) => api.updateMyProfile(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["people"] });
    },
  });
}

/** Change the current user's own password (current is re-verified server-side).
 *
 *  Doing so signs out every other device, so the "where you're signed in" list
 *  is stale the moment this returns — and it sits on the same settings screen
 *  as the password fields, in plain view. */
export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePasswordInput) => api.changePassword(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

/* ---- two-factor auth ---- */
export const useTwoFactorStatus = () => useQuery({ queryKey: ["2fa-status"], queryFn: api.twoFactorStatus });

/* ---- signed-in sessions ("where you're logged in") ---- */
export const useSessions = () => useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}
export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.revokeOtherSessions(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}
export const useViews = () => useQuery({ queryKey: ["views"], queryFn: api.views });

/* ---- Bell notifications ---- */
export const useNotifications = () =>
  useQuery({ queryKey: ["notifications"], queryFn: api.notifications });

/** Mark some (by id) or all notifications read; flips them locally right away. */
export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => api.markNotificationsRead(ids),
    onMutate: (ids) => {
      qc.setQueryData<Notification[]>(["notifications"], (cur) =>
        cur?.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)),
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
export const useInboxes = () => useQuery({ queryKey: ["inboxes"], queryFn: api.inboxes });

/** Choose which of a channel's numbers/mailboxes replies go out from.
 *
 *  Invalidates the inbox list rather than seeding it: setting one default
 *  clears another's, so the row that changed is not the only row that changed. */
export function useSetDefaultInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { inboxId: string; isDefault: boolean }) => api.setDefaultInbox(v.inboxId, v.isDefault),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inboxes"] }),
  });
}
export const useTeams = () => useQuery({ queryKey: ["teams"], queryFn: api.teams });
export const usePeople = () => useQuery({ queryKey: ["people"], queryFn: api.people });

/* ---- NestChat (Settings › NestChat widget) ---- */

/** One NestChat channel's appearance and embed snippet. Enabled only for a real
 *  inbox id, so the pane can render before a channel is picked. */
export const useNestchatSettings = (inboxId: string | undefined) =>
  useQuery({
    queryKey: ["nestchat", inboxId],
    queryFn: () => api.nestchatSettings(inboxId!),
    enabled: Boolean(inboxId),
  });

export function useUpdateNestchat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { inboxId: string; input: UpdateNestchatInput }) =>
      api.updateNestchat(v.inboxId, v.input),
    onSuccess: (data) => {
      // The response is the saved settings, so seed the cache with it rather
      // than refetching what we already have in hand.
      qc.setQueryData(["nestchat", data.inboxId], data);
    },
  });
}

/* ---- workspaces ---- */
export const useMyWorkspaces = () => useQuery({ queryKey: ["my-workspaces"], queryFn: api.myWorkspaces });

export const usePlatformWorkspaces = (enabled = true) =>
  useQuery({ queryKey: ["platform-workspaces"], queryFn: api.platformWorkspaces, enabled });

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkspaceInput) => api.createWorkspace(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platform-workspaces"] }),
  });
}

export const useWorkspacePeople = (id: string | null) =>
  useQuery({ queryKey: ["platform-workspaces", id, "people"], queryFn: () => api.workspacePeople(id!), enabled: !!id });

/** Anything that changes one workspace: refresh the list and its people. */
export function useManageWorkspace() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ["platform-workspaces"] });
  return {
    rename: useMutation({ mutationFn: (v: { id: string; name: string }) => api.renameWorkspace(v.id, v.name), onSuccess: done }),
    setStatus: useMutation({ mutationFn: (v: { id: string; status: WorkspaceStatus }) => api.setWorkspaceStatus(v.id, v.status), onSuccess: done }),
    deleteNow: useMutation({ mutationFn: (v: { id: string; confirmName: string }) => api.deleteWorkspaceNow(v.id, v.confirmName), onSuccess: done }),
    addPerson: useMutation({ mutationFn: (v: { id: string; input: AddPlatformPersonInput }) => api.addWorkspacePerson(v.id, v.input), onSuccess: done }),
    setRole: useMutation({ mutationFn: (v: { id: string; personId: string; role: Role }) => api.setWorkspacePersonRole(v.id, v.personId, v.role), onSuccess: done }),
    removePerson: useMutation({ mutationFn: (v: { id: string; personId: string }) => api.removeWorkspacePerson(v.id, v.personId), onSuccess: done }),
    resendInvite: useMutation({ mutationFn: (v: { id: string; personId: string }) => api.resendWorkspaceInvite(v.id, v.personId) }),
  };
}

/* ---- SMS channels ---- */
export const useSmsSettings = (inboxId: string | null) =>
  useQuery({ queryKey: ["sms-settings", inboxId], queryFn: () => api.smsSettings(inboxId!), enabled: !!inboxId });

export function useSaveSmsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { inboxId: string; input: SaveSmsConfigInput }) => api.saveSmsSettings(v.inboxId, v.input),
    onSuccess: (data, v) => {
      qc.setQueryData(["sms-settings", v.inboxId], data);
      qc.invalidateQueries({ queryKey: ["inboxes"] });
    },
  });
}

/* ---- integrations (Settings › Setup) ---- */
export const useIntegrations = () =>
  useQuery({ queryKey: ["integrations"], queryFn: api.getIntegrations });

export function useUpdateIntegrations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateIntegrationSettingsInput) => api.updateIntegrations(input),
    onSuccess: (data) => {
      qc.setQueryData(["integrations"], data);
      qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTeamInput) => api.createTeam(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

export function useUpdateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: UpdateTeamInput }) => api.updateTeam(v.id, v.input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTeam(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["people"] });
      qc.invalidateQueries({ queryKey: ["inboxes"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useReorderTeams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) => api.reorderTeams(orderedIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

export function useReorderInboxes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) => api.reorderInboxes(orderedIds),
    onSuccess: () => {
      // Both, and the second is the point: the sidebar is where anybody
      // notices this, and it reads from "views" rather than from "inboxes".
      qc.invalidateQueries({ queryKey: ["inboxes"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

/* ---- labels ---- */
/* ---- custom fields ---- */

/**
 * The org's field definitions.
 *
 * Fetched once and shared: every thread panel and every contact card needs the
 * same list to know what to draw, and it changes about as often as somebody
 * adds an integration.
 */
export const useCustomFields = () =>
  useQuery({ queryKey: ["custom-fields"], queryFn: api.customFields, staleTime: 5 * 60_000 });

export function useCreateCustomField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomFieldInput) => api.createCustomField(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom-fields"] }),
  });
}

export function useUpdateCustomField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: UpdateCustomFieldInput }) =>
      api.updateCustomField(v.id, v.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom-fields"] }),
  });
}

export function useDeleteCustomField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteCustomField(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custom-fields"] });
      // The values went with it, so anything showing them is now wrong.
      qc.invalidateQueries({ queryKey: ["custom-field-values"] });
    },
  });
}

/** The values on one record. */
export const useCustomFieldValues = (entity: CustomFieldEntity, entityId: string | null | undefined) =>
  useQuery({
    queryKey: ["custom-field-values", entity, entityId],
    queryFn: () => api.customFieldValues(entity, entityId!),
    enabled: Boolean(entityId),
  });

/**
 * Write values on one record.
 *
 * Invalidates the search as well as the record: an order number is written so
 * that somebody can find the thread by it, and a cached result list that
 * pre-dates the value would not have it.
 */
export function useSetCustomFieldValues() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      entity: CustomFieldEntity;
      entityId: string;
      values: Record<string, string | null>;
    }) => api.setCustomFieldValues(v.entity, v.entityId, v.values),
    onSuccess: (data, v) => {
      qc.setQueryData(["custom-field-values", v.entity, v.entityId], data.values);
      qc.invalidateQueries({ queryKey: ["search"] });
    },
  });
}

export const useLabels = () => useQuery({ queryKey: ["labels"], queryFn: api.labels });

export function useCreateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLabelInput) => api.createLabel(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labels"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

export function useUpdateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: UpdateLabelInput }) => api.updateLabel(v.id, v.input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labels"] });
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation"] });
    },
  });
}

export function useDeleteLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteLabel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labels"] });
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation"] });
    },
  });
}

export function useSetConversationLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; labelIds: string[] }) => api.setConversationLabels(v.id, v.labelIds),
    // The call carries ids; the conversation carries whole labels. The catalog
    // is already cached — it's what drew the picker the tap came from — so the
    // pills can change colour on the tap rather than on the round trip.
    onMutate: (v) => {
      const catalog = qc.getQueryData<Label[]>(["labels"]) ?? [];
      const picked = v.labelIds.map((id) => catalog.find((l) => l.id === id)).filter((l): l is Label => !!l);
      return optimisticPatch(qc, v.id, { labels: picked });
    },
    onError: (_e, v, undo) => undo && patchConversation(qc, v.id, undo),
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ["conversation", v.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => api.createUser(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["people"] }),
  });
}

export function useResendUserInvite() {
  return useMutation({ mutationFn: (id: string) => api.resendUserInvite(id) });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: UpdateUserInput }) => api.updateUser(v.id, v.input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["people"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteUser(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["people"] });
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
/* ---- customers (CRM) ---- */
export const useContacts = () => useQuery({ queryKey: ["contacts"], queryFn: api.contacts });
export const useContactDuplicates = () =>
  useQuery({ queryKey: ["contact-duplicates"], queryFn: api.contactDuplicates });

export function useMergeContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MergeContactsInput) => api.mergeContacts(input),
    onSuccess: () => {
      // Contacts, duplicate clusters and conversations (which moved to the
      // winner) all change on a merge.
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact-duplicates"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
export const useContact = (id: string | null) =>
  useQuery({
    queryKey: ["contact", id],
    queryFn: () => api.contact(id as string),
    enabled: !!id,
  });

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContactInput) => api.createContact(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contacts"] }),
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: UpdateContactInput }) => api.updateContact(v.id, v.input),
    onSuccess: (_c, v) => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact", v.id] });
      // Owner/tag edits can change routing, so refresh conversation-derived views too.
      qc.invalidateQueries({ queryKey: ["conversation"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

/**
 * Bulk import customers from a file.
 *
 * Invalidates the same queries a single create does, plus the duplicate
 * clusters: an import is the most likely thing in the app to produce
 * near-duplicates worth reviewing, and leaving that list stale is how they go
 * unnoticed.
 */
export function useImportContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportContactsInput) => api.importContacts(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact-duplicates"] });
    },
  });
}

/** Permanently delete a customer (and their conversations) from the directory. */
export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteContact(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

/** Cursor-paginated conversation list. `data` is the flattened rows so far;
 *  call fetchNextPage() to load the next page (never the whole inbox at once). */
export const useConversations = (
  view: string,
  field?: { key: string; value?: string },
  /** Page through only the open side of the view, or only the closed side. A
   *  list that pages both together and hides one of them on screen can show
   *  nothing at all: thirty recently closed threads fill the first page, and
   *  the open one behind them never loads. */
  status?: "active" | "closed",
) =>
  useInfiniteQuery({
    // The filter is part of the key: two filters over one view are two lists,
    // and sharing a cache entry would show the first one's rows under the
    // second one's chip until the refetch landed.
    queryKey: ["conversations", view, field?.key ?? "", field?.value ?? "", status ?? ""],
    queryFn: ({ pageParam }) => api.conversations(view, pageParam, field, status),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (d) => d.pages.flatMap((p) => p.items),
  });

/**
 * The filter chips' numbers, counted by the server over the whole view.
 *
 * Not derived from `useConversations`: that holds only the pages scrolled
 * through so far, so every chip read low until the list reached its end. Pass
 * the list's `dataUpdatedAt` as `stamp` so the counts are fetched again
 * whenever the list is — after a new message, an assignment, a close —
 * without every mutation having to know this query exists.
 */
export const useConversationCounts = (
  view: string,
  field?: { key: string; value?: string },
  stamp?: number,
) =>
  useQuery({
    queryKey: ["conversationCounts", view, field?.key ?? "", field?.value ?? "", stamp ?? 0],
    queryFn: () => api.conversationCounts(view, field),
    placeholderData: keepPreviousData,
    staleTime: 2000,
  });

/** Global conversation search (contact, subject, preview, message body), paginated. */
/** Search, scoped to `view` when one is given — the field sits inside an inbox,
 *  so results that inbox wouldn't show you aren't results you can act on. */
export const useSearchConversations = (q: string, enabled: boolean, view?: string) =>
  useInfiniteQuery({
    queryKey: ["search", q, view ?? "*"],
    queryFn: ({ pageParam }) => api.searchConversations(q, view, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && q.trim().length > 0,
    staleTime: 5000,
    placeholderData: keepPreviousData,
    select: (d) => d.pages.flatMap((p) => p.items),
  });

/** One page of a cursor-paginated conversation list, as it sits in the cache. */
type ConversationPages = { pages: { items: Conversation[] }[]; pageParams: unknown[] };

/**
 * The list row for a conversation, from whichever cache already holds it.
 *
 * Every conversation you can open, you opened from a list — so by the time the
 * thread mounts, its name, avatar, channel, subject, labels and status are all
 * already in memory. Finding them is the difference between a thread that
 * appears and a thread that arrives.
 */
function cachedConversationRow(qc: QueryClient, id: string): Conversation | undefined {
  for (const key of [["conversations"], ["search"]]) {
    for (const [, data] of qc.getQueriesData<ConversationPages>({ queryKey: key })) {
      for (const page of data?.pages ?? []) {
        const hit = page.items.find((c) => c.id === id);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

/**
 * The open thread.
 *
 * `placeholderData` is what stops a conversation opening onto a blank screen.
 * The row you just tapped carries everything the header needs, so the header,
 * the channel badge and the subject render on the *first* frame and the
 * messages fill in behind them. `isPlaceholderData` tells the screen it is
 * looking at a stub, so it can show the message area as loading rather than as
 * an empty conversation.
 *
 * Deliberately not synthesising a bubble out of the row's `preview`: a message
 * with an invented id is a message reactions, retries and read receipts can all
 * be pointed at, and a fake one would be a real bug the moment someone
 * long-pressed it.
 */
export const useConversation = (id: string | null) => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["conversation", id],
    queryFn: () => api.conversation(id as string),
    enabled: !!id,
    placeholderData: () => {
      if (!id) return undefined;
      const row = cachedConversationRow(qc, id);
      return row ? { ...row, messages: [], hasMoreMessages: false, participants: [] } : undefined;
    },
  });
};

/**
 * Start fetching a conversation before the screen that needs it exists.
 *
 * Called from the list row's press handler. A phone spends 250–350ms on the
 * push transition, which is dead time the request can run inside — so by the
 * time the thread has finished sliding in, its messages have usually landed.
 * Cheap to be wrong: a prefetch nobody navigates to is one warm cache entry.
 */
export function usePrefetchConversation() {
  const qc = useQueryClient();
  return useCallback(
    (id: string) => {
      void qc.prefetchQuery({
        queryKey: ["conversation", id],
        queryFn: () => api.conversation(id),
        staleTime: 10_000,
      });
    },
    [qc],
  );
}

/**
 * Change a conversation everywhere it is cached, at once.
 *
 * A conversation is in several caches simultaneously — one entry per list view,
 * any search results, and the open thread — and until all of them agree the UI
 * contradicts itself: closing from the thread left the row sitting in the inbox
 * behind it until the server answered and the list refetched.
 *
 * The inbox's filter chips recompute from these same cached rows, so patching
 * `status` here is also what makes a closed conversation leave "All" on the tap
 * rather than on the round trip.
 */
function patchConversation(qc: QueryClient, id: string, patch: Partial<Conversation>) {
  const inPages = (d: ConversationPages | undefined) =>
    d
      ? {
          ...d,
          pages: d.pages.map((p) => ({
            ...p,
            items: p.items.map((c) => (c.id === id ? { ...c, ...patch } : c)),
          })),
        }
      : d;
  qc.setQueriesData<ConversationPages>({ queryKey: ["conversations"] }, inPages);
  qc.setQueriesData<ConversationPages>({ queryKey: ["search"] }, inPages);
  qc.setQueryData<ConversationWithMessages>(["conversation", id], (c) => (c ? { ...c, ...patch } : c));
}

/**
 * Apply a change now, and put it back if the server disagrees.
 *
 * The shape every optimistic conversation mutation below shares: snapshot the
 * fields about to change, patch them, restore exactly those on failure, and
 * invalidate either way so the server's version is the one that survives.
 */
function optimisticPatch(qc: QueryClient, id: string, patch: Partial<Conversation>) {
  const before = cachedConversationRow(qc, id) ?? qc.getQueryData<ConversationWithMessages>(["conversation", id]);
  const undo = before
    ? (Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof Conversation]])) as Partial<Conversation>)
    : undefined;
  patchConversation(qc, id, patch);
  return undo;
}

/** Load older thread history (scroll-up) and prepend it into the thread cache. */
export function useLoadOlderMessages(conversationId: string | null) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const loadOlder = useCallback(async () => {
    if (!conversationId) return;
    const current = qc.getQueryData<ConversationWithMessages>(["conversation", conversationId]);
    if (!current?.hasMoreMessages || current.messages.length === 0) return;
    setLoading(true);
    try {
      const before = String(current.messages[0].seq);
      const page = await api.olderMessages(conversationId, before);
      qc.setQueryData<ConversationWithMessages>(["conversation", conversationId], (prev) =>
        prev
          ? { ...prev, messages: [...page.items, ...prev.messages], hasMoreMessages: page.nextCursor != null }
          : prev,
      );
    } finally {
      setLoading(false);
    }
  }, [conversationId, qc]);
  return { loadOlder, loading };
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      body: string;
      internal?: boolean;
      attachmentIds?: string[];
      /** Send an approved WhatsApp template instead of free text (window closed). */
      template?: { id: string; params: string[] };
      /** Quote an earlier message so it threads as a WhatsApp reply. */
      quotedMsgId?: string;
      /** Rich HTML body for an email reply (sanitized server-side). */
      bodyHtml?: string;
      /** Subject line for an email send (sets the thread's subject). */
      subject?: string;
      /** Cc / Bcc recipients on an email reply. */
      cc?: string[];
      bcc?: string[];
      /** Reply on a channel other than the conversation's own (cross-channel). */
      channel?: ChannelType;
      /** Forward this email on to other people (fresh "Fwd:" thread, logged here). */
      forwardTo?: string[];
      /** With `forwardTo`: the message being forwarded, so its attachments go too. */
      forwardOfId?: string;
    }) =>
      api.sendMessage(v.id, v.body, v.internal ?? false, v.attachmentIds, {
        template: v.template,
        quotedMsgId: v.quotedMsgId,
        bodyHtml: v.bodyHtml,
        subject: v.subject,
        cc: v.cc,
        bcc: v.bcc,
        channel: v.channel,
        forwardTo: v.forwardTo,
        forwardOfId: v.forwardOfId,
      }),
    // Optimistically render a plain text/HTML reply immediately (skip when it
    // carries attachments or a template — those render from the server result).
    onMutate: async (v) => {
      if (v.template || v.attachmentIds?.length) return { tempId: undefined as string | undefined };
      await qc.cancelQueries({ queryKey: ["conversation", v.id] });
      const prev = qc.getQueryData<ConversationWithMessages>(["conversation", v.id]);
      if (!prev) return { tempId: undefined };
      const tempId = `temp_${Date.now()}`;
      const optimistic: Message = {
        id: tempId,
        conversationId: v.id,
        seq: (prev.messages[prev.messages.length - 1]?.seq ?? 0) + 1,
        direction: "out",
        authorType: "user",
        body: v.body,
        status: v.internal ? "sent" : "queued",
        internal: v.internal ?? false,
        messageType: "text",
        attachments: [],
        reactions: [],
        bodyHtml: v.bodyHtml,
        channel: v.channel,
        // Show "Forwarded to …" on the bubble immediately (the server echoes it).
        email: v.forwardTo?.length ? { forwardedTo: v.forwardTo } : undefined,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<ConversationWithMessages>(["conversation", v.id], {
        ...prev,
        messages: [...prev.messages, optimistic],
      });
      return { tempId };
    },
    onError: (_e, v) => {
      // Drop the optimistic bubble on failure; the thread refetch restores truth.
      qc.invalidateQueries({ queryKey: ["conversation", v.id] });
    },
    onSuccess: (msg, v, ctx) => {
      // Swap the temp bubble for the real message (also arrives via socket; dedup by id).
      qc.setQueryData<ConversationWithMessages>(["conversation", v.id], (cur) => {
        if (!cur) return cur;
        const withoutTemp = ctx?.tempId ? cur.messages.filter((m) => m.id !== ctx.tempId) : cur.messages;
        const exists = withoutTemp.some((m) => m.id === msg.id);
        return { ...cur, messages: exists ? withoutTemp : [...withoutTemp, msg] };
      });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

/** React to a message with an emoji (empty string removes the agent's reaction).
 *  The update also arrives over the socket, but we invalidate for instant feedback. */
export function useReact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { conversationId: string; messageId: string; emoji: string }) =>
      api.react(v.conversationId, v.messageId, v.emoji),
    onSuccess: (_msg, v) => {
      qc.invalidateQueries({ queryKey: ["conversation", v.conversationId] });
    },
  });
}

/** Retry a failed outbound send: re-queues the message for delivery. The status
 *  ticks then flow back over the socket (sending → sent | failed again). */
export function useRetryMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { conversationId: string; messageId: string }) =>
      api.retryMessage(v.conversationId, v.messageId),
    onSuccess: (_msg, v) => {
      qc.invalidateQueries({ queryKey: ["conversation", v.conversationId] });
    },
  });
}

/**
 * Forward a message on to other customers' WhatsApp chats.
 *
 * Resolves to one result per target rather than throwing on the first failure —
 * a partly-successful forward is the normal case (one chat's 24-hour window has
 * closed), and the caller needs the breakdown to say which. It only rejects when
 * the whole request fails.
 *
 * Every target either lands in an existing thread or opens a new one, so both
 * the list and any thread the agent then visits are refetched.
 */
export function useForwardMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { conversationId: string; messageId: string; contactIds: string[] }) =>
      api.forwardMessage(v.conversationId, v.messageId, v.contactIds),
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
      for (const r of results) {
        if (r.conversationId) qc.invalidateQueries({ queryKey: ["conversation", r.conversationId] });
      }
    },
  });
}

/** Mark a conversation read: clears the unread badge and sends a WhatsApp read
 *  receipt (blue ticks) for the customer's latest message. Idempotent server-side. */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markRead(id),
    // The bold name and the count badge are what "unread" looks like, and both
    // come off the cached row — so they clear on the swipe rather than a round
    // trip later, which is the whole point of swiping instead of opening.
    onMutate: (id) => optimisticPatch(qc, id, { unread: false, unreadCount: 0 }),
    onError: (_e, id, undo) => undo && patchConversation(qc, id, undo),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useMarkUnread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markUnread(id),
    // `unreadCount` is the server's to compute — it counts inbound messages, not
    // a flag — so only the flag is set here and the refetch fills in the number.
    onMutate: (id) => optimisticPatch(qc, id, { unread: true }),
    onError: (_e, id, undo) => undo && patchConversation(qc, id, undo),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/**
 * Dismiss a conversation that's in my My Inbound only because of its notes —
 * "seen it, nothing for me to say". The tag and the Dismiss button come off
 * the cached row and thread at once; the refetch takes it out of the list.
 */
export function useDismissFollowUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.dismissFollowUp(id),
    onMutate: (id) => optimisticPatch(qc, id, { followUp: undefined }),
    onError: (_e, id, undo) => undo && patchConversation(qc, id, undo),
    onSettled: (_d, _e, id) => {
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", id] });
    },
  });
}

/* ---- WhatsApp message templates ---- */
export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: api.templates });

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTemplateInput) => api.createTemplate(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });
}

export function useUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: UpdateTemplateInput }) => api.updateTemplate(v.id, v.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });
}

export function useSetDefaultTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { templateId: string; isDefault: boolean }) =>
      api.setDefaultTemplate(v.templateId, v.isDefault),
    onSuccess: (data) => {
      qc.setQueryData(["templates"], data);
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
  });
}

export function useSubmitTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; wabaId: string }) => api.submitTemplate(v.id, v.wabaId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });
}

export function useSyncTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.syncTemplates(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });
}

/* ---- WhatsApp business profile ---- */
/** Read a WhatsApp number's public business profile (loads once a number is picked). */
export const useWhatsappProfile = (inboxId: string | null) =>
  useQuery({
    queryKey: ["wa-profile", inboxId],
    queryFn: () => api.whatsappProfile(inboxId as string),
    enabled: !!inboxId,
    retry: false,
    staleTime: 30_000,
  });

/** Save the editable fields of a number's business profile back to Meta. */
export function useUpdateWhatsappProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { inboxId: string; input: UpdateWhatsAppBusinessProfileInput }) =>
      api.updateWhatsappProfile(v.inboxId, v.input),
    onSuccess: (data, v) => qc.setQueryData(["wa-profile", v.inboxId], data),
  });
}

/** A number's Official Business Account (verified badge) status, read live from Meta. */
export const useWhatsappOba = (inboxId: string | null) =>
  useQuery({
    queryKey: ["wa-oba", inboxId],
    queryFn: () => api.whatsappOba(inboxId as string),
    enabled: !!inboxId,
    retry: false,
    staleTime: 60_000,
  });

/** Apply for the badge on a number; the status it returns replaces the cached one. */
export function useRequestWhatsappOba() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { inboxId: string; input: RequestWhatsAppObaInput }) => api.requestWhatsappOba(v.inboxId, v.input),
    onSuccess: (data, v) => qc.setQueryData(["wa-oba", v.inboxId], data),
  });
}

/** Upload a new public profile photo for a number (pushed to Meta). */
export function useSetWhatsappProfilePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { inboxId: string; file: File | Blob }) =>
      api.setWhatsappProfilePhoto(v.inboxId, v.file),
    onSuccess: (data, v) => qc.setQueryData(["wa-profile", v.inboxId], data),
  });
}

/**
 * The templates a given channel's WhatsApp account can actually send.
 *
 * Filtered by WABA, not by inbox: two numbers under one account share every
 * template, so filtering by channel would hide templates the selected number is
 * entitled to send. The account id rides along on the inbox's public config —
 * `wabaId` is an identifier, not a credential, so it already reaches the client.
 *
 * Falls back to the whole list when the inbox is unknown or carries no account
 * (a channel with no credentials yet, a non-WhatsApp one): an empty picker
 * would be a worse answer than an unfiltered one.
 */
export function useTemplatesForInbox(inboxId: string | null | undefined) {
  const templates = useTemplates();
  const inboxes = useInboxes();
  const wabaId = inboxId
    ? inboxes.data?.find((i) => i.id === inboxId)?.channelConfigPublic?.wabaId
    : undefined;
  const data = templates.data ? templatesForWaba(templates.data, wabaId) : undefined;
  return { ...templates, data, wabaId };
}

/* ---- WhatsApp Cloud API registration ---- */
/**
 * What Meta says about a number right now.
 *
 * Not cached for long and never in the background: this is read when an admin
 * opens the channel editor to answer "why can't this number send", and a
 * five-minute-old answer to that question is worse than no answer. `retry:
 * false` because a failure here is itself the information — the hook resolves
 * with a status like `auth_failed` rather than throwing, so there is nothing
 * for a retry to improve.
 */
export const useWhatsappNumberStatus = (channelId: string | null) =>
  useQuery({
    queryKey: ["wa-number-status", channelId],
    queryFn: () => api.whatsappNumberStatus(channelId as string),
    enabled: !!channelId,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

/**
 * Register the number with Meta using its two-step verification PIN.
 *
 * The PIN is an argument and nothing else: it is not put in a query key, not
 * cached, and not kept after the mutation settles. The result carries Meta's
 * fresh state, which replaces the status query's data so the editor updates
 * without a second round trip.
 */
export function useRegisterWhatsappNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { channelId: string; pin: string }) =>
      api.registerWhatsappNumber(v.channelId, v.pin),
    onSuccess: (data, v) => {
      qc.setQueryData(["wa-number-status", v.channelId], data.state);
      // A number that just came online changes what the channel list shows.
      if (data.ok) qc.invalidateQueries({ queryKey: ["inboxes"] });
    },
  });
}

/* ---- WhatsApp broadcast ---- */
/** Send an approved template to many recipients at once (a compliant 1:1 loop). */
export function useSendBroadcast() {
  return useMutation({
    mutationFn: (input: SendBroadcastInput) => api.sendBroadcast(input),
  });
}

/* ---- Move from Gmail ---- */
/** What a cutover would do: email conversations to delete, unread threads per
 *  mailbox. Fetched on demand (it reads every mailbox), not on mount. */
export function useEmailCutoverPreview(enabled: boolean) {
  return useQuery({ queryKey: ["email-cutover"], queryFn: api.emailCutoverPreview, enabled, staleTime: 0 });
}

/** A run's progress, polled while it's going. */
export function useEmailCutoverStatus(polling: boolean) {
  return useQuery({
    queryKey: ["email-cutover-status"],
    queryFn: api.emailCutoverStatus,
    enabled: polling,
    refetchInterval: polling ? 1500 : false,
  });
}

export function useRunEmailCutover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirm: string) => api.runEmailCutover(confirm),
    onSuccess: (job) => qc.setQueryData(["email-cutover-status"], job),
  });
}

/* ---- Macros ---- */

/** Every macro in the workspace (Settings › Macros). */
export function useMacros() {
  return useQuery({ queryKey: ["macros"], queryFn: () => api.macros(), staleTime: 30_000 });
}

/** The macros this conversation's composer offers (its team inbox's, plus every team's). */
export function useConversationMacros(conversationId: string | null | undefined, teamId?: string | null) {
  return useQuery({
    // The team is in the key so reassigning the chat swaps the list at once.
    queryKey: ["conversation-macros", conversationId, teamId ?? null],
    queryFn: () => api.conversationMacros(conversationId!),
    enabled: !!conversationId,
    staleTime: 30_000,
  });
}

/** Any change to a macro refreshes both lists. */
export function useMacroMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["macros"] });
      qc.invalidateQueries({ queryKey: ["conversation-macros"] });
    },
  });
}

/* ---- The conversation log ---- */

/** A conversation's log, fetched only while it's being looked at. */
export function useConversationEvents(conversationId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["conversation-events", conversationId],
    queryFn: () => api.conversationEvents(conversationId!),
    enabled: !!conversationId && enabled,
    staleTime: 5_000,
  });
}

/* ---- Business Ops ---- */

/** Whether the module is on, whether I write SOPs, and my waiting must-reads. */
export function useOpsStatus() {
  return useQuery({ queryKey: ["ops", "status"], queryFn: () => api.opsStatus(), staleTime: 30_000 });
}

/** The library: collections and the SOPs I can see, optionally searched. */
export function useOpsLibrary(q = "", enabled = true) {
  return useQuery({
    queryKey: ["ops", "library", q],
    queryFn: () => api.opsLibrary(q || undefined),
    enabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function useOpsSop(id: string | null | undefined) {
  return useQuery({ queryKey: ["ops", "sop", id], queryFn: () => api.opsSop(id!), enabled: !!id, staleTime: 10_000 });
}

export function useOpsVersions(id: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: ["ops", "versions", id], queryFn: () => api.opsVersions(id!), enabled: !!id && enabled });
}

export function useOpsAcks(id: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: ["ops", "acks", id], queryFn: () => api.opsAcks(id!), enabled: !!id && enabled });
}

/** Any Ops change: the SOP it returns is put straight in place, and everything else refreshes. */
export function useOpsMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      const sop = result as { id?: string; steps?: unknown } | undefined;
      if (sop && typeof sop === "object" && sop.id && Array.isArray(sop.steps)) qc.setQueryData(["ops", "sop", sop.id], sop);
      qc.invalidateQueries({ queryKey: ["ops"] });
    },
  });
}

/* ---- Organisations (customer accounts) ---- */

export function useAccounts(q: { search?: string; status?: AccountStatus; archived?: boolean } = {}) {
  return useQuery({ queryKey: ["accounts", q], queryFn: () => api.accounts(q), staleTime: 15_000 });
}

export function useAccount(id: string | null | undefined) {
  return useQuery({ queryKey: ["account", id], queryFn: () => api.account(id!), enabled: !!id, staleTime: 10_000 });
}

export function useAccountActivity(id: string | null | undefined) {
  return useQuery({ queryKey: ["account-activity", id], queryFn: () => api.accountActivity(id!), enabled: !!id });
}

export function useSopRevisions(accountId: string | null | undefined, sopId: string | null | undefined) {
  return useQuery({
    queryKey: ["sop-revisions", accountId, sopId],
    queryFn: () => api.accountSopRevisions(accountId!, sopId!),
    enabled: !!accountId && !!sopId,
  });
}

/** A contact's organisations. */
export function useContactAccounts(contactId: string | null | undefined) {
  return useQuery({ queryKey: ["contact-accounts", contactId], queryFn: () => api.contactAccounts(contactId!), enabled: !!contactId });
}

/** The organisation beside a conversation (see ConversationAccountContext). */
export function useConversationAccount(conversationId: string | null | undefined) {
  return useQuery({
    queryKey: ["conversation-account", conversationId],
    queryFn: () => api.conversationAccount(conversationId!),
    enabled: !!conversationId,
    // Instructions change; someone opening a conversation should see today's.
    staleTime: 15_000,
    refetchInterval: 120_000,
  });
}

/**
 * One mutation hook for every change to organisations: whatever changed, the
 * directory, the profile, a contact's organisations and the inbox panels are
 * refreshed — the same knowledge shows in all of them. Customers too: the
 * organisation name shown on a customer is their primary organisation's.
 */
export function useAccountMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ["accounts", "account", "account-activity", "sop-revisions", "contact-accounts", "conversation-account", "contacts", "contact"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useAssign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      input: { assigneeUserId?: string | null; assignedTeamId?: string | null };
      /** The chosen person's name, for the optimistic row. The server resolves
       *  it authoritatively; this is only so the row doesn't say "Unassigned"
       *  for the length of a round trip. Omit when assigning to a team. */
      assigneeName?: string | null;
    }) => api.assign(v.id, v.input),
    onMutate: (v) =>
      optimisticPatch(qc, v.id, {
        ...v.input,
        ...(v.input.assigneeUserId !== undefined ? { assigneeName: v.assigneeName ?? null } : {}),
      }),
    onError: (_e, v, undo) => undo && patchConversation(qc, v.id, undo),
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversation", v.id] });
    },
  });
}

export function useSetStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: ConversationStatus }) => api.setStatus(v.id, v.status),
    onMutate: (v) => optimisticPatch(qc, v.id, { status: v.status }),
    onError: (_e, v, undo) => undo && patchConversation(qc, v.id, undo),
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ["conversation", v.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

export function useSetPriority() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; priority: Priority }) => api.setPriority(v.id, v.priority),
    onMutate: (v) => optimisticPatch(qc, v.id, { priority: v.priority }),
    onError: (_e, v, undo) => undo && patchConversation(qc, v.id, undo),
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ["conversation", v.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

export function useSnooze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; until: string }) => api.snooze(v.id, v.until),
    onSuccess: (_conv, v) => {
      qc.invalidateQueries({ queryKey: ["conversation", v.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    },
  });
}

/** Periodically refresh lists so snoozed conversations wake out of "Later" on
 *  time and the countdowns tick, without needing a manual reload. */
export function useSnoozeSweep() {
  const qc = useQueryClient();
  useEffect(() => {
    const t = setInterval(() => {
      qc.invalidateQueries({ queryKey: ["views"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    }, 30_000);
    return () => clearInterval(t);
  }, [qc]);
}


/**
 * Live sync: server events invalidate the relevant queries so lists, counts and
 * the open thread refresh instantly — across every connected client/tab.
 */
/**
 * On-demand refresh (pull-to-refresh / refresh button): pull any new Gmail now,
 * then refetch the lists. Best-effort — a failed Gmail sync (or no Gmail inbox)
 * still refreshes the conversation lists. `refreshing` drives the spinner.
 */
export function useRefresh() {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.syncGmail().catch(() => undefined);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["conversations"] }),
        qc.invalidateQueries({ queryKey: ["conversation"] }),
        qc.invalidateQueries({ queryKey: ["views"] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [qc]);
  return { refresh, refreshing };
}

export function useRealtime(openConversationId: string | null) {
  const qc = useQueryClient();

  useEffect(() => {
    const socket = getSocket();
    // Patch the open thread's cache in place instead of refetching the whole
    // thread on every event. Returns whether the message was appended (i.e. new).
    const patchThread = (conversationId: string, message: Message): boolean => {
      let appended = false;
      qc.setQueryData<ConversationWithMessages>(["conversation", conversationId], (cur) => {
        if (!cur) return cur; // thread not open/cached — nothing to patch
        const idx = cur.messages.findIndex((m) => m.id === message.id);
        if (idx >= 0) {
          const next = cur.messages.slice();
          next[idx] = message;
          return { ...cur, messages: next };
        }
        appended = true;
        return { ...cur, messages: [...cur.messages, message] };
      });
      return appended;
    };
    const invalidateLists = () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["views"] });
    };
    // Play the outbound "sent" cue exactly once, when a message first reaches a
    // success status — so the WhatsApp/email sound means "actually sent", not
    // "queued". Never fires on failure. The channel picks the sound.
    const maybePlaySentCue = (conversationId: string, m: Message) => {
      if (m.direction !== "out" || m.internal) return;
      if (!SENT_CUE_STATUSES.has(m.status) || sentCuePlayed.has(m.id)) return;
      sentCuePlayed.add(m.id);
      const conv = qc.getQueryData<ConversationWithMessages>(["conversation", conversationId]);
      playSent(m.channel ?? conv?.channel);
    };
    // A brand-new message changes list previews/counts/order → patch thread + refresh lists.
    const onCreated = (p: { conversationId: string; message: Message }) => {
      // Inbound no longer makes a noise here. This event is a broadcast — every
      // open client in the workspace gets it, which is what keeps lists and
      // threads current, and is exactly why sounding on it chimed for every
      // arrival whoever it belonged to. The alert now arrives separately, on
      // MessageCue, addressed to the people the server's notification policy
      // picked. Outbound is different — your own send is yours to hear — and
      // `maybePlaySentCue` already ignores everything that isn't one.
      maybePlaySentCue(p.conversationId, p.message);
      patchThread(p.conversationId, p.message);
      invalidateLists();
    };
    // "This one is for you." Sent only to the people the same rules that govern
    // phone push selected — assigned to me, or a team inbox I asked to hear
    // about — with mutes and quiet hours already applied server-side.
    const onCue = () => playReceived();
    // A status tick (sent→delivered→read) only moves the ticks — patch the thread
    // in place and do NOT refetch the lists (this is the frequent, cheap path).
    const onUpdated = (p: { conversationId: string; message: Message }) => {
      maybePlaySentCue(p.conversationId, p.message);
      patchThread(p.conversationId, p.message);
    };
    // Assignment/status/snooze change the lists → refresh them (infrequent).
    // A change to a conversation is also a new line in its log, if it's open.
    const onConversation = (p?: { conversation?: Conversation }) => {
      invalidateLists();
      qc.invalidateQueries({ queryKey: ["conversation-events"] });
      // An open thread too: whether it's in my inbound because of its notes
      // (its Dismiss button) is per person, so only a refetch can say.
      if (p?.conversation?.id) qc.invalidateQueries({ queryKey: ["conversation", p.conversation.id] });
    };
    const onAssigned = () => {
      invalidateLists();
      qc.invalidateQueries({ queryKey: ["conversation-events"] });
    };
    // A bell notification (mention / snooze due) → prepend it and give a cue.
    const onNotification = (p: { notification: Notification }) => {
      qc.setQueryData<Notification[]>(["notifications"], (cur) =>
        [p.notification, ...(cur ?? []).filter((n) => n.id !== p.notification.id)].slice(0, 50),
      );
      // A must-read or review reminder: the Ops badge and library are out of date.
      if (p.notification.opsSopId) qc.invalidateQueries({ queryKey: ["ops"] });
      // A mailbox signed out: the channel list, banner and composer need to know.
      if (p.notification.type === "channel_reauth") qc.invalidateQueries({ queryKey: ["inboxes"] });
      playReceived();
    };
    socket.on(ServerEvent.MessageCreated, onCreated);
    socket.on(ServerEvent.MessageCue, onCue);
    socket.on(ServerEvent.MessageUpdated, onUpdated);
    socket.on(ServerEvent.ConversationAssigned, onAssigned);
    socket.on(ServerEvent.ConversationUpdated, onConversation);
    socket.on(ServerEvent.Notification, onNotification);
    return () => {
      socket.off(ServerEvent.MessageCreated, onCreated);
      socket.off(ServerEvent.MessageCue, onCue);
      socket.off(ServerEvent.MessageUpdated, onUpdated);
      socket.off(ServerEvent.ConversationAssigned, onAssigned);
      socket.off(ServerEvent.ConversationUpdated, onConversation);
      socket.off(ServerEvent.Notification, onNotification);
    };
  }, [qc]);

  useEffect(() => {
    if (!openConversationId) return;
    const socket = getSocket();
    socket.emit(ClientEvent.JoinConversation, { conversationId: openConversationId });
    return () => {
      socket.emit(ClientEvent.LeaveConversation, { conversationId: openConversationId });
    };
  }, [openConversationId]);
}

/* ---- typing indicators ------------------------------------------------- */

/** Who is writing on the open thread, and — on NestChat — what. */
export interface TypingPresence {
  who: string;
  /**
   * Their unsent draft, live.
   *
   * Only NestChat produces this: the widget is ours, so the draft is ours to
   * relay, and on a live chat it is worth relaying — an agent can be finding
   * the order before the question is finished. Absent everywhere else, and
   * absent for a colleague typing: reading a teammate's unsent words is a
   * different thing from knowing they are there.
   */
  preview?: string;
}

/**
 * "{name} is typing…" for the conversation currently open.
 *
 * Shared rather than written per client, because it was written per client and
 * the phone simply never got its turn — the web has had this since typing
 * indicators shipped and the app has shown nothing at all. Two copies of a
 * socket listener with two independent idle timers is also two chances to leave
 * an indicator stuck on screen for a conversation nobody is looking at any more.
 *
 * Clears three ways: on an explicit `typing:false`, after four seconds of
 * silence (a phone that goes into a tunnel mid-word never sends the `false`),
 * and on switching or closing the conversation.
 */
export function useTypingPresence(conversationId: string | null): TypingPresence | null {
  const [state, setState] = useState<TypingPresence | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setState(null);
      return;
    }
    const socket = getSocket();
    let clear: ReturnType<typeof setTimeout> | null = null;
    const onTyping = (p: {
      conversationId: string;
      who: string;
      typing: boolean;
      preview?: string;
    }) => {
      if (p.conversationId !== conversationId) return;
      if (clear) clearTimeout(clear);
      if (p.typing) {
        // `preview` is absent on channels that can't give us one (everything but
        // NestChat) and empty when the visitor has cleared their box. Both mean
        // "no text to show", and neither means "stop showing the indicator" —
        // somebody is still standing at the keyboard.
        setState({ who: p.who, preview: p.preview?.trim() || undefined });
        clear = setTimeout(() => setState(null), 4000);
      } else {
        clear = null;
        setState(null);
      }
    };
    socket.on(ServerEvent.Typing, onTyping);
    return () => {
      socket.off(ServerEvent.Typing, onTyping);
      if (clear) clearTimeout(clear);
      setState(null);
    };
  }, [conversationId]);

  return state;
}

/**
 * Broadcast that we are typing on this conversation.
 *
 * `signal()` on every keystroke; the throttling is in here. One `typing:true`
 * every two seconds at most — a socket event per character is a lot of traffic
 * to say one thing — and a 2.5s idle timer that sends `typing:false` once the
 * agent stops, so the other end clears without waiting out its own timeout.
 *
 * Leaving the conversation sends the `false` too. Without that, closing a
 * thread mid-sentence leaves everyone else looking at a colleague who appears
 * to be typing and never arrives.
 */
export function useTypingSignal(
  conversationId: string | null,
  who?: string,
): { signal: () => void; stop: () => void } {
  // Refs, not state: none of this should cause a render, and `signal` is called
  // from a keystroke handler where a re-render per character is the one thing
  // that would actually be felt.
  const sent = useRef(false);
  const throttled = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // So the unmount cleanup below sends `false` for the conversation it was
  // actually typing in, not whichever one is open by the time it runs.
  const current = useRef<string | null>(conversationId);
  const name = useRef(who);
  current.current = conversationId;
  name.current = who;

  const stop = useCallback(() => {
    if (idle.current) {
      clearTimeout(idle.current);
      idle.current = null;
    }
    throttled.current = 0;
    if (sent.current && current.current) {
      sent.current = false;
      getSocket().emit(ClientEvent.Typing, {
        conversationId: current.current,
        typing: false,
        who: name.current,
      });
    }
  }, []);

  const signal = useCallback(() => {
    const id = current.current;
    if (!id) return;
    const t = Date.now();
    if (t - throttled.current > 2000) {
      throttled.current = t;
      sent.current = true;
      getSocket().emit(ClientEvent.Typing, { conversationId: id, typing: true, who: name.current });
    }
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(stop, 2500);
  }, [stop]);

  useEffect(() => stop, [conversationId, stop]);

  return { signal, stop };
}

/**
 * Transcribe, for one voice note. `saved` is the transcript the message came
 * with, if someone already asked; otherwise nothing is fetched until `run()`.
 * Kept per attachment, so the same note in the inbox and in a chat it was
 * shared to shows the same words, and a re-render doesn't lose them.
 */
export function useTranscript(id: string | undefined, saved?: string) {
  const q = useQuery({
    queryKey: ["transcript", id],
    queryFn: () => api.transcribeMedia(id as string).then((r) => r.transcript),
    enabled: false,
    initialData: saved,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const { refetch } = q;
  const run = useCallback(() => {
    if (id) void refetch();
  }, [id, refetch]);
  return {
    /** The words; "" when there were none to hear. Undefined until asked. */
    text: q.data,
    loading: q.isFetching,
    error: q.isError ? (q.error instanceof Error ? q.error.message : "Couldn't transcribe this one") : null,
    run,
  };
}
