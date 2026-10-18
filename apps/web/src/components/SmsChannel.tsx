import { useEffect, useState, type ReactNode } from "react";
import {
  SMS_PRESETS,
  smsCapabilities,
  smsProviderConfigSchema,
  type SmsPair,
  type SmsProviderConfig,
  type SmsTestResult,
} from "@ding/schemas";
import { api, useSaveSmsSettings, useSmsSettings } from "../hooks";
import { PlusIcon, TrashIcon, SparkleIcon } from "../lib/icons";

/**
 * An SMS channel's provider, described rather than coded: a preset to start
 * from, then every part of the API — how to sign in, the request that sends a
 * text, how its answer reads, how replies and receipts come back — editable,
 * testable, or filled in by AI from the provider's docs.
 *
 * Used twice: when connecting a new SMS channel (the parent saves the config
 * with the channel), and in an existing channel's editor (SmsProviderPanel
 * loads and saves it).
 */

/** The full config, defaults filled — what the editor edits. */
export function smsDefaults(preset = "dialmycalls"): SmsProviderConfig {
  return smsProviderConfigSchema.parse(SMS_PRESETS[preset]?.config ?? SMS_PRESETS.custom!.config);
}

export function SmsConfigEditor({
  value,
  onChange,
  secret,
  onSecret,
  hasSecret = false,
  urls,
  inboxId,
  onToast,
}: {
  value: SmsProviderConfig;
  onChange: (next: SmsProviderConfig) => void;
  secret: string;
  onSecret: (s: string) => void;
  /** A saved channel's secret is kept unless a new one is typed. */
  hasSecret?: boolean;
  /** Where the provider posts — known once the channel is saved. */
  urls?: { inboundUrl: string; statusUrl: string };
  inboxId?: string;
  onToast: (msg: string) => void;
}) {
  const cfg = value;
  const set = (patch: Partial<SmsProviderConfig>) => onChange({ ...cfg, ...patch });
  const setSend = (patch: Partial<SmsProviderConfig["send"]>) => onChange({ ...cfg, send: { ...cfg.send, ...patch } });
  const setIn = (patch: Partial<SmsProviderConfig["inbound"]>) => onChange({ ...cfg, inbound: { ...cfg.inbound, ...patch } });
  const setSt = (patch: Partial<SmsProviderConfig["status"]>) => onChange({ ...cfg, status: { ...cfg.status, ...patch } });
  const preset = SMS_PRESETS[cfg.preset ?? ""];
  const caps = smsCapabilities(cfg);

  const choosePreset = (key: string) => {
    if (key === cfg.preset) return;
    if (cfg.preset && !window.confirm("Start again from this provider's settings? What you've changed here is replaced.")) return;
    onChange(smsDefaults(key));
  };

  return (
    <div className="smscfg">
      <div className="smscfg__presets" role="radiogroup" aria-label="SMS provider">
        {Object.entries(SMS_PRESETS).map(([key, p]) => (
          <button key={key} type="button" role="radio" aria-checked={cfg.preset === key} className={"smscfg__preset" + (cfg.preset === key ? " on" : "")} onClick={() => choosePreset(key)}>
            <b>{p.label}</b>
          </button>
        ))}
      </div>
      {preset && <p className="fieldhint">{preset.blurb}</p>}

      <AiFill onFill={(next, notes) => { onChange(next); if (notes.length) onToast("AI filled the settings in — check its notes below the form"); }} onToast={onToast} />

      <div className="setform__grid two">
        <label className="field">
          <span>Provider name</span>
          <input value={cfg.provider} onChange={(e) => set({ provider: e.target.value })} />
        </label>
        <label className="field">
          <span>{preset?.secretLabel ?? "API key / token"} {hasSecret && <em>— leave blank to keep</em>}</span>
          <input type="password" autoComplete="off" value={secret} onChange={(e) => onSecret(e.target.value)} placeholder={hasSecret ? "••••••••" : ""} />
        </label>
      </div>
      {cfg.params.length > 0 && (
        <div className="setform__grid two">
          {cfg.params.map((p, i) => (
            <label className="field" key={i}>
              <span>{labelFor(p.name)}</span>
              <input value={p.value} onChange={(e) => set({ params: cfg.params.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
            </label>
          ))}
        </div>
      )}

      <p className="smscfg__caps">
        <Cap on>Sends texts</Cap>
        <Cap on={!!caps.receive}>{caps.receive === "poll" ? "Fetches replies every " + cfg.inbound.intervalSeconds + "s" : caps.receive === "webhook" ? "Receives replies by webhook" : "No replies"}</Cap>
        <Cap on={!!caps.deliveryReceipts}>{caps.deliveryReceipts ? `Delivery receipts by ${caps.deliveryReceipts}` : "No delivery receipts"}</Cap>
      </p>

      {urls && (caps.receive === "webhook" || caps.deliveryReceipts === "webhook") && (
        <div className="smscfg__urls">
          {caps.receive === "webhook" && <CopyUrl label="Incoming texts URL — paste into the provider's settings" url={urls.inboundUrl} onToast={onToast} />}
          {caps.deliveryReceipts === "webhook" && <CopyUrl label="Delivery receipts URL" url={urls.statusUrl} onToast={onToast} />}
        </div>
      )}
      {!urls && (caps.receive === "webhook" || caps.deliveryReceipts === "webhook") && (
        <p className="fieldhint">The webhook URLs to give the provider appear in this channel's settings once it's connected.</p>
      )}

      <Section title="Connection">
        <div className="setform__grid two">
          <label className="field">
            <span>Base URL</span>
            <input value={cfg.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.provider.com/v1" />
          </label>
          <label className="field">
            <span>Country code <em>digits, for numbers written without one</em></span>
            <input value={cfg.countryCode} onChange={(e) => set({ countryCode: e.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder="e.g. 1 or 44" />
          </label>
          <label className="field">
            <span>Authentication</span>
            <select value={cfg.auth.type} onChange={(e) => set({ auth: { ...cfg.auth, type: e.target.value as SmsProviderConfig["auth"]["type"] } })}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="basic">Basic auth (username + secret)</option>
              <option value="header">API key in a header</option>
              <option value="query">API key in the URL</option>
            </select>
          </label>
          {cfg.auth.type === "header" && (
            <label className="field"><span>Header name</span><input value={cfg.auth.headerName ?? ""} onChange={(e) => set({ auth: { ...cfg.auth, headerName: e.target.value } })} placeholder="X-API-Key" /></label>
          )}
          {cfg.auth.type === "query" && (
            <label className="field"><span>Query parameter</span><input value={cfg.auth.queryName ?? ""} onChange={(e) => set({ auth: { ...cfg.auth, queryName: e.target.value } })} placeholder="api_key" /></label>
          )}
          {cfg.auth.type === "basic" && (
            <label className="field"><span>Username</span><input value={cfg.auth.username ?? ""} onChange={(e) => set({ auth: { ...cfg.auth, username: e.target.value } })} placeholder="account id, or {{param.account_sid}}" /></label>
          )}
          <label className="field">
            <span>Longest text, in characters</span>
            <input type="number" min={70} max={10000} value={cfg.maxLength} onChange={(e) => set({ maxLength: Number(e.target.value) || 160 })} />
          </label>
        </div>
        <Pairs title="Account settings — used as {{param.name}}" pairs={cfg.params} onChange={(params) => set({ params })} />
        <Pairs title="Headers sent with every request" pairs={cfg.headers} onChange={(headers) => set({ headers })} />
      </Section>

      <Section title="Sending a text">
        <div className="setform__grid two">
          <label className="field">
            <span>Method and path</span>
            <div className="smscfg__inline">
              <select value={cfg.send.method} onChange={(e) => setSend({ method: e.target.value as "POST" })}>
                <option>POST</option><option>PUT</option><option>GET</option>
              </select>
              <input value={cfg.send.path} onChange={(e) => setSend({ path: e.target.value })} placeholder="/messages" />
            </div>
          </label>
          <label className="field">
            <span>Body</span>
            <select value={cfg.send.bodyFormat} onChange={(e) => setSend({ bodyFormat: e.target.value as "json" })}>
              <option value="json">JSON</option>
              <option value="form">Form fields</option>
              <option value="none">No body</option>
            </select>
          </label>
        </div>
        {cfg.send.bodyFormat !== "none" && (
          <label className="field">
            <span>{cfg.send.bodyFormat === "form" ? "Form fields, as a JSON object" : "Request body"}</span>
            <textarea className="smscfg__code" rows={7} spellCheck={false} value={cfg.send.body} onChange={(e) => setSend({ body: e.target.value })} />
          </label>
        )}
        <p className="fieldhint">
          Fill-ins: <code>{"{{to}}"}</code> (+447700900123), <code>{"{{to_digits}}"}</code>, <code>{"{{to_local}}"}</code>, <code>{"{{from}}"}</code> (this channel's sender), <code>{"{{text}}"}</code>, <code>{"{{message_id}}"}</code>, <code>{"{{status_url}}"}</code>, <code>{"{{param.name}}"}</code>, <code>{"{{secret}}"}</code>.
        </p>
        <div className="setform__grid two">
          <Path label="Message id in the answer" value={cfg.send.messageIdPath} onChange={(v) => setSend({ messageIdPath: v })} placeholder="id or data.messages[0].id" />
          <Path label="Error message in the answer" value={cfg.send.errorPath} onChange={(v) => setSend({ errorPath: v })} placeholder="error.message" />
          <Path label="Success flag in the answer" value={cfg.send.successPath} onChange={(v) => setSend({ successPath: v })} placeholder="empty: any 2xx" />
          <Path label="…which must equal" value={cfg.send.successValue} onChange={(v) => setSend({ successValue: v })} placeholder="empty: true" />
        </div>
      </Section>

      <Section title="Incoming texts">
        <label className="field">
          <span>How replies arrive</span>
          <select value={cfg.inbound.mode} onChange={(e) => setIn({ mode: e.target.value as "none" })}>
            <option value="webhook">The provider posts them to us (webhook)</option>
            <option value="poll">We ask for them (polling)</option>
            <option value="none">They don't — send only</option>
          </select>
        </label>
        {cfg.inbound.mode === "poll" && (
          <>
            <div className="setform__grid two">
              <label className="field">
                <span>Method and path</span>
                <div className="smscfg__inline">
                  <select value={cfg.inbound.method} onChange={(e) => setIn({ method: e.target.value as "GET" })}><option>GET</option><option>POST</option></select>
                  <input value={cfg.inbound.path} onChange={(e) => setIn({ path: e.target.value })} placeholder="/incoming" />
                </div>
              </label>
              <label className="field">
                <span>Every (seconds)</span>
                <input type="number" min={15} max={3600} value={cfg.inbound.intervalSeconds} onChange={(e) => setIn({ intervalSeconds: Number(e.target.value) || 60 })} />
              </label>
            </div>
            <Pairs title="Headers for this request" pairs={cfg.inbound.headers} onChange={(headers) => setIn({ headers })} />
          </>
        )}
        {cfg.inbound.mode !== "none" && (
          <div className="setform__grid two">
            <Path label="List of texts" value={cfg.inbound.itemsPath} onChange={(v) => setIn({ itemsPath: v })} placeholder="empty: one text per post" />
            <Path label="Text id" value={cfg.inbound.idPath} onChange={(v) => setIn({ idPath: v })} placeholder="id" />
            <Path label="From number" value={cfg.inbound.fromPath} onChange={(v) => setIn({ fromPath: v ?? "" })} placeholder="from" />
            <Path label="Message text" value={cfg.inbound.textPath} onChange={(v) => setIn({ textPath: v ?? "" })} placeholder="text" />
            <Path label="To number" value={cfg.inbound.toPath} onChange={(v) => setIn({ toPath: v })} placeholder="to" />
            <Path label="Time sent" value={cfg.inbound.timestampPath} onChange={(v) => setIn({ timestampPath: v })} placeholder="created_at" />
            <label className="field">
              <span>Text encoding</span>
              <select value={cfg.inbound.textEncoding} onChange={(e) => setIn({ textEncoding: e.target.value as "plain" })}>
                <option value="plain">Plain</option><option value="url">URL-encoded</option>
              </select>
            </label>
          </div>
        )}
      </Section>

      <Section title="Delivery receipts">
        <label className="field">
          <span>How receipts arrive</span>
          <select value={cfg.status.mode} onChange={(e) => setSt({ mode: e.target.value as "none" })}>
            <option value="webhook">The provider posts them to us (webhook)</option>
            <option value="poll">We ask after each text (polling)</option>
            <option value="none">Not available</option>
          </select>
        </label>
        {cfg.status.mode === "poll" && (
          <div className="setform__grid two">
            <label className="field">
              <span>Method and path <em>{"{{message_id}}"} is the provider's id</em></span>
              <div className="smscfg__inline">
                <select value={cfg.status.method} onChange={(e) => setSt({ method: e.target.value as "GET" })}><option>GET</option><option>POST</option></select>
                <input value={cfg.status.path} onChange={(e) => setSt({ path: e.target.value })} placeholder="/messages/{{message_id}}" />
              </div>
            </label>
            <label className="field">
              <span>Every (seconds)</span>
              <input type="number" min={15} max={3600} value={cfg.status.intervalSeconds} onChange={(e) => setSt({ intervalSeconds: Number(e.target.value) || 120 })} />
            </label>
          </div>
        )}
        {cfg.status.mode !== "none" && (
          <>
            <div className="setform__grid two">
              <Path label="List (first is used)" value={cfg.status.itemsPath} onChange={(v) => setSt({ itemsPath: v })} placeholder="empty: one receipt" />
              {cfg.status.mode === "webhook" && <Path label="Message id" value={cfg.status.idPath} onChange={(v) => setSt({ idPath: v })} placeholder="id" />}
              <Path label="Status" value={cfg.status.statusPath} onChange={(v) => setSt({ statusPath: v ?? "" })} placeholder="status" />
              <Path label="Failure reason" value={cfg.status.errorPath} onChange={(v) => setSt({ errorPath: v })} placeholder="error" />
            </div>
            <div className="setform__grid two">
              <Words label="Means delivered" words={cfg.status.delivered} onChange={(delivered) => setSt({ delivered })} />
              <Words label="Means failed" words={cfg.status.failed} onChange={(failed) => setSt({ failed })} />
            </div>
          </>
        )}
      </Section>

      <Tester cfg={cfg} secret={secret} inboxId={inboxId} />
    </div>
  );
}

/** A saved SMS channel's provider settings, in its channel editor. */
export function SmsProviderPanel({ inboxId, onToast }: { inboxId: string; onToast: (msg: string) => void }) {
  const settings = useSmsSettings(inboxId);
  const save = useSaveSmsSettings();
  const [cfg, setCfg] = useState<SmsProviderConfig | null>(null);
  const [secret, setSecret] = useState("");
  const [polling, setPolling] = useState(false);
  useEffect(() => {
    if (settings.data && !cfg) setCfg(settings.data.config);
  }, [settings.data, cfg]);
  if (settings.isLoading || !cfg) return <div className="connect__creds"><p className="fieldhint">Loading the provider settings…</p></div>;
  if (settings.isError || !settings.data) return <div className="connect__creds"><p className="fieldhint">Couldn't load this channel's provider settings.</p></div>;

  const submit = () => {
    const parsed = smsProviderConfigSchema.safeParse(cfg);
    if (!parsed.success) return onToast(`Check the settings: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}`);
    save.mutate(
      { inboxId, input: { config: parsed.data, ...(secret ? { secret } : {}) } },
      { onSuccess: () => { setSecret(""); onToast("SMS provider settings saved"); }, onError: (e) => onToast(e instanceof Error ? e.message : "Couldn't save them") },
    );
  };
  const checkNow = () => {
    setPolling(true);
    api.pollSms(inboxId).then(
      (r) => onToast(`Checked: ${r.imported} new text(s), ${r.receipts} receipt(s)`),
      (e) => onToast(e instanceof Error ? e.message : "Couldn't check"),
    ).finally(() => setPolling(false));
  };

  return (
    <div className="connect__creds">
      <div className="connect__credhead">SMS provider</div>
      <SmsConfigEditor
        value={cfg}
        onChange={setCfg}
        secret={secret}
        onSecret={setSecret}
        hasSecret={settings.data.hasSecret}
        urls={{ inboundUrl: settings.data.inboundUrl, statusUrl: settings.data.statusUrl }}
        inboxId={inboxId}
        onToast={onToast}
      />
      <div className="smscfg__acts">
        {(cfg.inbound.mode === "poll" || cfg.status.mode === "poll") && (
          <button type="button" className="btn-ghost" disabled={polling} onClick={checkNow}>{polling ? "Checking…" : "Check for texts now"}</button>
        )}
        <button type="button" className="btn-primary" disabled={save.isPending} onClick={submit}>Save provider settings</button>
      </div>
    </div>
  );
}

/* ---- parts ---- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="smscfg__sec">
      <summary>{title}</summary>
      <div className="smscfg__secbody">{children}</div>
    </details>
  );
}

function Cap({ on, children }: { on?: boolean; children: ReactNode }) {
  return <span className={"smscfg__cap" + (on ? " on" : "")}>{children}</span>;
}

function Path({ label, value, onChange, placeholder }: { label: string; value: string | undefined; onChange: (v: string | undefined) => void; placeholder?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="smscfg__mono" value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} placeholder={placeholder} spellCheck={false} />
    </label>
  );
}

function Words({ label, words, onChange }: { label: string; words: string[]; onChange: (w: string[]) => void }) {
  const [text, setText] = useState(words.join(", "));
  return (
    <label className="field">
      <span>{label} <em>comma-separated</em></span>
      <input value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value.split(",").map((w) => w.trim()).filter(Boolean)); }} />
    </label>
  );
}

function Pairs({ title, pairs, onChange }: { title: string; pairs: SmsPair[]; onChange: (p: SmsPair[]) => void }) {
  return (
    <div className="smscfg__pairs">
      <div className="smscfg__pairhead">
        <span>{title}</span>
        <button type="button" className="btn-ghost sm" onClick={() => onChange([...pairs, { name: "", value: "" }])}><PlusIcon /> Add</button>
      </div>
      {pairs.map((p, i) => (
        <div className="smscfg__pair" key={i}>
          <input className="smscfg__mono" value={p.name} placeholder="name" aria-label="Name" onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="smscfg__mono" value={p.value} placeholder="value" aria-label="Value" onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button type="button" className="iconbtn" title="Remove" onClick={() => onChange(pairs.filter((_, j) => j !== i))}><TrashIcon /></button>
        </div>
      ))}
    </div>
  );
}

function CopyUrl({ label, url, onToast }: { label: string; url: string; onToast: (m: string) => void }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="copyrow">
        <input readOnly value={url} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn-ghost" onClick={() => void navigator.clipboard.writeText(url).then(() => onToast("Copied"), () => undefined)}>Copy</button>
      </div>
    </div>
  );
}

/** Try the settings before trusting them: a real text, one fetch, a sample. */
function Tester({ cfg, secret, inboxId }: { cfg: SmsProviderConfig; secret: string; inboxId?: string }) {
  const [to, setTo] = useState("");
  const [sample, setSample] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<SmsTestResult | null>(null);
  const run = (action: "send" | "inbound" | "parse") => {
    const parsed = smsProviderConfigSchema.safeParse(cfg);
    if (!parsed.success) {
      setResult({ ok: false, summary: `Check the settings: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` });
      return;
    }
    setBusy(action);
    api
      .testSms({ config: parsed.data, action, to, sample, ...(secret ? { secret } : {}), ...(inboxId ? { inboxId } : {}) })
      .then(setResult, (e) => setResult({ ok: false, summary: e instanceof Error ? e.message : "The test didn't run" }))
      .finally(() => setBusy(null));
  };
  return (
    <details className="smscfg__sec" open={!!result}>
      <summary>Test</summary>
      <div className="smscfg__secbody">
        <div className="smscfg__inline">
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Your mobile, e.g. +447700900123" aria-label="Test number" />
          <button type="button" className="btn-ghost" disabled={!to.trim() || !!busy} onClick={() => run("send")}>{busy === "send" ? "Sending…" : "Send a test text"}</button>
        </div>
        {cfg.inbound.mode === "poll" && (
          <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => run("inbound")}>{busy === "inbound" ? "Fetching…" : "Fetch incoming texts once"}</button>
        )}
        {cfg.inbound.mode === "webhook" || cfg.status.mode === "webhook" ? (
          <>
            <textarea className="smscfg__code" rows={4} value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Paste a sample webhook body (JSON or form fields) to check the field mapping" spellCheck={false} />
            <button type="button" className="btn-ghost" disabled={!sample.trim() || !!busy} onClick={() => run("parse")}>Read the sample</button>
          </>
        ) : null}
        {result && (
          <div className={"smscfg__result" + (result.ok ? " ok" : " bad")}>
            <b>{result.summary}</b>
            {(result.request || result.response) && (
              <details>
                <summary>What was sent and what came back</summary>
                <pre className="smscfg__pre">
                  {result.request ? `${result.request.method} ${result.request.url}\n${Object.entries(result.request.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}${result.request.body ? `\n\n${result.request.body}` : ""}` : ""}
                  {result.response ? `\n\n← HTTP ${result.response.status}\n${result.response.body}` : ""}
                  {result.mapped ? `\n\nRead as: ${JSON.stringify(result.mapped, null, 2)}` : ""}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

/** Paste the provider's docs; AI fills the settings in. */
function AiFill({ onFill, onToast }: { onFill: (cfg: SmsProviderConfig, notes: string[]) => void; onToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const go = () => {
    setBusy(true);
    api
      .suggestSmsConfig({ docs })
      .then((r) => { onFill(r.config, r.notes); setNotes(r.notes); setOpen(false); }, (e) => onToast(e instanceof Error ? e.message : "AI couldn't read that"))
      .finally(() => setBusy(false));
  };
  return (
    <div className="smscfg__ai">
      {!open ? (
        <button type="button" className="btn-ghost sm" onClick={() => setOpen(true)}><SparkleIcon /> Fill in from the provider's API docs</button>
      ) : (
        <>
          <textarea className="smscfg__code" rows={6} value={docs} onChange={(e) => setDocs(e.target.value)} placeholder="Paste the provider's API documentation or OpenAPI spec — the parts about sending SMS, incoming messages and delivery reports" />
          <div className="smscfg__inline">
            <button type="button" className="btn-primary" disabled={busy || docs.trim().length < 40} onClick={go}>{busy ? "Reading the docs…" : "Suggest settings"}</button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          <p className="fieldhint">A suggestion only — check it and send a test before connecting.</p>
        </>
      )}
      {notes.length > 0 && (
        <ul className="smscfg__notes">
          {notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

const labelFor = (name: string) => name.replace(/_/g, " ").replace(/\b(id|sid)\b/gi, (m) => m.toUpperCase()).replace(/^./, (c) => c.toUpperCase());

