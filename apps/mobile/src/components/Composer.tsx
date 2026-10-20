import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { enter, exit, reflow } from "../motion";
import type { ChannelType, Contact, ConversationWithMessages, Macro, Message, TemplateFillContext } from "@ding/schemas";
import {
  autoTemplateParams,
  autoTemplateSlot,
  inboxLabel,
  isEmailAddress,
  macroQueryAt,
  mentionLabel,
  namesToHandles,
  replyTargetsFor,
  resolveTemplateDefault,
  searchMacros,
  sendingInbox,
  typingPingMs,
} from "@ding/schemas";
import {
  api,
  useContacts,
  useConversationMacros,
  useIntegrations,
  useInboxes,
  useMe,
  usePeople,
  useSendMessage,
  useShareConversation,
  useTemplatesForInbox,
  useTypingSignal,
  windowLeft,
} from "@ding/client";
import { useStagedAttachments } from "../attachments";
import { enqueue } from "../send-queue";
import { Avatar } from "./Avatar";
import { StagedAttachments } from "./StagedAttachments";
import { AlsoSendTo } from "./chat/Discuss";
import { AttachSheet } from "./AttachSheet";
import { TemplateSheet } from "./TemplateSheet";
import { MacroSheet } from "./MacroSheet";
import { RecipientInput } from "./RecipientInput";
import { mediaSource } from "../api-config";
import { VoiceRecorder } from "./VoiceRecorder";
import { HoldMic, HoldOverlay, useHoldToRecord } from "./HoldToRecord";
import { useVoiceRecording, type RecordedVoice } from "../voice";
import { useToast } from "./Toast";
import { useTheme } from "../theme";
import { haptics } from "../haptics";
import { useShrinkWhenEmpty } from "../shrink-when-empty";
import {
  AttachIcon,
  BoltIcon,
  MacroIcon,
  ClockIcon,
  EditIcon,
  EmojiIcon,
  ReplyIcon,
  SparkleIcon,
  XIcon,
  NoteIcon,
  SendIcon,
  channelMeta,
  AlertIcon,
} from "../icons";
import { Touchable } from "./Touchable";

/** The composer's own emoji row — the same curated set the web uses, so the two
 *  offer the same shortcuts. Deliberately not a picker dependency. */
const COMPOSER_EMOJIS = ["👍", "🙏", "😀", "😅", "🎉", "❤️", "✅", "👀", "🔥", "😬", "🤝", "📎"];

/** One Cc/Bcc line: its label, then the recipient field (with customer suggestions). */
function AddressRow({
  label,
  value,
  onChange,
  contacts,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  contacts: Contact[];
}) {
  const { c } = useTheme();
  return (
    <View className="flex-row items-start gap-2">
      <Text style={{ color: c.textFaint, width: 34, paddingTop: 3 }} className="text-2xs font-semibold uppercase tracking-wide">
        {label}
      </Text>
      <View className="min-w-0 flex-1">
        <RecipientInput compact value={value} onChange={onChange} contacts={contacts} label={`${label} recipients`} placeholder="Search customers or type an email" />
      </View>
    </View>
  );
}

/**
 * The reply box — the mobile reading of the web's `.composer`.
 *
 * Structure is deliberately the web's, not a fresh idea:
 *
 *  - a `compmode` segmented control with one tab per channel the customer is
 *    reachable on, each carrying its own channel glyph, then a Note tab;
 *  - a context line that says where this is going and, on WhatsApp, how long
 *    the 24-hour window has left;
 *  - an input row with the same tools in the same order — emoji, template,
 *    attach — and one trailing button that is a mic until there's something to
 *    send, then becomes the send arrow.
 *
 * Reply and Note stay visibly different because they are two different acts: one
 * goes to the customer, the other to the team. The mistake that matters — a note
 * reaching the customer — should be hard to make by accident.
 */
