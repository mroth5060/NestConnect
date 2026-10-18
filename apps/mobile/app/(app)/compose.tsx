import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, ScrollView, Text, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { router } from "expo-router";
import { api, startedAlongside, useContacts, useInboxes } from "@ding/client";
import type { ChannelType, Contact, Inbox } from "@ding/schemas";
import { Avatar } from "../../src/components/Avatar";
import { Field } from "../../src/components/Field";
import { EmptyState } from "../../src/components/States";
import { BackIcon, SearchIcon, channelColor, channelMeta } from "../../src/icons";
import { haptics } from "../../src/haptics";
import { rowIn } from "../../src/motion";
import { useTheme } from "../../src/theme";
import { useInsets } from "../../src/insets";
import { Touchable } from "../../src/components/Touchable";
import { useToast } from "../../src/components/Toast";

type Channel = "whatsapp" | "email" | "sms";

/**
 * Start a conversation with someone who hasn't written in.
 *
 * The web has had this; the phone hadn't, which meant the one device an agent
 * actually has on them could only ever *answer*. Chasing a quote, confirming a
 * booking, following something up — all of it had to wait until they were back
 * at a desk.
 *
 * The shape is the web's `Compose` modal, in the order a phone wants it:
 *
 *  1. **Existing** or **New**, as two tabs. The web has had these since the
 *     start; the phone buried "add a customer" at the bottom of a list of fifty
 *     contacts, which meant the answer to "message someone new" was to scroll.
 *  2. Pick a customer (Existing) or type their details (New).
 *  3. Pick the channel — and, when several inboxes of that type are connected,
 *     which one to send from.
 *
 * New goes straight from the form to the channel buttons: filling in a name and
 * a number and tapping WhatsApp both creates the customer and opens the thread,
 * exactly as the web's `createAndStart` does. Making it a separate "save, then
 * find them again, then choose a channel" trip is two extra steps for the case
 * that is already the most typing.
 *
 * There is no "write the first message" step. `reachContact` opens the
 * customer's existing thread on that channel if they have one and creates it if
 * they don't, so this lands you in the normal thread screen with the normal
 * composer rather than asking you to write the first message in a form that
 * behaves differently from every other message you'll send. It also means
 * starting a conversation with someone you're already talking to can't fork
 * their thread.
 */
