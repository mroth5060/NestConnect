import type { SmsProviderConfig } from "@ding/schemas";

/**
 * The universal SMS engine: a provider config (packages/schemas/src/sms.ts) in,
 * HTTP requests out, and the provider's answers read back into ours. Pure — no
 * store, no network — so every provider shape can be checked without one;
 * `smsFetch` at the bottom is the only thing that talks to the outside.
 */

export interface SmsRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface SmsVars {
  to?: string;
  text?: string;
  from?: string;
  message_id?: string;
  status_url?: string;
  inbound_url?: string;
  since?: string;
}

/** The provider's message, in our words. */
export interface SmsInbound {
  id?: string;
  from: string;
  to?: string;
  text: string;
  at?: Date;
}

export type SmsOutcome = "delivered" | "failed" | "sent";

/* ---- reading a provider's answer ---- */

/** A value at `path` in `obj`: `a.b[0].c`, `a|b` (first that's there), `$` (all of it). */
export function readPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  for (const alt of path.split("|").map((p) => p.trim())) {
    const v = readOne(obj, alt);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function readOne(obj: unknown, path: string): unknown {
  if (path === "$" || path === "") return obj;
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

const asText = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === "object" ? JSON.stringify(v) : String(v);

/** A body as data: JSON, else form-encoded, else the text itself. */
export function parseBody(text: string, contentType = ""): unknown {
  const t = text.trim();
  if (!t) return {};
  if (contentType.includes("json") || t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through */
    }
  }
  if (contentType.includes("x-www-form-urlencoded") || (/^[^\s=&]+=[^&]*(&[^\s=&]+=[^&]*)*$/.test(t) && !t.includes(" "))) {
    return Object.fromEntries(new URLSearchParams(t));
  }
  return t;
}

/* ---- phone numbers ---- */

/** A number as E.164 (+447700900123): digits kept; one without a leading + or
 *  00 is read as national, in the channel's country, when it has one. */
export function normalizePhone(raw: string, countryCode = ""): string {
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  if (!digits) return s;
  if (s.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (countryCode && !digits.startsWith(countryCode)) return `+${countryCode}${digits.replace(/^0+/, "")}`;
  if (countryCode && digits.length <= 10) return `+${countryCode}${digits.replace(/^0+/, "")}`;
  return `+${digits}`;
}

function phoneVars(to: string | undefined, countryCode: string): Record<string, string> {
  if (!to) return {};
  const e164 = normalizePhone(to, countryCode);
  const digits = e164.replace(/\D/g, "");
  const local = countryCode && digits.startsWith(countryCode) ? digits.slice(countryCode.length) : digits;
  return { to: e164, to_digits: digits, to_local: local };
}

/* ---- templates ---- */

function values(cfg: SmsProviderConfig, secret: string | undefined, vars: SmsVars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (v !== undefined && k !== "to") out[k] = v;
  Object.assign(out, phoneVars(vars.to, cfg.countryCode));
  for (const p of cfg.params) out[`param.${p.name}`] = p.value;
  if (secret !== undefined) out.secret = secret;
  return out;
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Fill `{{name}}` placeholders. Unknown ones become empty. */
export function render(template: string, vals: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => vals[name] ?? "");
}

/** Fill a JSON template structurally, so a value can never break the JSON. */
export function renderJson(template: string, vals: Record<string, string>): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch (err) {
    throw new SmsConfigError(`The request body isn't valid JSON: ${(err as Error).message}`);
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return render(v, vals);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [render(k, vals), walk(x)]));
    return v;
  };
  return walk(parsed);
}

export class SmsConfigError extends Error {}

/* ---- requests ---- */

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Every request a channel makes: base URL, the channel's headers and auth. */
function request(
  cfg: SmsProviderConfig,
  secret: string | undefined,
  vals: Record<string, string>,
  method: string,
  path: string,
  extraHeaders: { name: string; value: string }[] = [],
): SmsRequest {
  let url = joinUrl(cfg.baseUrl, render(path, vals));
  const headers: Record<string, string> = {};
  for (const h of [...cfg.headers, ...extraHeaders]) headers[h.name] = render(h.value, vals);
  const key = secret ?? "";
  switch (cfg.auth.type) {
    case "bearer":
      headers.Authorization = `Bearer ${key}`;
      break;
    case "basic":
      headers.Authorization = `Basic ${Buffer.from(`${render(cfg.auth.username ?? "", vals)}:${key}`).toString("base64")}`;
      break;
    case "header":
      headers[cfg.auth.headerName || "X-API-Key"] = key;
      break;
    case "query": {
      const u = new URL(url);
      u.searchParams.set(cfg.auth.queryName || "api_key", key);
      url = u.toString();
      break;
    }
  }
  return { method, url, headers };
}

/** The request that sends one text. */
export function buildSend(cfg: SmsProviderConfig, secret: string | undefined, vars: SmsVars): SmsRequest {
  const vals = values(cfg, secret, vars);
  const req = request(cfg, secret, vals, cfg.send.method, cfg.send.path);
  if (cfg.send.bodyFormat === "json" && cfg.send.method !== "GET") {
    req.body = JSON.stringify(renderJson(cfg.send.body || "{}", vals));
    req.headers["Content-Type"] ??= "application/json";
  } else if (cfg.send.bodyFormat === "form" && cfg.send.method !== "GET") {
    const fields = renderJson(cfg.send.body || "{}", vals);
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new SmsConfigError("A form body is a JSON object of field → value.");
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) if (v !== "" && v !== undefined && v !== null) form.set(k, String(v));
    req.body = form.toString();
    req.headers["Content-Type"] ??= "application/x-www-form-urlencoded";
  }
  return req;
}

