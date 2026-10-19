import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Contact, Inbox } from "@ding/schemas";
import { startedAlongside, useContacts, useInboxes } from "../hooks";
import { api } from "../lib/api";
import { channelMeta, XIcon, BackIcon, PhoneIcon, SearchIcon } from "../lib/icons";
import { useScrollLock } from "../lib/useScrollLock";
import { useHoverGlide } from "../lib/useHoverGlide";
import { Avatar } from "./Avatar";

type Channel = "whatsapp" | "email" | "sms";

/** A channel's glyph in its brand colour — the per-customer "reachable on" cue. */
function ChanIcon({ channel }: { channel: Channel }) {
  const cm = channelMeta(channel);
  const Glyph = cm.Glyph;
  return (
    <span className="compose__chico" style={{ color: cm.color }} title={cm.label}>
      <Glyph />
    </span>
  );
}

/** A phone number on file. Neutral on purpose: a number may only take texts,
 *  so it says "phone", and WhatsApp's mark sits beside it only for someone
 *  known to be on WhatsApp. */
function PhoneMark() {
  return (
    <span className="compose__chico compose__chico--phone" title="Phone">
      <PhoneIcon />
    </span>
  );
}

/** One channel a customer can be started on (disabled when they lack the address). */
function ChannelPick({
  channel,
  disabled,
  busy,
  hint,
  onPick,
}: {
  channel: Channel;
  disabled: boolean;
  busy: boolean;
  hint: string;
  onPick: () => void;
}) {
  const cm = channelMeta(channel);
  const Glyph = cm.Glyph;
  return (
    <button type="button" className="compose__chan" disabled={disabled || busy} onClick={onPick}>
      <span className="compose__chanic" style={{ background: cm.color }}>
        <Glyph />
      </span>
      <span className="compose__chanm">
        <b>{cm.label}</b>
        <small>{busy ? "Opening…" : disabled ? "No address on file" : hint}</small>
      </span>
    </button>
  );
}

/**
 * Start a brand-new outbound conversation: pick an existing customer (or add
 * one), then choose the channel to reach them on. Delegates to the shared
 * find-or-create "reach" endpoint, then opens the resulting thread.
 */
