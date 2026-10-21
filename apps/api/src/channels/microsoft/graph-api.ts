/**
 * The slice of Microsoft Graph that an Outlook inbox needs: list new messages
 * in a folder, read one (with its threading headers and attachments), and send
 * a raw MIME message. Thin by design — the sync and provider own the policy.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

/**
 * The MAPI named property Exchange stores an internet header under. Reading
 * `X-Ding-Origin` this way works on Sent Items too, where Graph's
 * `internetMessageHeaders` is usually empty.
 */
export const DING_ORIGIN_PROP = "String {00020386-0000-0000-C000-000000000046} Name X-Ding-Origin";

export interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}

export interface GraphMessage {
  id: string;
  receivedDateTime?: string;
  internetMessageId?: string;
  subject?: string | null;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  body?: { contentType?: "html" | "text"; content?: string };
  conversationId?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  singleValueExtendedProperties?: Array<{ id: string; value: string }>;
}

export interface GraphAttachment {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  /** Present on file attachments only (not item/reference attachments). */
  contentBytes?: string;
}

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** `/me`, or `/users/{address}` for a shared mailbox reached through the signer. */
export function mailboxPath(sharedMailbox?: string): string {
  return sharedMailbox ? `/users/${encodeURIComponent(sharedMailbox)}` : "/me";
}

async function call<T>(token: string, url: string, init?: { method?: string; body?: string; contentType?: string }): Promise<T> {
  const res = await fetch(url.startsWith("http") ? url : `${GRAPH}${url}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.contentType ? { "content-type": init.contentType } : {}),
      // Ask for HTML bodies explicitly; the default can vary by mailbox setting.
      prefer: 'outlook.body-content-type="html"',
    },
    body: init?.body,
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new GraphApiError(`Outlook: ${json.error?.message ?? res.statusText} (${res.status})`, res.status);
  }
  if (res.status === 202 || res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const graph = {
  /**
   * Message ids + times in a folder at or after `sinceIso`, oldest first, across
   * every page. `ge` rather than `gt` so two messages in the same second can't
   * straddle the cursor; the caller skips the ones it already handled.
   */
  async listSince(token: string, base: string, folder: "inbox" | "sentitems", sinceIso: string) {
    const params = new URLSearchParams({
      $filter: `receivedDateTime ge ${sinceIso}`,
      $orderby: "receivedDateTime asc",
      $select: "id,receivedDateTime",
      $top: "50",
    });
    const out: Array<{ id: string; receivedDateTime: string }> = [];
    let next: string | undefined = `${base}/mailFolders/${folder}/messages?${params}`;
    while (next) {
      const page: { value: Array<{ id: string; receivedDateTime: string }>; "@odata.nextLink"?: string } = await call(token, next);
      out.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return out;
  },

  getMessage(token: string, base: string, id: string): Promise<GraphMessage> {
    const params = new URLSearchParams({
      $select:
        "id,receivedDateTime,internetMessageId,subject,from,toRecipients,ccRecipients,body,conversationId,hasAttachments,isDraft,internetMessageHeaders",
      $expand: `singleValueExtendedProperties($filter=id eq '${DING_ORIGIN_PROP}')`,
    });
    return call(token, `${base}/messages/${encodeURIComponent(id)}?${params}`);
  },

  async listAttachments(token: string, base: string, id: string): Promise<GraphAttachment[]> {
    const page: { value: GraphAttachment[] } = await call(token, `${base}/messages/${encodeURIComponent(id)}/attachments`);
    return page.value;
  },

  /**
   * Send a complete MIME message. Graph takes it base64-encoded as text/plain;
   * going through MIME (rather than Graph's JSON message) is what lets us set our
   * own Message-ID, In-Reply-To and References, so replies thread for the
   * customer exactly as they do from Gmail and Postmark.
   */
  sendMime(token: string, base: string, mimeBase64: string): Promise<void> {
    return call(token, `${base}/sendMail`, { method: "POST", body: mimeBase64, contentType: "text/plain" });
  },
};

/* ----------------------------- message parsing ---------------------------- */

export function header(msg: GraphMessage, name: string): string | undefined {
  const want = name.toLowerCase();
  return msg.internetMessageHeaders?.find((h) => h.name.toLowerCase() === want)?.value;
}

/** True when this is a copy of mail Nest itself sent (it carries our marker header). */
export function isNestOrigin(msg: GraphMessage): boolean {
  if (header(msg, "X-Ding-Origin") === "nest") return true;
  return msg.singleValueExtendedProperties?.some((p) => p.id.toLowerCase() === DING_ORIGIN_PROP.toLowerCase() && p.value === "nest") ?? false;
}

/** The Message-IDs this mail threads onto (References + In-Reply-To). */
export function threadRefs(msg: GraphMessage): string[] {
  const raw = `${header(msg, "References") ?? ""} ${header(msg, "In-Reply-To") ?? ""}`;
  return [...new Set(raw.split(/\s+/).map((s) => s.trim()).filter(Boolean))];
}

export function addressOf(r?: GraphRecipient): { email: string; name?: string } {
  return {
    email: (r?.emailAddress?.address ?? "").trim().toLowerCase(),
    name: r?.emailAddress?.name?.trim() || undefined,
  };
}

export function recipientList(...lists: Array<GraphRecipient[] | undefined>): string[] {
  return [...new Set(lists.flatMap((l) => l ?? []).map((r) => addressOf(r).email).filter(Boolean))];
}