/** The request that fetches new texts (polling). */
export function buildInboundPoll(cfg: SmsProviderConfig, secret: string | undefined, vars: SmsVars): SmsRequest {
  return request(cfg, secret, values(cfg, secret, vars), cfg.inbound.method, cfg.inbound.path, cfg.inbound.headers);
}

/** The request that asks after one sent text (polling receipts). */
export function buildStatusPoll(cfg: SmsProviderConfig, secret: string | undefined, vars: SmsVars): SmsRequest {
  return request(cfg, secret, values(cfg, secret, vars), cfg.status.method, cfg.status.path, cfg.status.headers);
}

/* ---- answers ---- */

/** What the provider said about a send. */
export function readSendResponse(
  cfg: SmsProviderConfig,
  status: number,
  text: string,
  contentType = "",
): { ok: boolean; providerId?: string; error?: string; mapped: Record<string, unknown> } {
  const body = parseBody(text, contentType);
  const providerId = asText(readPath(body, cfg.send.messageIdPath));
  const error = asText(readPath(body, cfg.send.errorPath));
  let ok = status >= 200 && status < 300;
  if (ok && cfg.send.successPath) {
    const v = readPath(body, cfg.send.successPath);
    ok = cfg.send.successValue !== undefined && cfg.send.successValue !== ""
      ? String(v).toLowerCase() === cfg.send.successValue.toLowerCase()
      : v === true || v === "true" || v === 1 || v === "1" || v === "ok" || v === "success";
  }
  return {
    ok,
    providerId,
    error: ok ? undefined : error ?? (status >= 300 ? `HTTP ${status}` : "The provider didn't say it was sent"),
    mapped: { success: ok, messageId: providerId ?? null, error: error ?? null },
  };
}

/** The texts in a webhook's or a poll's body. */
export function readInbound(cfg: SmsProviderConfig, body: unknown): SmsInbound[] {
  const f = cfg.inbound;
  const list = f.itemsPath ? readPath(body, f.itemsPath) : body;
  const items = Array.isArray(list) ? list : list && typeof list === "object" ? [list] : [];
  const out: SmsInbound[] = [];
  for (const item of items) {
    const from = asText(readPath(item, f.fromPath));
    let text = asText(readPath(item, f.textPath));
    if (!from || text === undefined) continue;
    if (f.textEncoding === "url") {
      try {
        text = decodeURIComponent(text.replace(/\+/g, " "));
      } catch {
        /* leave it as it came */
      }
    }
    const at = asText(readPath(item, f.timestampPath));
    const when = at ? parseTime(at) : undefined;
    const to = asText(readPath(item, f.toPath));
    out.push({
      id: asText(readPath(item, f.idPath)),
      from: normalizePhone(from, cfg.countryCode),
      to: to ? normalizePhone(to, cfg.countryCode) : undefined,
      text,
      at: when,
    });
  }
  return out;
}

function parseTime(s: string): Date | undefined {
  const n = Number(s);
  const d = Number.isFinite(n) && /^\d+$/.test(s) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** A delivery receipt: which message, and what became of it. */
export function readStatus(cfg: SmsProviderConfig, body: unknown): { providerId?: string; outcome?: SmsOutcome; raw?: string; error?: string } {
  const s = cfg.status;
  const list = s.itemsPath ? readPath(body, s.itemsPath) : body;
  const item = Array.isArray(list) ? list[0] : list;
  if (!item || typeof item !== "object") return {};
  const raw = asText(readPath(item, s.statusPath));
  const word = raw?.toLowerCase();
  const is = (words: string[]) => !!word && words.some((w) => w.toLowerCase() === word);
  return {
    providerId: asText(readPath(item, s.idPath)),
    outcome: is(s.failed) ? "failed" : is(s.delivered) ? "delivered" : is(s.sent) ? "sent" : undefined,
    raw,
    error: asText(readPath(item, s.errorPath)),
  };
}

/* ---- for people reading a test ---- */

/** A request as safe to show: the secret blanked wherever it went. */
export function redactRequest(req: SmsRequest, secret: string | undefined): SmsRequest {
  const hide = (v: string) => {
    let out = v;
    if (secret) out = out.split(secret).join("••••••");
    if (secret) out = out.split(encodeURIComponent(secret)).join("••••••");
    return out.replace(/^(Basic|Bearer)\s+\S+$/i, "$1 ••••••");
  };
  return {
    method: req.method,
    url: hide(req.url),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, hide(v)])),
    body: req.body === undefined ? undefined : hide(req.body),
  };
}

/* ---- the network ---- */

export interface SmsHttpResponse {
  status: number;
  text: string;
  contentType: string;
}

/** One request to a provider, with a timeout. Network trouble is status 0. */
export async function smsFetch(req: SmsRequest, timeoutMs = 15_000): Promise<SmsHttpResponse> {
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: (await res.text()).slice(0, 200_000), contentType: res.headers.get("content-type") ?? "" };
  } catch (err) {
    return { status: 0, text: String((err as Error).message ?? err), contentType: "" };
  }
}