export function Compose({
  onClose,
  onOpen,
  onToast,
  onNewGroup,
}: {
  onClose: () => void;
  onOpen: (id: string) => void;
  onToast: (msg: string) => void;
  /** Switch to the "new WhatsApp group" flow (invite-only group creation). */
  onNewGroup?: () => void;
}) {
  const { data: contacts } = useContacts();
  const { data: inboxes } = useInboxes();
  const boxRef = useRef<HTMLDivElement>(null);
  useScrollLock(boxRef);
  const { containerRef: listRef, thumbRef: glideRef, hoverProps: listHover } = useHoverGlide<HTMLDivElement>(".compose__row", "xy");
  const [tab, setTab] = useState<"pick" | "new">("pick");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Contact | null>(null);
  const [busy, setBusy] = useState<Channel | null>(null);
  // When a channel has several connected inboxes, the user picks which to send from.
  const [pickInboxFor, setPickInboxFor] = useState<Channel | null>(null);
  const inboxesFor = (ch: Channel): Inbox[] => (inboxes ?? []).filter((i) => i.type === ch);
  // New-customer fields.
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const filtered = (contacts ?? [])
    .filter((c) => {
      const s = q.trim().toLowerCase();
      if (!s) return true;
      return [c.displayName, c.company, c.email, c.phone].some((v) => (v ?? "").toLowerCase().includes(s));
    })
    .slice(0, 50);

  const start = async (contact: Contact, channel: Channel, inboxId?: string) => {
    setBusy(channel);
    try {
      const { conversationId, alsoOpenWith } = await api.reachContact(contact.id, channel, inboxId);
      if (alsoOpenWith) onToast(startedAlongside(contact.displayName, alsoOpenWith));
      onOpen(conversationId);
    } catch {
      const need = channel === "email" ? "an email address" : "a phone number";
      onToast(`Couldn't start ${channelMeta(channel).label} — the customer needs ${need} and a connected inbox.`);
      setBusy(null);
    }
  };

  const createAndStart = async (channel: Channel, inboxId?: string) => {
    if (!name.trim()) {
      onToast("Give the customer a name first.");
      return;
    }
    setBusy(channel);
    try {
      const { contact } = await api.createContact({
        displayName: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
      });
      const { conversationId, alsoOpenWith } = await api.reachContact(contact.id, channel, inboxId);
      if (alsoOpenWith) onToast(startedAlongside(contact.displayName, alsoOpenWith));
      onOpen(conversationId);
    } catch {
      onToast("Couldn't start that conversation. Check the details and try again.");
      setBusy(null);
    }
  };

  const emailHint = "Write a new email";
  // Nothing says a number is on WhatsApp until they've written from it.
  const waHint = (known: boolean) => (known ? "Pick an approved template" : "Pick an approved template — if they use WhatsApp");

  // Channel buttons — but when a channel has several connected inboxes, first let
  // the user choose which one to send from. Shared by the existing/new flows.
  const chooseChannel = (ch: Channel, onStart: (ch: Channel, inboxId?: string) => void) => {
    const list = inboxesFor(ch);
    if (list.length > 1) setPickInboxFor(ch);
    else onStart(ch, list[0]?.id);
  };
  const renderChannels = (
    canPhone: boolean,
    knownOnWhatsApp: boolean,
    canEmail: boolean,
    onStart: (ch: Channel, inboxId?: string) => void,
  ) => {
    if (pickInboxFor) {
      const list = inboxesFor(pickInboxFor);
      const label = pickInboxFor === "whatsapp" ? "WhatsApp number" : pickInboxFor === "sms" ? "SMS number" : "email inbox";
      return (
        <div className="compose__inboxes">
          <button type="button" className="compose__back" onClick={() => setPickInboxFor(null)}>
            <BackIcon /> Back
          </button>
          <p className="compose__inboxlead">Send from which {label}?</p>
          {list.map((i) => (
            <button
              type="button"
              key={i.id}
              className="compose__inbox"
              disabled={busy != null}
              onClick={() => onStart(pickInboxFor, i.id)}
            >
              <ChanIcon channel={pickInboxFor} />
              <span className="compose__inboxm">
                <b>{i.name}</b>
                <small>{i.handle}</small>
              </span>
            </button>
          ))}
        </div>
      );
    }
    return (
      <div className="compose__chans">
        {/* WhatsApp and SMS both go to the phone number, each only where
            there's a channel of that kind to send it from. */}
        {inboxesFor("whatsapp").length > 0 && (
          <ChannelPick channel="whatsapp" disabled={!canPhone} busy={busy === "whatsapp"} hint={waHint(knownOnWhatsApp)} onPick={() => chooseChannel("whatsapp", onStart)} />
        )}
        {inboxesFor("sms").length > 0 && (
          <ChannelPick channel="sms" disabled={!canPhone} busy={busy === "sms"} hint="Send a text message" onPick={() => chooseChannel("sms", onStart)} />
        )}
        <ChannelPick channel="email" disabled={!canEmail} busy={busy === "email"} hint={emailHint} onPick={() => chooseChannel("email", onStart)} />
      </div>
    );
  };

  return createPortal(
    <div className="modal" onClick={onClose}>
      <div className="modal__box compose" ref={boxRef} onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>New message</h2>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>

        {selected ? (
          // ── Step 2: choose the channel to reach the picked customer on ──
          <div className="modal__body">
            <button type="button" className="compose__back" onClick={() => { setPickInboxFor(null); setSelected(null); }}>
              <BackIcon /> Choose a different customer
            </button>
            <div className="compose__who">
              <Avatar name={selected.displayName} email={selected.email} color={selected.avatarColor} className="compose__av" />
              <span className="compose__whom">
                <b>{selected.displayName}</b>
                {selected.company && <small>{selected.company}</small>}
              </span>
            </div>
            {renderChannels(!!selected.phone, !!selected.onWhatsApp, !!selected.email, (ch, inboxId) => start(selected, ch, inboxId))}
          </div>
        ) : (
          <div className="modal__body">
            <div className="compose__tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "pick"} className={tab === "pick" ? "on" : ""} onClick={() => setTab("pick")}>
                Existing customer
              </button>
              <button type="button" role="tab" aria-selected={tab === "new"} className={tab === "new" ? "on" : ""} onClick={() => setTab("new")}>
                New customer
              </button>
            </div>

            {tab === "pick" ? (
              <>
                <div className="compose__search">
                  <SearchIcon />
                  <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers by name, organisation, email or phone…" aria-label="Search customers" />
                </div>
                <div className="compose__list" ref={listRef} {...listHover}>
                  <span className="glide" ref={glideRef} aria-hidden="true" />
                  {filtered.length === 0 ? (
                    <p className="compose__empty">No customers match — try “New customer”.</p>
                  ) : (
                    filtered.map((c) => (
                      <button type="button" key={c.id} className="compose__row" onClick={() => setSelected(c)}>
                        <Avatar name={c.displayName} email={c.email} color={c.avatarColor} className="compose__av" />
                        <span className="compose__rowm">
                          <b>{c.displayName}</b>
                          <small>{c.company || c.email || c.phone || ""}</small>
                        </span>
                        <span className="compose__rowchans">
                          {c.phone && <PhoneMark />}
                          {c.onWhatsApp && <ChanIcon channel="whatsapp" />}
                          {c.email && <ChanIcon channel="email" />}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="compose__new">
                <label className="field">
                  <span>Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" autoFocus />
                </label>
                <label className="field">
                  <span>Phone</span>
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44 7…" inputMode="tel" />
                </label>
                <label className="field">
                  <span>Email</span>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" inputMode="email" />
                </label>
                {renderChannels(!!phone.trim(), false, !!email.trim(), (ch, inboxId) => createAndStart(ch, inboxId))}
              </div>
            )}

            {onNewGroup && (
              <button type="button" className="compose__grouplink" onClick={onNewGroup}>
                Start a WhatsApp group instead →
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