export function Composer({
  conv,
  replyTo,
  onClearReply,
  ccPrefill,
}: {
  conv: ConversationWithMessages;
  /** The message this reply quotes, chosen by long-pressing a bubble. */
  replyTo?: Message | null;
  onClearReply?: () => void;
  /**
   * Addresses to copy, set by Reply all on an email.
   *
   * A *request* rather than a value: it seeds the Cc field and unfolds it, then
   * the agent owns what's in there. Bound as a `{ at, addresses }` token rather
   * than a bare array so pressing Reply all twice re-seeds — an array would be
   * a new identity on every render and would fight the typing.
   */
  ccPrefill?: { at: number; addresses: string[] } | null;
}) {
  const { c } = useTheme();
  const send = useSendMessage();
  const { data: me } = useMe();
  // Tell the rest of the team we're writing. The throttling and the idle
  // "stopped" live in the hook, shared with the web, so the phone and the
  // browser can't drift into two different definitions of "is typing".
  const typing = useTypingSignal(conv.id, me?.user.name);
  // Last time we pinged WhatsApp's own typing indicator, which is a separate
  // thing: that one is shown to the *customer*. Each ping keeps it alive about
  // 25 seconds, so it is throttled far harder than the agent-facing one.
  const waTyping = useRef(0);
  // Narrowed to the WhatsApp account behind this conversation's number: a
  // template belongs to one account, and the fallback below sends by itself.
  const { data: templates } = useTemplatesForInbox(conv.inboxId);
  const toast = useToast();
  const inputRef = useRef<TextInput>(null);
  const [body, setBody] = useState("");
  // Back to one line once sent (see shrink-when-empty).
  const bodyBox = useShrinkWhenEmpty(body);
  const [internal, setInternal] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickedChannel, setPickedChannel] = useState<ChannelType | null>(null);
  const [attachSheet, setAttachSheet] = useState(false);
  const [templateSheet, setTemplateSheet] = useState(false);
  /** True only for the *locked*, hands-free panel. A held recording is not a
   *  mode — it lasts exactly as long as the thumb is down. */
  const [recording, setRecording] = useState(false);
  // One recorder, driven by the press-and-hold button and by the locked panel
  // alike, so sliding up to lock continues the take rather than starting a new
  // one.
  const voice = useVoiceRecording();
  // The hold's state lives up here because it is drawn in two places that
  // cannot be siblings: the microphone at the end of the row, and the recording
  // bar that has to span the row. See `useHoldToRecord`.
  const hold = useHoldToRecord({
    voice,
    onSend: () => void finishVoice(),
    onLock: () => setRecording(true),
  });
  /**
   * The email thread's subject, editable before every send.
   *
   * It's the thread's subject rather than this message's: changing it here
   * renames the thread, which is what the web does and what every mail client
   * does when you edit a subject mid-conversation. The server adds "Re:" on a
   * reply, so this holds the verbatim topic.
   */
  const [subject, setSubject] = useState(conv.subject ?? "");
  const [editingSubject, setEditingSubject] = useState(false);
  /** Cc/Bcc stay folded away until asked for — most replies need neither, and
   *  two more fields above a phone keyboard is most of the screen. */
  const [showCc, setShowCc] = useState(false);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  // Customers with an email, suggested in Cc/Bcc as you type.
  const { data: contacts } = useContacts();
  /** From tapping send on a recording until it lands — the recorder is gone by
   *  then, so without this there is nothing on screen saying it's in flight. */
  const [sendingVoice, setSendingVoice] = useState(false);
  const files = useStagedAttachments();
  // A note can go on to a Team Chat as well, as a card quoting it.
  const [alsoTo, setAlsoTo] = useState<string | null>(null);
  const shareToChat = useShareConversation();
  // AI assist. Whether the button exists at all follows the workspace's Claude
  // key — an affordance that always fails is worse than one that isn't there.
  const aiConfigured = Boolean(useIntegrations().data?.anthropic?.configured);
  const [polishing, setPolishing] = useState(false);
  // The draft as it stood before the last polish, so one tap puts it back. It
  // also carries what Claude returned, so Undo can hide itself the moment the
  // agent edits — restoring then would throw that edit away.
  const [prePolish, setPrePolish] = useState<{ text: string; polished: string } | null>(null);

  // ─── @-mention autocomplete (internal notes) ───
  const { data: people } = usePeople();
  // Teammates as @mentions: who "@Nathan A" means when the note is sent.
  const mentionPeople = useMemo(() => (people ?? []).map((m) => m.user), [people]);
  /** The "@query" currently being typed, and where its "@" sits in the draft. */
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  /**
   * Where the caret was before the current keystroke.
   *
   * A web `<input>` hands you `selectionStart` on the change event; React
   * Native's `onChangeText` gives you the text and nothing else, and
   * `onSelectionChange` fires separately with no guaranteed order. So the caret
   * is tracked here on every selection change — taps and arrow keys included —
   * and the position after an edit is that plus the change in length. Exact for
   * a single-point edit, which is all a keyboard produces.
   */
  const caretRef = useRef(0);
  /** Set for exactly one render, to move the caret after inserting a mention.
   *  Left uncontrolled the rest of the time — a permanently controlled
   *  `selection` fights the Android keyboard's own cursor handling. */
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  // ─── Macros (saved replies) ───
  // This chat's team inbox's macros plus every team's — the server decides.
  const { data: macros } = useConversationMacros(conv.id, conv.assignedTeamId);
  /** The "/shortcut" being typed in a reply, and where its "/" sits. */
  const [slash, setSlash] = useState<{ query: string; start: number } | null>(null);
  const [macroSheet, setMacroSheet] = useState(false);

  // Which channels this customer is reachable on inside this thread — shared
  // with the web so the phone and the desktop can't drift apart on it.
  const isGroup = conv.channel === "whatsapp_group";
  const inboxes = useInboxes();
  const replyTargets = useMemo<ChannelType[]>(
    () => replyTargetsFor(conv, (inboxes.data ?? []).map((i) => i.type)),
    [conv.channel, conv.contact.phone, conv.contact.email, inboxes.data],
  );

  // Default to the channel the customer last used, not the one the thread was
  // opened on — that's the address they're actually watching.
  const lastUsed = useMemo(() => {
    const m = [...conv.messages].reverse().find((x) => x.direction === "in" && !x.internal);
    return (m?.channel ?? conv.lastChannel ?? conv.channel) as ChannelType;
  }, [conv.messages, conv.lastChannel, conv.channel]);
  const defaultChannel = !isGroup && replyTargets.includes(lastUsed) ? lastUsed : conv.channel;
  const channel = (!isGroup && pickedChannel) || defaultChannel;

  const isWhatsApp = channel === "whatsapp" || channel === "whatsapp_group";
  const isEmail = channel === "email";

  // Which of our numbers/addresses this reply will go from. Worth saying on a
  // phone as much as on a desktop: switching the mode tabs above to WhatsApp on
  // an email thread quietly changes which number the customer hears from, and
  // nothing else on the screen would show it. Resolved with the same function
  // the server sends with, so this can't promise one number and the send use
  // another.
  const fromInbox = useMemo(
    () => sendingInbox(inboxes.data ?? [], conv, { channel }),
    [inboxes.data, conv.inboxId, conv.channel, channel],
  );

  // Follow the thread's subject: it changes when this screen opens on another
  // conversation, and when a teammate renames the thread from the web. Keyed on
  // the value, not the object, so an ordinary refetch that returns the same
  // subject never interrupts an edit in progress.
  useEffect(() => {
    setSubject(conv.subject ?? "");
  }, [conv.id, conv.subject]);

  // Reply all: seed the Cc and open the row so what's about to happen is
  // visible before sending, not after. Keyed on the token's timestamp so a
  // second Reply all re-seeds even if the addresses are identical.
  useEffect(() => {
    if (!ccPrefill) return;
    setCc(ccPrefill.addresses.map((a) => a.toLowerCase()));
    setShowCc(true);
  }, [ccPrefill?.at]);
  const windowOpen = conv.waWindow?.open ?? false;
  const windowClosed = isWhatsApp && !windowOpen;
  const msLeft = conv.waWindow?.expiresAt ? new Date(conv.waWindow.expiresAt).getTime() - Date.now() : null;
  const closingSoon = msLeft != null && msLeft < 60 * 60 * 1000;

  // Closed window: fall back to this account's default single-variable template,
  // so what the agent typed still goes out as the message body. Per account,
  // because another account's default is one Meta would reject — chosen
  // automatically, with nobody having picked it. `useTemplatesForInbox` has
  // already narrowed the list to this conversation's account.
  // It needs exactly one variable without a saved default — that one is the
  // message; the others (the agent's name, say) fill themselves in.
  const defaultTemplate = templates?.find((t) => t.isDefault && autoTemplateSlot(t) !== null) ?? null;
  const templateFill: TemplateFillContext = {
    contactName: conv.contact.displayName,
    contactCompany: conv.contact.company,
    contactPhone: conv.contact.phone,
    contactEmail: conv.contact.email,
    agentName: me?.user.name,
    channelName: inboxes.data?.find((i) => i.id === conv.inboxId)?.name,
  };
  const templateFallback = windowClosed && !internal && !!defaultTemplate;
  const locked = windowClosed && !internal && !defaultTemplate;

  // An attachment on its own is a message — "here's the invoice" needs no words.
  const hasContent = body.trim().length > 0 || files.readyIds.length > 0;
  const canSend = hasContent && !send.isPending && !locked && !files.uploading;
  // The mic stands in for send while there's nothing to send — WhatsApp's own
  // arrangement. Only on a voice-capable WhatsApp reply, and only once wired.
  const showMic = isWhatsApp && !internal && !hasContent;

  async function submit() {
    // A note's "@Nathan A" goes out as "@nathan", the handle that notifies them.
    const text = internal ? namesToHandles(body.trim(), mentionPeople) : body.trim();
    if ((!text && !files.readyIds.length) || locked) {
      // Refused rather than ignored: outside the WhatsApp window there *is* a
      // reason, and a dead button with no feedback reads as a broken one.
      if (locked) haptics.warning();
      return;
    }
    // A Cc/Bcc chip that isn't an address: said here, not by a bounce later.
    const badCopy = isEmail && !internal ? [...cc, ...bcc].find((a) => !isEmailAddress(a)) : undefined;
    if (badCopy) {
      haptics.warning();
      setError(`“${badCopy}” isn't a valid email address — fix or remove it in Cc/Bcc.`);
      return;
    }
    setError(null);
    setEmojiOpen(false);
    setPrePolish(null);
    setMention(null);
    setSlash(null);
    setEditingSubject(false);
    // The email fields, resolved once so the send and the offline queue agree.
    const email = emailFields();
    // Clear optimistically — the message is already on screen via useSendMessage,
    // and leaving the text behind invites an accidental double-send.
    setBody("");
    // Say we've stopped now rather than letting the 2.5s idle timer say it: the
    // message itself is about to arrive, and a colleague watching "Nathan is
    // typing…" sit under a message he has already sent looks like a bug.
    typing.stop();
    const sendOnTo = internal ? alsoTo : null;
    try {
      const sent = await send.mutateAsync({
        id: conv.id,
        body: text,
        internal,
        ...(internal ? {} : { channel }),
        ...(templateFallback
          ? { template: { id: defaultTemplate!.id, params: autoTemplateParams(defaultTemplate!, text || "(attachment)", templateFill)! } }
          : {}),
        // A note goes to the team, so it can't quote a customer message out.
        ...(replyTo && !internal ? { quotedMsgId: replyTo.id } : {}),
        ...(files.readyIds.length ? { attachmentIds: files.readyIds } : {}),
        ...email,
      });
      // Cc/Bcc are per-message, the way they are in a mail client: carrying them
      // into the next reply silently would copy people nobody asked for. The
      // subject stays — it belongs to the thread.
      setCc([]);
      setBcc([]);
      setShowCc(false);
      haptics.success();
      files.clear();
      onClearReply?.();
      if (sendOnTo && sent) {
        setAlsoTo(null);
        shareToChat.mutate(
          { roomId: sendOnTo, conversationId: conv.id, messageId: sent.id, body: "" },
          { onError: () => setError("The note was saved, but couldn't be sent on to the chat.") },
        );
      }
    } catch (err) {
      // A 4xx means the server looked at it and refused — the agent needs to see
      // that and change something, so the text goes back in the box. Anything
      // else is the network, and a reply written on the Tube should not be lost
      // because the tunnel was long: it goes on the durable queue instead, and
      // leaves the box empty because it is genuinely going to be sent.
      const status = (err as { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        haptics.error();
        setBody(text);
        setError(err instanceof Error ? err.message : "Couldn't send — try again.");
        return;
      }
      // Queued, not lost — which is a success from where the agent is sitting,
      // so it feels like one.
      haptics.success();
      await enqueue({
        conversationId: conv.id,
        body: text,
        internal,
        ...(internal ? {} : { channel }),
        ...(templateFallback
          ? { template: { id: defaultTemplate!.id, params: autoTemplateParams(defaultTemplate!, text || "(attachment)", templateFill)! } }
          : {}),
        ...(replyTo && !internal ? { quotedMsgId: replyTo.id } : {}),
        ...(files.readyIds.length ? { attachmentIds: files.readyIds } : {}),
        // The subject and recipients have to survive on the queue too: a reply
        // written on the Tube is sent hours later, from a process that has none
        // of this component's state left.
        ...email,
      });
      setCc([]);
      setBcc([]);
      setShowCc(false);
      files.clear();
      onClearReply?.();
    }
  }

  /**
   * Subject and recipients for an email send, or nothing at all.
   *
   * Only an outbound email carries them — a note goes to the team and a
   * WhatsApp reply has no such fields, and sending an empty `subject` on either
   * would rename the thread to nothing.
   */
  function emailFields(): { subject?: string; cc?: string[]; bcc?: string[] } {
    if (!isEmail || internal) return {};
    const ccList = cc;
    const bccList = bcc;
    return {
      subject: subject.trim(),
      ...(ccList.length ? { cc: ccList } : {}),
      ...(bccList.length ? { bcc: bccList } : {}),
    };
  }

  /**
   * Teammates matching the open "@query" — empty unless one is being typed.
   *
   * Notes only. A customer can't be @-mentioned: the token is what routes the
   * note into a teammate's Mentions inbox, and there is no such inbox for
   * someone outside the workspace.
   */
  const mentionList =
    mention && internal
      ? (people ?? [])
          .map((m) => m.user)
          .filter((u) => {
            const q = mention.query.toLowerCase();
            if (!q) return true;
            return (
              u.name.toLowerCase().includes(q) || u.email.split("@")[0].toLowerCase().includes(q)
            );
          })
          .slice(0, 5)
      : [];

  /** Every keystroke in the note field: keep the draft, then decide whether an
   *  "@token" is open at the caret. */
  function onBodyChange(next: string) {
    const caret = Math.max(0, Math.min(next.length, caretRef.current + (next.length - body.length)));
    setBody(next);
    // A note goes to the team, not the customer, so it neither broadcasts
    // presence on the conversation nor pokes the channel.
    if (!internal) {
      typing.signal();
      const t = Date.now();
      // Channels that show the customer an indicator, at their own cadence.
      const pingEvery = typingPingMs(channel);
      if (pingEvery != null && !locked && t - waTyping.current > pingEvery) {
        waTyping.current = t;
        void api.sendTyping(conv.id).catch(() => {});
      }
    }
    // Only ever matches when the "@" starts a word — an email address typed
    // into a note shouldn't open a people picker.
    const m = internal ? /(?:^|\s)@([\w.+-]*)$/.exec(next.slice(0, caret)) : null;
    setMention(m ? { query: m[1], start: caret - m[1].length - 1 } : null);
    // "/" in a reply looks up a macro. Not in a note — nobody is sent a note.
    setSlash(!internal && macros?.length ? macroQueryAt(next, caret) : null);
  }

  /** What the open "/query" matches, best first. */
  // All of them, in a strip that scrolls — "/" alone shows every macro this chat has.
  const slashList = slash && !internal ? searchMacros(macros ?? [], slash.query) : [];

  /**
   * Put a macro in the reply box with its placeholders filled for this chat.
   * From "/" it replaces what was typed; from the sheet it goes in at the
   * caret. It's a draft — read it, change it, then Send as usual (and on a
   * closed WhatsApp window that Send goes through the default template).
   */
  function insertMacro(m: Macro) {
    const filled = resolveTemplateDefault(m.body, templateFill);
    const from = slash ? slash.start : Math.min(caretRef.current, body.length);
    const to = slash ? slash.start + 1 + slash.query.length : from;
    const next = body.slice(0, from) + filled + body.slice(to);
    const caret = from + filled.length;
    setBody(next);
    setSlash(null);
    setMacroSheet(false);
    caretRef.current = caret;
    setSelection({ start: caret, end: caret });
    haptics.tap();
    inputRef.current?.focus();
  }

  /**
   * Replace the open "@query" with the teammate's handle.
   *
   * The handle is the local part of their email, lower-cased — the same token
   * the web inserts and the same one the server matches when it decides whose
   * Mentions inbox this note belongs in. A display name would read better and
   * route nowhere.
   */
  function insertMention(u: { name: string; email: string }) {
    if (!mention) return;
    // The name, not the handle: "@Nathan A" reads as a person. It becomes
    // "@nathan" (what the server routes by) only when the note is sent.
    const handle = mentionLabel(u, mentionPeople) + " ";
    const before = body.slice(0, mention.start);
    const after = body.slice(mention.start + 1 + mention.query.length);
    const next = before + handle + after;
    const caret = (before + handle).length;
    setBody(next);
    setMention(null);
    caretRef.current = caret;
    setSelection({ start: caret, end: caret });
    inputRef.current?.focus();
  }

  /* ─── AI assist: one-tap Polish ───────────────────────────────────
     Polish only rewrites what the agent has already typed. It never sends, and
     never writes a reply of its own — the words going to the customer are still
     theirs, tidied. The pre-polish draft is kept so Undo restores it exactly. */
  async function runPolish() {
    const draft = body.trim();
    if (!draft || polishing) return;
    setPolishing(true);
    setError(null);
    try {
      const res = await api.polishDraft({
        text: draft,
        channel: internal ? undefined : channel,
        internal,
        conversationId: conv.id,
      });
      if (!res.changed) {
        toast({ text: "That already reads well — nothing to polish" });
        return;
      }
      setPrePolish({ text: body, polished: res.text });
      setBody(res.text);
      haptics.success();
    } catch (err) {
      // The API client forwards the server's own message, which is written for
      // an agent to act on ("Claude rejected the API key — check it in
      // Settings") rather than a status code to decipher.
      haptics.error();
      toast({
        text: err instanceof Error && err.message ? err.message : "Couldn't polish that draft",
        tone: "error",
      });
    } finally {
      setPolishing(false);
    }
  }

  function undoPolish() {
    if (!prePolish) return;
    setBody(prePolish.text);
    setPrePolish(null);
  }

  // Offer Undo only while the draft is still exactly what Polish produced —
  // once the agent has edited it, putting the old one back would lose that.
  const canUndoPolish = !!prePolish && body.trim() === prePolish.polished.trim();
  // The offer itself: only with a draft to work on, and only once the workspace
  // has a Claude key. Hidden while recording, where there is no draft anyway.
  const canPolish = aiConfigured && !locked && body.trim().length > 0;

  /** A finished voice note: stage it, wait for the upload, then send it on its
   *  own. Unlike a picked file it isn't left in the tray — you recorded it to
   *  say something now, not to attach it to a sentence you haven't written. */
  /**
   * Stop the recorder and send what it produced.
   *
   * Both routes end here — releasing the held microphone, and pressing send on
   * the locked panel — because both are the same act. `stop()` returns null for
   * a recording too short to be a message (a fumbled tap on the mic), and that
   * is a silent discard rather than an error: nothing was said.
   */
  async function finishVoice() {
    setRecording(false);
    const v = await voice.stop();
    if (v) await sendVoice(v);
  }

  async function sendVoice(v: RecordedVoice) {
    setRecording(false);
    setError(null);
    // Uploading a clip takes real seconds on a phone connection, and the
    // recorder has already gone. Without this the composer sits there looking
    // untouched, which reads as "it didn't send" — and then gets tapped again.
    setSendingVoice(true);
    // One name for both the part and the stored file, rather than two
    // `Date.now()` calls a millisecond apart that disagree.
    const name = `voice-${Date.now()}.m4a`;
    try {
      const attachment = await api.uploadMedia(
        { uri: v.uri, name, type: "audio/mp4" },
        { kind: "voice", durationMs: v.durationMs, filename: name },
      );
      await send.mutateAsync({
        id: conv.id,
        body: "",
        internal: false,
        channel,
        attachmentIds: [attachment.id],
        ...(replyTo ? { quotedMsgId: replyTo.id } : {}),
      });
      haptics.success();
      onClearReply?.();
    } catch (err) {
      haptics.error();
      setError(err instanceof Error ? err.message : "Couldn't send the voice note.");
    } finally {
      setSendingVoice(false);
    }
  }

  /** The context line: who this reaches, or the live window state. */
  function ctx() {
    if (internal) return { text: "Only your team can see this", tone: c.textMuted, dot: false };
    if (isEmail) return { text: `Email · ${conv.contact.displayName}`, tone: c.textMuted, dot: false };
    if (isWhatsApp && windowOpen && msLeft != null)
      return {
        text: `${closingSoon ? "Window closing" : "Window open"} · ${windowLeft(msLeft)} left`,
        tone: closingSoon ? c.amber : c.brandStrong,
        dot: true,
      };
    if (isWhatsApp && windowClosed)
      return { text: "24-hour window closed", tone: c.amber, dot: true };
    return {
      // Named from the channel actually being composed on. It used to say
      // "WhatsApp" for anything that wasn't email or a group, which told a
      // NestChat visitor's thread it was about to send to WhatsApp.
      text: `${isGroup ? "Group" : channelMeta(channel).label} · ${conv.contact.displayName}`,
      tone: c.textMuted,
      dot: false,
    };
  }
  const ctxLine = ctx();

  /**
   * One tab of the mode switcher.
   *
   * Only the selected tab spells out its name. Three labelled tabs plus the
   * window countdown do not fit across a phone — something has to give, and a
   * label you can't read is worth less than a glyph you can. The glyphs are the
   * channels' own marks, so an unlabelled tab still says which channel it is,
   * and the label appears the moment you select it.
   */
  function ModeTab({
    active,
    label,
    tint,
    children,
    onPress,
  }: {
    active: boolean;
    label: string;
    tint: string;
    children: React.ReactNode;
    onPress: () => void;
  }) {
    return (
      <Touchable feel="chip"
        onPress={onPress}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        hitSlop={{ top: 9, bottom: 9, left: 2, right: 2 }}
        // The thumb: the active tab carries the raised surface, the rest are
        // bare. Same read as the web's sliding seg-thumb without animating a
        // measured offset on every layout.
        style={{ backgroundColor: active ? c.surface : "transparent" }}
        className={`flex-row items-center gap-1.5 rounded-full py-1.5 ${active ? "px-3" : "px-2.5"}`}
      >
        {children}
        {active ? (
          <Text style={{ color: tint }} className="text-sm font-semibold">
            {label}
          </Text>
        ) : null}
      </Touchable>
    );
  }

  return (
    <View style={{ backgroundColor: c.surface, borderTopColor: c.border }} className="border-t px-3 pb-2 pt-2.5">
      {/* compbar: the mode switcher, then the context line. */}
      <View className="flex-row items-center gap-2 pb-2">
        <View style={{ backgroundColor: c.surface2 }} className="flex-row items-center rounded-full p-0.5">
          {replyTargets.map((ch) => {
            const meta = channelMeta(ch);
            const Glyph = meta.Glyph;
            const active = !internal && channel === ch;
            const tint = c[meta.colorKey];
            return (
              <ModeTab
                key={ch}
                active={active}
                tint={tint}
                label={replyTargets.length > 1 ? meta.label.replace("WhatsApp group", "Group") : "Reply"}
                onPress={() => {
                  setInternal(false);
                  setPickedChannel(ch);
                  // A half-typed "@sam" isn't a mention on a customer reply.
                  setMention(null);
                  setSlash(null);
                }}
              >
                <Glyph size={15} color={active ? tint : c.textFaint} />
              </ModeTab>
            );
          })}
          <ModeTab
            active={internal}
            tint={c.amber}
            label="Note"
            onPress={() => {
              setInternal(true);
              setEmojiOpen(false);
            }}
          >
            <NoteIcon size={15} color={internal ? c.amber : c.textFaint} />
          </ModeTab>
        </View>

        <View className="min-w-0 flex-1 flex-row items-center justify-end gap-1">
          {!internal && fromInbox ? (
            <Text
              style={{ color: c.textFaint }}
              className="shrink text-2xs"
              numberOfLines={1}
            >
              From {inboxLabel(fromInbox)} ·
            </Text>
          ) : null}
          {ctxLine.dot ? (
            <View
              style={{ backgroundColor: ctxLine.tone }}
              className="h-1.5 w-1.5 flex-none rounded-full"
            />
          ) : null}
          {/* Truncating this line loses the number, which is the only part that
              matters — so it shrinks to fit rather than being cut off. */}
          <Text
            style={{ color: ctxLine.tone }}
            className="shrink text-2xs font-medium"
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
          >
            {ctxLine.text}
          </Text>
        </View>
      </View>

      {/* An email's envelope: subject, and Cc/Bcc on request.

          Same place and same order as the web's `.emailhdr`, directly under the
          mode switcher — the fields that decide what this message *is* sit above
          the field where you write it, the way every mail client arranges them.
          Only on an outbound email: a note has no recipients and WhatsApp has no
          subject. */}
      {isEmail && !internal ? (
        <View
          style={{ backgroundColor: c.surface2 }}
          className="mb-2 gap-1 rounded-12 px-3 py-2"
        >
          <View className="flex-row items-center gap-2">
            <Text style={{ color: c.textFaint }} className="text-2xs font-semibold uppercase tracking-wide">
              Subject
            </Text>
            {editingSubject ? (
              <TextInput
                value={subject}
                onChangeText={setSubject}
                placeholder="Add a subject"
                placeholderTextColor={c.textFaint}
                autoFocus
                returnKeyType="done"
                onBlur={() => setEditingSubject(false)}
                onSubmitEditing={() => setEditingSubject(false)}
                accessibilityLabel="Email subject"
                style={{ color: c.text }}
                className="min-w-0 flex-1 p-0 text-sm font-semibold"
              />
            ) : (
              <Touchable feel="chip"
                onPress={() => {
                  haptics.tap();
                  setEditingSubject(true);
                }}
                accessibilityRole="button"
                accessibilityLabel={subject.trim() ? `Subject: ${subject.trim()}. Edit` : "Add a subject"}
                hitSlop={6}
                className="min-w-0 flex-1 flex-row items-center gap-1.5"
              >
                <Text
                  numberOfLines={1}
                  style={{ color: subject.trim() ? c.text : c.textFaint }}
                  className="min-w-0 flex-shrink text-sm font-semibold"
                >
                  {subject.trim() || "Add a subject"}
                </Text>
                <EditIcon size={13} color={c.textFaint} />
              </Touchable>
            )}
            <Touchable feel="chip"
              onPress={() => {
                haptics.tap();
                setShowCc((v) => !v);
              }}
              accessibilityRole="button"
              accessibilityLabel={showCc ? "Hide Cc and Bcc" : "Add Cc or Bcc"}
              accessibilityState={{ expanded: showCc }}
              hitSlop={8}
              style={{ backgroundColor: showCc ? c.brandTint : "transparent" }}
              className="flex-none rounded-full px-2 py-0.5"
            >
              <Text
                style={{ color: showCc ? c.brandStrong : c.textMuted }}
                className="text-2xs font-semibold"
              >
                Cc/Bcc
              </Text>
            </Touchable>
          </View>

          {showCc ? (
            <>
              <AddressRow label="Cc" value={cc} onChange={setCc} contacts={contacts ?? []} />
              <AddressRow label="Bcc" value={bcc} onChange={setBcc} contacts={contacts ?? []} />
            </>
          ) : null}
        </View>
      ) : null}

      {/* Window shut with a default template standing in: say what will actually
          be sent, rather than silently rewriting the agent's message. */}
      {templateFallback ? (
        <View
          style={{ backgroundColor: c.amberTint }}
          className="mb-2 flex-row items-center gap-2 rounded-12 px-3 py-2"
        >
          <ClockIcon size={15} color={c.amber} />
          <Text style={{ color: c.amber }} className="flex-1 text-2xs" numberOfLines={2}>
            Window closed — sending as{" "}
            <Text className="font-semibold">{defaultTemplate!.name}</Text>
          </Text>
        </View>
      ) : null}

      {locked ? (
        <View
          style={{ backgroundColor: c.amberTint }}
          className="mb-2 flex-row items-center gap-2 rounded-12 px-3 py-2.5"
        >
          <ClockIcon size={16} color={c.amber} />
          <Text style={{ color: c.amber }} className="flex-1 text-2xs">
            The 24-hour window has closed. Send an approved template to re-open the conversation.
          </Text>
        </View>
      ) : null}

      {/* What you're quoting, with a way out of it. Without this the quote is
          invisible until after you've sent, which is the wrong moment to find
          out you were replying to the wrong message. */}
      {replyTo && !internal ? (
        <View
          style={{ backgroundColor: c.surface2, borderLeftColor: c.brand }}
          className="mb-2 flex-row items-center gap-2 rounded-8 border-l-2 px-2.5 py-1.5"
        >
          <ReplyIcon size={14} color={c.brandStrong} />
          <View className="flex-1">
            <Text style={{ color: c.brandStrong }} className="text-2xs font-semibold">
              Replying to {replyTo.direction === "out" ? "yourself" : conv.contact.displayName}
            </Text>
            <Text numberOfLines={1} className="text-2xs text-muted">
              {replyTo.body?.trim() || "Attachment"}
            </Text>
          </View>
          <Touchable feel="chip"
            onPress={onClearReply}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            hitSlop={10}
            className="p-1"
          >
            <XIcon size={13} color={c.textMuted} />
          </Touchable>
        </View>
      ) : null}

      {/* AI assist lives in one slot with two states: the offer before, and what
          happened after. A pill rather than a fifth icon in the input row —
          four tools and a send button already leave a phone's width with about
          a dozen visible characters to type into. It appears with the draft it
          would act on, so it isn't sitting there doing nothing either. */}
      {canUndoPolish ? (
        <View className="mb-2 flex-row items-center gap-2 px-1">
          <SparkleIcon size={14} color={c.ai} />
          <Text style={{ color: c.textMuted }} className="flex-1 text-2xs">
            Polished by Claude
          </Text>
          <Touchable feel="chip"
            onPress={undoPolish}
            accessibilityRole="button"
            accessibilityLabel="Undo polish"
            hitSlop={8}
            className="rounded-8 px-2 py-0.5"
          >
            <Text style={{ color: c.brandStrong }} className="text-2xs font-semibold">
              Undo
            </Text>
          </Touchable>
        </View>
      ) : canPolish ? (
        <View className="mb-2 flex-row px-1">
          <Touchable feel="chip"
            onPress={() => void runPolish()}
            disabled={polishing}
            accessibilityRole="button"
            accessibilityLabel="Polish this draft with AI"
            accessibilityState={{ busy: polishing }}
            hitSlop={6}
            style={{ backgroundColor: c.surface2 }}
            className="flex-row items-center gap-1.5 rounded-full px-2.5 py-1"
          >
            {polishing ? (
              <ActivityIndicator size="small" color={c.ai} />
            ) : (
              <SparkleIcon size={14} color={c.ai} />
            )}
            <Text style={{ color: c.ai }} className="text-2xs font-semibold">
              {polishing ? "Polishing…" : "Polish"}
            </Text>
          </Touchable>
        </View>
      ) : null}

      {/* The people picker, directly above the field it's completing. A list
          rather than the web's floating popover: there's no room to float
          anything over a phone keyboard, and the sheet-like strip reads the
          same way the emoji row above does. */}
      {mentionList.length ? (
        <View
          style={{ backgroundColor: c.surface2, maxHeight: 208 }}
          className="mb-2 overflow-hidden rounded-16"
        >
          <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }}>
            {mentionList.map((u, i, arr) => (
              <Touchable feel="row"
                key={u.id}
                onPress={() => insertMention(u)}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${u.name}`}
                style={{ borderBottomColor: i === arr.length - 1 ? "transparent" : c.border }}
                className={`flex-row items-center gap-2.5 px-3 py-2 ${i === arr.length - 1 ? "" : "border-b"}`}
              >
                <Avatar name={u.name} color={u.avatarColor} photo={u.avatarUrl ? mediaSource(u.avatarUrl) : null} size={28} />
                <Text numberOfLines={1} className="flex-1 text-md font-medium text-fg">
                  {u.name}
                </Text>
                {u.position ? (
                  <Text numberOfLines={1} style={{ color: c.textFaint, maxWidth: "40%" }} className="text-2xs">
                    {u.position}
                  </Text>
                ) : null}
              </Touchable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Macros matching "/…", in the same strip as the people picker. */}
      {slashList.length ? (
        <View style={{ backgroundColor: c.surface2, maxHeight: 232 }} className="mb-2 overflow-hidden rounded-16">
          <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ flexShrink: 1 }}>
            {slashList.map((m, i, arr) => (
              <Touchable
                feel="row"
                key={m.id}
                onPress={() => insertMacro(m)}
                accessibilityRole="button"
                accessibilityLabel={`Insert ${m.name}`}
                style={{ borderBottomColor: i === arr.length - 1 ? "transparent" : c.border }}
                className={`px-3 py-2 ${i === arr.length - 1 ? "" : "border-b"}`}
              >
                <View className="flex-row items-center gap-2">
                  <Text numberOfLines={1} className="flex-1 text-md font-medium text-fg">
                    {m.name}
                  </Text>
                  {m.shortcut ? (
                    <Text style={{ color: c.brandStrong }} className="text-2xs font-semibold">
                      /{m.shortcut}
                    </Text>
                  ) : null}
                </View>
                <Text numberOfLines={1} style={{ color: c.textFaint }} className="text-xs">
                  {resolveTemplateDefault(m.body, templateFill)}
                </Text>
              </Touchable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {error ? <Text className="pb-1.5 text-sm text-danger">{error}</Text> : null}

      {emojiOpen ? (
        <Animated.ScrollView
          entering={enter.soft}
          exiting={exit.soft}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ backgroundColor: c.surface2 }}
          contentContainerStyle={{ paddingHorizontal: 6 }}
          className="mb-2 rounded-16 py-1.5"
        >
          {COMPOSER_EMOJIS.map((e) => (
            <Touchable feel="chip"
              key={e}
              onPress={() => {
                setBody((b) => b + e);
                inputRef.current?.focus();
              }}
              accessibilityRole="button"
              accessibilityLabel={`Insert ${e}`}
              className="px-2 py-1"
            >
              <Text className="text-xl">{e}</Text>
            </Touchable>
          ))}
        </Animated.ScrollView>
      ) : null}

      {/* While recording there is nothing else to do, so the recorder takes the
          input row's place rather than floating over it. */}
      {recording ? (
        <VoiceRecorder
          voice={voice}
          onSend={() => void finishVoice()}
          onCancel={() => {
            setRecording(false);
            void voice.cancel();
          }}
        />
      ) : sendingVoice ? (
        <View
          style={{ backgroundColor: c.surface2 }}
          className="flex-row items-center gap-3 rounded-24 px-4 py-3"
          accessibilityLabel="Sending voice message"
        >
          <ActivityIndicator size="small" color={c.brand} />
          <Text className="flex-1 text-md text-muted">Sending your voice note…</Text>
        </View>
      ) : (
      <>
      {!internal && fromInbox?.signedOut ? (
        // Said before the reply is written, not after it fails.
        <View style={{ backgroundColor: c.amberTint }} className="mb-2 flex-row items-start gap-2 rounded-12 px-3 py-2">
          <AlertIcon size={15} color={c.danger} />
          <Text className="flex-1 text-xs text-fg">
            {fromInbox.handle} needs reconnecting — Google signed it out, so replies from it can't be sent. An admin can reconnect it on the web, in Settings › Channels.
          </Text>
        </View>
      ) : null}
      <StagedAttachments items={files.staged} onRemove={files.remove} onRetry={files.retry} />
      {internal ? <AlsoSendTo value={alsoTo} onChange={setAlsoTo} /> : null}

      {/* compinput: tools left, field centre, one trailing action.

          `layout` is what stops the composer snapping. The field is multiline,
          so every time the draft wraps to a new line the row — and the whole
          message list above it — jumped by one line height, instantly. The web
          composer interpolates that growth; this one didn't.

          Animating the row's layout rather than a measured height on purpose:
          what a multiline TextInput reports through `onContentSizeChange`
          includes its padding on one platform and not the other, and guessing
          wrong clips the text — a worse bug than the snap. Letting the input
          size itself and animating the resulting layout change needs no
          measurement at all. `reflow` is the motion system's single
          re-layout curve, so this moves at the same speed as everything else
          that resizes. */}
      {/* A plain wrapper so the recording bar has something the width of the
          row to position against. It used to render inside the microphone, and
          React Native clips an absolute child to its parent — so the clock and
          the red dot were confined to the button's 35 points and appeared as a
          stub tucked underneath it. */}
      <View>
      <Animated.View
        layout={reflow}
        style={{ backgroundColor: c.surface2 }}
        className="flex-row items-end gap-1 rounded-24 px-1.5 py-1"
      >
        {/* Everything the recording state replaces, in one group so holding the
            microphone fades it out in a single step.

            This is what makes the recording hint able to be transparent, and
            transparency is what stops the microphone disappearing. The hint
            used to be an opaque bar drawn over the row — a second pill inside
            the row's own — and the button travels up to 120 points left as you
            slide to cancel, so no amount of clearance kept it out from under
            that bar. Hiding what's underneath instead means nothing is ever
            drawn on top of the button at all.

            `pointerEvents` goes with the opacity: an invisible text field that
            still takes touches is a trap. */}
        <View
          className="flex-1 flex-row items-end gap-1"
          style={{ opacity: hold.holding ? 0 : 1 }}
          pointerEvents={hold.holding ? "none" : "auto"}
        >
        <Touchable feel="chip"
          // The emoji row animates itself in and out (`enter.soft`/`exit.soft`
          // on the row above). This used to call `LayoutAnimation`, which does
          // nothing at all on the New Architecture — so the row has always
          // appeared instantly, while the code claimed otherwise.
          onPress={() => setEmojiOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel="Emoji"
          hitSlop={6}
          className="h-9 w-9 items-center justify-center rounded-full"
        >
          <EmojiIcon size={21} color={emojiOpen ? c.brandStrong : c.textMuted} />
        </Touchable>

        <TextInput
          ref={inputRef}
          value={body}
          onChangeText={onBodyChange}
          selection={selection}
          onSelectionChange={(e) => {
            caretRef.current = e.nativeEvent.selection.start;
            // Hand the caret straight back after a programmatic move, so the
            // keyboard owns it again from the next keystroke on.
            if (selection) setSelection(undefined);
          }}
          multiline
          editable={!locked}
          // Not "Message {name}…": with emoji, template, attach and send in the
          // row there isn't width for it, and it wrapped to a second line. The
          // header names the customer two lines above, so the name here was
          // costing a line to repeat something already on screen.
          placeholder={
            locked
              ? "Set a default template to reply"
              : internal
                ? "Note… @ to mention"
                : "Message…"
          }
          placeholderTextColor={c.textFaint}
          onLayout={bodyBox.onLayout}
          style={[{ color: c.text, maxHeight: 132 }, bodyBox.height]}
          className="flex-1 px-1 py-2 text-lg"
        />

        {!internal && !locked && macros?.length ? (
          <Touchable
            feel="chip"
            onPress={() => {
              setSlash(null);
              setMacroSheet(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Macros"
            hitSlop={6}
            className="h-9 w-9 items-center justify-center rounded-full"
          >
            <MacroIcon size={19} color={c.textMuted} />
          </Touchable>
        ) : null}

        {isWhatsApp && !internal ? (
          <Touchable feel="chip"
            onPress={() => setTemplateSheet(true)}
            accessibilityRole="button"
            accessibilityLabel="Templates"
            hitSlop={6}
          className="h-9 w-9 items-center justify-center rounded-full"
          >
            <BoltIcon size={19} color={c.textMuted} />
          </Touchable>
        ) : null}

        {/* A text message carries text: SMS has no attachments (a note does). */}
        {channel !== "sms" || internal ? (
          <Touchable feel="chip"
            onPress={() => setAttachSheet(true)}
            accessibilityRole="button"
            accessibilityLabel="Attach files"
            hitSlop={6}
            className="h-9 w-9 items-center justify-center rounded-full"
          >
            <AttachIcon size={20} color={c.textMuted} />
          </Touchable>
        ) : null}
        </View>

        {/* The trailing action. With nothing written it is a microphone you
            hold; the moment there is a draft it becomes send. This is the
            single most-watched pixel in the app — it sits directly under the
            thumb and changes on nearly every keystroke sequence — so the two
            cross-fade rather than swapping instantly. */}
        {showMic ? (
          <Animated.View key="mic" entering={enter.soft} exiting={exit.soft}>
            <HoldMic hold={hold} />
          </Animated.View>
        ) : (
          <Animated.View key="send" entering={enter.soft} exiting={exit.soft}>
            <Touchable feel="chip"
              onPress={submit}
              disabled={!canSend}
              haptic={canSend ? "tap" : undefined}
              accessibilityRole="button"
              accessibilityLabel={internal ? "Add note" : "Send reply"}
              hitSlop={4}
              // Keep the send button the same shape and colour whether or not it
              // can fire — a disabled white disc on the grey field reads as a
              // hole. It dims instead, which says "not yet" without vanishing.
              style={{
                backgroundColor: internal ? c.amber : c.brand,
                opacity: canSend ? 1 : 0.35,
              }}
              className="h-10 w-10 items-center justify-center rounded-full"
            >
              {send.isPending ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <SendIcon size={19} color="#fff" />
              )}
            </Touchable>
          </Animated.View>
        )}
      </Animated.View>
      {showMic ? <HoldOverlay hold={hold} voice={voice} /> : null}
      </View>
      </>
      )}

      <AttachSheet
        visible={attachSheet}
        onClose={() => setAttachSheet(false)}
        onCamera={() => void files.takePhoto()}
        onPhotos={() => void files.pickImages()}
        onFiles={() => void files.pickFiles()}
      />

      <MacroSheet
        macros={macros ?? []}
        fill={templateFill}
        visible={macroSheet}
        onPick={insertMacro}
        onClose={() => setMacroSheet(false)}
      />

      {/* `channel` rather than the conversation's own: in a cross-channel thread
          this is the composer's WhatsApp selection, and a template sent against
          an email-origin conversation would otherwise go out by email. */}
      <TemplateSheet
        conversationId={conv.id}
        inboxId={conv.inboxId}
        fill={{
          contactName: conv.contact.displayName,
          contactCompany: conv.contact.company,
          contactPhone: conv.contact.phone,
          contactEmail: conv.contact.email,
          agentName: me?.user.name,
        }}
        channel={channel}
        visible={templateSheet}
        onClose={() => setTemplateSheet(false)}
      />
    </View>
  );
}
