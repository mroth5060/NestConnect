import type { QueryClient } from "@tanstack/react-query";
import { api, resetSocket, seedIdentity } from "@ding/client";
import { saveSession } from "./session";
import { forgetWorkspaceNotifications } from "./push";

/**
 * Move this phone into another of my workspaces.
 *
 * The server ends this session and opens one there, handing back its token —
 * stored before anything else asks the API a question, the same order signing
 * in uses. Then everything the old workspace filled the caches with goes, the
 * socket reconnects as the new session, and push re-registers for it (the old
 * session's device row went with the session; `usePushRegistration` sees the
 * new account and registers again). The old workspace's badge and
 * notifications go too: the new one's number replaces them once it's counted.
 */
export async function switchWorkspace(qc: QueryClient, orgId: string): Promise<void> {
  const result = await api.switchWorkspace(orgId);
  if (result.token) await saveSession(result.token);
  await forgetWorkspaceNotifications();
  resetSocket();
  seedIdentity(qc, result);
  await qc.resetQueries({ predicate: (q) => q.queryKey[0] !== "session" && q.queryKey[0] !== "me" });
}