export default function Compose() {
  const insets = useInsets();
  const toast = useToast();
  const { c } = useTheme();
  const { data: contacts, isLoading } = useContacts();
  const { data: inboxes } = useInboxes();

  const [tab, setTab] = useState<"pick" | "new">("pick");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Contact | null>(null);
  const [busy, setBusy] = useState<Channel | null>(null);
  const [draft, setDraft] = useState({ name: "", phone: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  /** Set once a channel with several connected inboxes has been chosen, while
   *  we ask which of them to send from. */
  const [pickInboxFor, setPickInboxFor] = useState<Channel | null>(null);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const all = contacts ?? [];
    if (!q) return all.slice(0, 50);
    return all
      .filter((x) =>
        [x.displayName, x.company, x.phone, x.email].some((f) => f?.toLowerCase().includes(q)),
      )
      .slice(0, 50);
  }, [contacts, q]);

  /** Connected inboxes of a type — the ones we could actually send from. */
  const inboxesFor = (ch: Channel): Inbox[] =>
    (inboxes ?? []).filter((i) => i.type === ch && i.connected);

  /**
   * Whether we could actually send on a channel.
   *
   * Two things have to be true and they fail differently: the customer needs an
   * address, and we need a connected inbox of that type to send from. Saying
   * which one is missing is the difference between a fixable message and a
   * dead end.
   */
  const reason = (address: string | null | undefined, channel: Channel): string | null => {
    if (!address?.trim()) return channel === "email" ? "No email address" : "No phone number";
    if (!inboxesFor(channel).length) return `No ${channelMeta(channel).label} channel connected`;
    return null;
  };

  /** Open the thread and leave the picker behind. */
  function opened(conversationId: string) {
    haptics.success();
    // Replace rather than push: coming back from the thread should land on the
    // inbox, not on the picker you just finished with.
    router.replace({ pathname: "/(app)/thread/[id]", params: { id: conversationId } });
  }

  async function start(contact: Contact, channel: Channel, inboxId?: string) {
    setBusy(channel);
    setError(null);
    try {
      const { conversationId, alsoOpenWith } = await api.reachContact(contact.id, channel, inboxId);
      if (alsoOpenWith) toast({ text: startedAlongside(contact.displayName, alsoOpenWith) });
      opened(conversationId);
    } catch (err) {
      haptics.error();
      setError(err instanceof Error ? err.message : "Couldn't start that conversation.");
      setBusy(null);
    }
  }

  /**
   * Create the customer and open the thread, in one go.
   *
   * The two halves are one action from where the agent is standing — they typed
   * a name and a number in order to message someone, not in order to file them.
   * If the create succeeds and the reach fails they still have the customer, so
   * the error says so rather than implying nothing happened.
   */
  async function createAndStart(channel: Channel, inboxId?: string) {
    const name = draft.name.trim();
    const phone = draft.phone.trim();
    const email = draft.email.trim();
    if (!name) {
      setError("Give the customer a name first.");
      return;
    }
    setBusy(channel);
    setError(null);
    let created: Contact;
    try {
      const res = await api.createContact({
        displayName: name,
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
      });
      created = res.contact;
    } catch (err) {
      haptics.error();
      setError(err instanceof Error ? err.message : "Couldn't add that customer.");
      setBusy(null);
      return;
    }
    try {
      const { conversationId } = await api.reachContact(created.id, channel, inboxId);
      opened(conversationId);
    } catch (err) {
      haptics.error();
      setError(
        `${created.displayName} was saved, but the conversation didn't open: ${
          err instanceof Error ? err.message : "please try again"
        }`,
      );
      // They exist now — drop into the channel step for them rather than making
      // the agent retype everything.
      setPicked(created);
      setBusy(null);
    }
  }

  /** A channel with more than one connected inbox needs a "from" first. */
  function chooseChannel(ch: Channel, go: (ch: Channel, inboxId?: string) => void) {
    const list = inboxesFor(ch);
    haptics.select();
    if (list.length > 1) setPickInboxFor(ch);
    else void go(ch, list[0]?.id);
  }

  const back = () => {
    if (pickInboxFor) return setPickInboxFor(null);
    if (picked) return setPicked(null);
    router.back();
  };

  const title = pickInboxFor
    ? "Send from"
    : picked
      ? "How to reach them"
      : "New conversation";

  /** The channel buttons, or the inbox sub-step when one is open. */
  function Channels({
    phone,
    email,
    go,
  }: {
    phone?: string | null;
    email?: string | null;
    go: (ch: Channel, inboxId?: string) => void;
  }) {
    if (pickInboxFor) {
      const list = inboxesFor(pickInboxFor);
      const Glyph = channelMeta(pickInboxFor).Glyph;
      return (
        <View className="gap-2">
          <Text className="pb-1 text-sm text-muted">
            Send from which {pickInboxFor === "whatsapp" ? "WhatsApp number" : pickInboxFor === "sms" ? "SMS number" : "email inbox"}?
          </Text>
          {list.map((i) => (
            <Touchable feel="slab"
              key={i.id}
              disabled={!!busy}
              onPress={() => void go(pickInboxFor, i.id)}
              accessibilityRole="button"
              accessibilityLabel={`Send from ${i.name}, ${i.handle}`}
              style={{ backgroundColor: c.surface, borderColor: c.border }}
              className="flex-row items-center gap-3 rounded-16 border px-4 py-3.5"
            >
              <Glyph size={20} color={channelColor(pickInboxFor, c)} />
              <View className="flex-1">
                <Text className="text-lg font-medium text-fg">{i.name}</Text>
                <Text numberOfLines={1} className="text-sm text-muted">
                  {i.handle}
                </Text>
              </View>
              {busy === pickInboxFor ? <ActivityIndicator color={c.brand} /> : null}
            </Touchable>
          ))}
        </View>
      );
    }
    return (
      <View className="gap-2">
        {/* SMS only where the workspace has an SMS channel — most have none. */}
        {(inboxesFor("sms").length ? (["whatsapp", "sms", "email"] as const) : (["whatsapp", "email"] as const)).map((ch) => {
          const meta = channelMeta(ch);
          const Glyph = meta.Glyph;
          const address = ch === "email" ? email : phone;
          const blocked = reason(address, ch);
          return (
            <Touchable feel="slab"
              key={ch}
              disabled={!!blocked || !!busy}
              onPress={() => chooseChannel(ch, go)}
              accessibilityRole="button"
              accessibilityLabel={`Start on ${meta.label}${blocked ? `. Unavailable: ${blocked}` : ""}`}
              accessibilityState={{ disabled: !!blocked }}
              style={{
                backgroundColor: c.surface,
                borderColor: c.border,
                opacity: blocked ? 0.55 : 1,
              }}
              className="flex-row items-center gap-3 rounded-16 border px-4 py-3.5"
            >
              <Glyph size={22} color={blocked ? c.textFaint : channelColor(ch, c)} />
              <View className="flex-1">
                <Text className="text-lg font-medium text-fg">{meta.label}</Text>
                <Text numberOfLines={1} className="text-sm text-muted">
                  {blocked ?? address ?? ""}
                </Text>
              </View>
              {busy === ch ? <ActivityIndicator color={c.brand} /> : null}
            </Touchable>
          );
        })}
      </View>
    );
  }

  return (
    // A plain View owns the screen; the avoiding view wraps only what has to
    // move for the keyboard. See the thread screen for why nothing here hangs
    // its sizing on that component.
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View
        style={{ borderBottomColor: c.border, backgroundColor: c.surface, paddingTop: insets.top }}
        className="flex-row items-center gap-2 border-b px-2 pb-2 pt-2"
      >
        <Touchable feel="chip" onPress={back} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12} className="px-1">
          <BackIcon size={24} color={c.brand} />
        </Touchable>
        <Text accessibilityRole="header" className="flex-1 text-lg font-semibold text-fg">
          {title}
        </Text>
      </View>

      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.danger }} className="px-4 pt-3 text-md">
          {error}
        </Text>
      ) : null}

      {picked ? (
        // ── Step 2 (existing customer): which channel, then which inbox ──
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
          <View className="flex-row items-center gap-3 pb-2">
            <Avatar name={picked.displayName} color={picked.avatarColor} size={48} />
            <View className="flex-1">
              <Text className="text-xl font-semibold text-fg">{picked.displayName}</Text>
              {picked.company ? <Text className="text-md text-muted">{picked.company}</Text> : null}
            </View>
          </View>

          <Channels
            phone={picked.phone}
            email={picked.email}
            go={(ch, inboxId) => void start(picked, ch, inboxId)}
          />

          {!pickInboxFor ? (
            <Text className="pt-1 text-sm text-muted">
              If you're already talking to {picked.displayName.split(" ")[0]} on that channel, this
              opens that conversation rather than starting a second one.
            </Text>
          ) : null}
        </ScrollView>
      ) : (
        // ── Step 1: an existing customer, or a new one ──
        <>
          {/* The web's two tabs, kept as two tabs. Burying "new customer" under
              the list was the whole complaint: on a phone it sat below fifty
              rows, so the answer to "message someone new" was to scroll. */}
          <View className="px-4 pb-1 pt-3">
            <View style={{ backgroundColor: c.surface2 }} className="flex-row rounded-full p-0.5">
              {(
                [
                  ["pick", "Existing customer"],
                  ["new", "New customer"],
                ] as const
              ).map(([key, label]) => {
                const active = tab === key;
                return (
                  <Touchable feel="chip"
                    key={key}
                    onPress={() => {
                      haptics.select();
                      setError(null);
                      // Carry the search over — it's usually their name.
                      if (key === "new" && !draft.name.trim()) {
                        setDraft((d) => ({ ...d, name: query.trim() }));
                      }
                      setTab(key);
                    }}
                    accessibilityRole="tab"
                    // `aria-selected` rather than `accessibilityState={{selected}}`:
                    // both reach TalkBack and VoiceOver on the phone, but
                    // react-native-web drops the latter entirely, so the web
                    // build renders a tab list where nothing says which tab is
                    // on. Supported natively since RN 0.71.
                    aria-selected={active}
                    accessibilityLabel={label}
                    style={{ backgroundColor: active ? c.surface : "transparent" }}
                    className={`flex-1 items-center rounded-full py-2`}
                  >
                    <Text
                      style={{ color: active ? c.text : c.textMuted }}
                      className="text-md font-semibold"
                    >
                      {label}
                    </Text>
                  </Touchable>
                );
              })}
            </View>
          </View>

          {tab === "new" ? (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 18 }}
              keyboardShouldPersistTaps="handled"
            >
              <Field
                label="Name"
                value={draft.name}
                onChangeText={(v) => setDraft((d) => ({ ...d, name: v }))}
                placeholder="Customer name"
                autoFocus
              />
              <Field
                label="Phone (WhatsApp)"
                value={draft.phone}
                onChangeText={(v) => setDraft((d) => ({ ...d, phone: v }))}
                placeholder="+44 7…"
                keyboardType="phone-pad"
                autoComplete="tel"
              />
              <Field
                label="Email"
                value={draft.email}
                onChangeText={(v) => setDraft((d) => ({ ...d, email: v }))}
                placeholder="name@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
              />
              {/* Straight to the channel buttons, as on the web: tapping one
                  saves the customer and opens the thread. The button for a
                  channel they have no address for stays disabled and says so,
                  so one field is enough to get started. */}
              <Channels
                phone={draft.phone}
                email={draft.email}
                go={(ch, inboxId) => void createAndStart(ch, inboxId)}
              />
            </ScrollView>
          ) : (
            <>
              <View className="px-4 pb-2 pt-2">
                <View style={{ backgroundColor: c.surface2 }} className="flex-row items-center gap-2 rounded-full px-3.5">
                  <SearchIcon size={17} color={c.textFaint} />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search customers"
                    placeholderTextColor={c.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus
                    clearButtonMode="while-editing"
                    accessibilityLabel="Search customers"
                    style={{ color: c.text }}
                    className="flex-1 py-2.5 text-lg"
                  />
                </View>
              </View>

              <FlatList
                style={{ flex: 1 }}
                data={matches}
                keyExtractor={(item) => item.id}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
                ItemSeparatorComponent={() => <View style={{ backgroundColor: c.border }} className="ml-[68px] h-px" />}
                renderItem={({ item, index }) => {
                  const row = (
                    <Touchable feel="row"
                      onPress={() => {
                        haptics.select();
                        setError(null);
                        setPicked(item);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${item.displayName}${item.company ? `, ${item.company}` : ""}`}
                      className="flex-row items-center gap-3 px-4 py-3"
                    >
                      <Avatar name={item.displayName} color={item.avatarColor} size={40} />
                      <View className="flex-1">
                        <Text numberOfLines={1} className="text-lg font-medium text-fg">
                          {item.displayName}
                        </Text>
                        <Text numberOfLines={1} className="text-sm text-muted">
                          {item.company || item.phone || item.email || "No details yet"}
                        </Text>
                      </View>
                      {/* Which channels this customer is reachable on, before you
                          commit to opening them — it's the thing you'd otherwise
                          tap in to find out. */}
                      <View className="flex-row items-center gap-1.5">
                        {item.phone ? <ChannelMark channel="whatsapp" /> : null}
                        {item.email ? <ChannelMark channel="email" /> : null}
                      </View>
                    </Touchable>
                  );
                  return index < 8 ? <Animated.View entering={rowIn(index)}>{row}</Animated.View> : row;
                }}
                ListEmptyComponent={
                  isLoading ? (
                    <ActivityIndicator color={c.brand} className="py-8" />
                  ) : (
                    <EmptyState
                      title={q ? "No one matching that" : "No customers yet"}
                      body={
                        q
                          ? "Add them as a new customer and you can message them straight away."
                          : "Add the first one to start a conversation."
                      }
                      action={{
                        label: "Add a customer",
                        onPress: () => {
                          setDraft((d) => ({ ...d, name: query.trim() }));
                          setTab("new");
                        },
                      }}
                    />
                  )
                }
              />
            </>
          )}
        </>
      )}
      {/* Zero-height on purpose: with no children it contributes only the
          padding `behavior="padding"` adds, which equals the keyboard, so the
          scroll view above is squeezed upward by exactly that much. Nothing
          here depends on this component sizing itself, which is the one thing
          it has repeatedly failed to do. */}
      <KeyboardAvoidingView behavior="padding" />
    </View>
  );
}

/** A small channel glyph, for the "reachable on" cue in the picker. */
function ChannelMark({ channel }: { channel: ChannelType }) {
  const { c } = useTheme();
  const Glyph = channelMeta(channel).Glyph;
  return <Glyph size={14} color={channelColor(channel, c)} />;
}
