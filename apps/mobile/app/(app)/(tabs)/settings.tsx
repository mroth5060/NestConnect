import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  api,
  useLogout,
  useMe,
  usePushPreferences,
  useTestPush,
  useUpdateMyPreferences,
  useUpdateMyProfile,
  useUpdatePushPreferences,
  useChatStatus,
  useMyWorkspaces,
} from "@ding/client";
import { useQueryClient } from "@tanstack/react-query";
import { availableNow, type PushPreferences } from "@ding/schemas";
import { Avatar } from "../../../src/components/Avatar";
import { ActionSheet, type SheetAction } from "../../../src/components/ActionSheet";
import { mediaSource } from "../../../src/api-config";
import { TabHeader } from "../../../src/components/TabHeader";
import { TAB_BAR_H } from "../../../src/components/TabBar";
import { BellIcon, ContrastIcon, LogoutIcon } from "../../../src/icons";
import { usePushRegistration } from "../../../src/push";
import { switchWorkspace } from "../../../src/workspaces";
import { isSoundOn, playReceived, setSoundOn, subscribeSound } from "../../../src/sound";
import { useTheme, type ThemeColors } from "../../../src/theme";
import { EmptyState, QueryState } from "../../../src/components/States";
import { BuildStamp } from "../../../src/components/BuildStamp";
import { type Appearance, useAppearance } from "../../../src/appearance";
import { useInsets } from "../../../src/insets";
import { Touchable } from "../../../src/components/Touchable";

/**
 * Settings on a phone: who you are, whether you're taking work, and what is
 * allowed to interrupt you.
 *
 * Deliberately not the web's Settings section. Channels, teams, people,
 * templates and integrations are administration — long forms, done sitting
 * down — and putting them behind a phone-sized tap target would be worse than
 * not offering them. What a phone genuinely owns is presence and notifications,
 * and those are here in full.
 *
 * No theme toggle either: on a phone the OS decides light or dark, and the app
 * follows it. A second, disagreeing switch inside the app is a bug waiting to
 * be reported.
 */
export default function Settings() {
  const insets = useInsets();
  const { c } = useTheme();
  const { data } = useMe();
  const me = data?.user;
  const prefs = useUpdateMyPreferences();
  const profile = useUpdateMyProfile();
  // Position (job title): it goes into the signature of every email channel
  // you send from, so it's worth being able to fix from the phone.
  const [position, setPosition] = useState("");
  const [editingPosition, setEditingPosition] = useState(false);
  useEffect(() => {
    if (me && !editingPosition) setPosition(me.position ?? "");
  }, [me?.position, editingPosition]);
  function savePosition() {
    setEditingPosition(false);
    const next = position.trim();
    if (next === (me?.position ?? "")) return;
    profile.mutate({ position: next }, { onError: () => setPosition(me?.position ?? "") });
  }

  // Profile photo: the face colleagues see in Team Chat, mentions and
  // assignments. Cropped square here, since it's shown as a circle everywhere.
  const [photoSheet, setPhotoSheet] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  async function choosePhoto(from: "camera" | "library") {
    const perm =
      from === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        from === "camera" ? "Camera access needed" : "Photos access needed",
        from === "camera" ? "Allow camera access to take your photo." : "Allow photo access to choose your photo.",
      );
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.8 };
    const res = from === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    const a = res.canceled ? undefined : res.assets[0];
    if (!a) return;
    setPhotoBusy(true);
    try {
      const name = a.fileName ?? `profile-${Date.now()}.jpg`;
      const att = await api.uploadMedia(
        { uri: a.uri, name, type: a.mimeType ?? "image/jpeg" },
        { kind: "image", filename: name, width: a.width, height: a.height },
      );
      await profile.mutateAsync({ avatarUrl: att.url });
    } catch {
      Alert.alert("Couldn't update your photo", "Check your connection and try again.");
    } finally {
      setPhotoBusy(false);
    }
  }
  function removePhoto() {
    profile.mutate(
      { avatarUrl: "" },
      { onError: () => Alert.alert("Couldn't remove your photo", "Check your connection and try again.") },
    );
  }
  // After the sheet has gone: iOS won't present the picker over a sheet
  // that's still dismissing (see AttachSheet).
  const later = (run: () => void) => () => setTimeout(run, 350);
  const photoActions: SheetAction[] = [
    { key: "camera", label: "Take a photo", onPress: later(() => void choosePhoto("camera")) },
    { key: "library", label: "Choose from library", onPress: later(() => void choosePhoto("library")) },
    ...(me?.avatarUrl ? [{ key: "remove", label: "Remove photo", destructive: true, onPress: removePhoto }] : []),
  ];
  const pushPrefs = usePushPreferences();
  const chatOn = !!useChatStatus().data?.enabled;
  const updatePush = useUpdatePushPreferences();
  const logout = useLogout();
  const appearance = useAppearance();
  // The account's preferences and this phone's OS permission are two different
  // things, and a toggle means nothing while the second is off — hence both.
  const push = usePushRegistration(!!me, me?.id);

  // The workspaces this person is in — shown only when there's somewhere else
  // to go. Moving is a new session there, as their place in that workspace.
  const qc = useQueryClient();
  const places = useMyWorkspaces();
  const workspaces = places.data?.workspaces ?? [];
  const [switching, setSwitching] = useState<string | null>(null);
  async function moveTo(orgId: string) {
    setSwitching(orgId);
    try {
      await switchWorkspace(qc, orgId);
    } catch (err) {
      Alert.alert("Couldn't switch workspace", err instanceof Error ? err.message : "Try again in a moment.");
    } finally {
      setSwitching(null);
    }
  }

  // Sound is a preference of this phone, not of the account, so it's read from
  // and written to the local store rather than the API. Subscribed rather than
  // just read once because `sound.ts` loads the stored value asynchronously at
  // startup, which can land after this screen has already rendered.
  const [sound, setSoundState] = useState(isSoundOn);
  useEffect(() => subscribeSound(setSoundState), []);
  function setSound(on: boolean) {
    setSoundState(on);
    setSoundOn(on);
    // Play the cue you just turned on. A sound setting you can't hear the
    // effect of is a setting you have to test by messaging someone.
    if (on) playReceived();
  }

  // Availability is tracked locally for an instant toggle, then synced — the
  // same arrangement the web's rail menu uses.
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    if (me) setAvailable(me.available);
  }, [me?.available]);

  // What actually decides whether work comes to you: the switch, and — if
  // working hours are set (Personal settings on the web) — whether it's within
  // them. The same rule routing and the website chat use.
  const here = availableNow({ available, schedule: me?.schedule });
  const hours = me?.schedule?.enabled ? me.schedule : null;

  function toggleAvailable() {
    const next = !available;
    setAvailable(next);
    prefs.mutate({ available: next }, { onError: () => setAvailable(!next) });
  }

  const p = pushPrefs.data;
  const setPush = (key: keyof PushPreferences, value: boolean) => updatePush.mutate({ [key]: value });

  // The test's verdict, held here rather than read off the mutation, so it stays
  // on screen after the request settles instead of blinking away.
  const testPush = useTestPush();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  function runTest() {
    setVerdict(null);
    testPush.mutate(undefined, {
      onSuccess: (r) => setVerdict(readResult(r)),
      onError: () =>
        setVerdict({
          tone: "danger",
          text: "Couldn't reach the server. Check your connection and try again.",
        }),
    });
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      // The tab bar sits over the scroll view, so the bottom padding has to
      // clear the bar itself (43 plus its label) as well as the safe area —
      // otherwise the last thing on the page is permanently half-hidden.
      contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + 96 + TAB_BAR_H }}
    >
      <TabHeader title="Settings" subtitle="You, your hours and notifications" />

      {/* Who you are */}
      <View style={{ backgroundColor: c.surface, borderColor: c.border }} className="mx-4 rounded-16 border p-4">
        <View className="flex-row items-center gap-3">
          <Pressable
            onPress={() => setPhotoSheet(true)}
            disabled={photoBusy || !me}
            accessibilityRole="button"
            accessibilityLabel={me?.avatarUrl ? "Change your profile photo" : "Add a profile photo"}
            hitSlop={6}
          >
            <Avatar
              // A fresh one per photo, so a photo that failed to load doesn't
              // leave the next one stuck on initials.
              key={me?.avatarUrl ?? "none"}
              name={me?.name ?? ""}
              color={me?.avatarColor}
              size={52}
              photo={me?.avatarUrl ? mediaSource(me.avatarUrl) : null}
            />
            {photoBusy ? (
              <View style={{ backgroundColor: "rgba(0,0,0,0.35)" }} className="absolute inset-0 items-center justify-center rounded-full">
                <ActivityIndicator color="#fff" size="small" />
              </View>
            ) : null}
            <View
              style={{ backgroundColor: c.surface, borderColor: c.border }}
              className="absolute -bottom-1 -right-1 rounded-full border px-1.5 py-px"
            >
              <Text style={{ color: c.brandStrong }} className="text-2xs font-semibold">
                Edit
              </Text>
            </View>
          </Pressable>
          <View className="flex-1">
            <Text className="text-lg font-semibold text-fg">{me?.name ?? "—"}</Text>
            <Text numberOfLines={1} className="text-sm text-muted">
              {me?.email ?? ""}
            </Text>
            {editingPosition ? (
              <TextInput
                value={position}
                onChangeText={setPosition}
                onBlur={savePosition}
                onSubmitEditing={savePosition}
                autoFocus
                maxLength={80}
                returnKeyType="done"
                placeholder="e.g. Operations Manager"
                placeholderTextColor={c.textFaint}
                accessibilityLabel="Position"
                style={{ color: c.text, borderColor: c.brand }}
                className="mt-1 rounded-8 border px-2 py-1 text-sm"
              />
            ) : (
              <Pressable
                onPress={() => setEditingPosition(true)}
                accessibilityRole="button"
                accessibilityLabel={position ? `Position: ${position}. Change it` : "Add your position"}
                hitSlop={6}
                className="mt-0.5 self-start"
              >
                <Text style={{ color: position ? c.textMuted : c.brandStrong }} className="text-sm">
                  {position || "Add your position"}
                </Text>
              </Pressable>
            )}
          </View>
          <View style={{ backgroundColor: c.surface2 }} className="rounded-full px-2.5 py-1">
            <Text style={{ color: c.textMuted }} className="text-2xs font-semibold capitalize">
              {me?.role ?? ""}
            </Text>
          </View>
        </View>

        <View style={{ backgroundColor: c.border }} className="my-3.5 h-px" />

        <Pressable
          onPress={toggleAvailable}
          accessibilityRole="switch"
          accessibilityState={{ checked: available }}
          className="flex-row items-center gap-2.5"
        >
          <View
            style={{ backgroundColor: here ? c.wa : c.amber }}
            className="h-2.5 w-2.5 rounded-full"
          />
          <View className="flex-1">
            <Text className="text-md font-medium text-fg">
              {!available ? "Unavailable" : here ? "Available" : "Outside your hours"}
            </Text>
            <Text className="text-2xs text-muted">
              {!available
                ? "You're skipped when work is routed"
                : here
                  ? hours
                    ? "Within your working hours"
                    : "Round-robin can route work to you"
                  : "Skipped until your working hours start"}
            </Text>
            {hours ? null : (
              <Text className="text-2xs text-faint">Set working hours in Personal settings on the web</Text>
            )}
          </View>
          <Switch
            value={available}
            onValueChange={toggleAvailable}
            trackColor={{ true: c.brand, false: c.surface2 }}
            thumbColor="#fff"
          />
        </Pressable>
      </View>

      {/* Where you're working */}
      {workspaces.length > 1 ? (
        <>
          <View className="flex-row items-center gap-2 px-5 pb-1.5 pt-6">
            <Text style={{ color: c.textFaint }} className="text-2xs font-semibold uppercase tracking-wider">
              Workspaces
            </Text>
          </View>
          <View style={{ backgroundColor: c.surface, borderColor: c.border }} className="mx-4 rounded-16 border">
            {workspaces.map((w, i) => {
              const last = i === workspaces.length - 1;
              return (
                <Pressable
                  key={w.orgId}
                  onPress={() => void moveTo(w.orgId)}
                  disabled={w.current || !!switching}
                  accessibilityRole="button"
                  accessibilityState={{ selected: w.current, disabled: w.current || !!switching }}
                  accessibilityLabel={w.current ? `${w.name}, the workspace you're in` : `Switch to ${w.name}`}
                  style={{ borderBottomColor: last ? "transparent" : c.border }}
                  className={`flex-row items-center gap-3 px-4 py-3 ${last ? "" : "border-b"}`}
                >
                  <View className="flex-1">
                    <Text numberOfLines={1} className="text-md font-medium text-fg">
                      {w.name}
                    </Text>
                    <Text className="text-2xs capitalize text-muted">{w.role}</Text>
                  </View>
                  {switching === w.orgId ? (
                    <ActivityIndicator size="small" color={c.brand} />
                  ) : w.current ? (
                    <Text style={{ color: c.brandStrong }} className="text-2xs font-semibold">
                      You're here
                    </Text>
                  ) : (
                    <Text style={{ color: c.textMuted }} className="text-2xs font-semibold">
                      Switch
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      {/* What may interrupt you */}
      <View className="flex-row items-center gap-2 px-5 pb-1.5 pt-6">
        <BellIcon size={14} color={c.textFaint} />
        <Text style={{ color: c.textFaint }} className="text-2xs font-semibold uppercase tracking-wider">
          Notifications
        </Text>
      </View>

      {push.supported && push.status && !push.granted ? (
        <Touchable feel="slab"
          onPress={() => void push.requestPermission()}
          accessibilityRole="button"
          style={{ backgroundColor: c.amberTint, borderColor: c.amber }}
          className="mx-4 mb-2 rounded-16 border px-4 py-3"
        >
          <Text style={{ color: c.amber }} className="text-md font-semibold">
            Notifications are off for this phone
          </Text>
          <Text style={{ color: c.amber }} className="text-2xs">
            These settings have no effect until you allow them. Tap to turn them on.
          </Text>
        </Touchable>
      ) : null}

      <View style={{ backgroundColor: c.surface, borderColor: c.border }} className="mx-4 rounded-16 border">
        {pushPrefs.isLoading || pushPrefs.isError || !p ? (
          <QueryState
            query={pushPrefs}
            what="your notification settings"
            empty={<EmptyState title="No settings to show" />}
          />
        ) : (
          <>
            <Toggle
              label="My conversations"
              detail="A new message on something assigned to me"
              value={p.assigned}
              onChange={(v) => setPush("assigned", v)}
            />
            <Toggle
              label="Mentions"
              detail="Someone @mentions me in an internal note or in Team Chat"
              value={p.mentions}
              onChange={(v) => setPush("mentions", v)}
            />
            <Toggle
              label="Assignments"
              detail="A conversation is handed to me"
              value={p.assignments}
              onChange={(v) => setPush("assignments", v)}
            />
            <Toggle
              label="Snooze reminders"
              detail="Something I snoozed comes due"
              value={p.reminders}
              onChange={(v) => setPush("reminders", v)}
            />
            <Toggle
              label="New chats for my team"
              detail="Every message in a chat waiting for my team, until someone takes it"
              value={p.teamChats}
              onChange={(v) => setPush("teamChats", v)}
            />
            <Toggle
              label="Everything in my team's inboxes"
              detail="Also messages in chats my colleagues have taken — noisy on a busy shift"
              value={p.teamInbound}
              onChange={(v) => setPush("teamInbound", v)}
              last={!chatOn}
            />
            {chatOn ? (
              <Toggle
                label="Team Chat messages"
                detail="A new message in one of my team chats, groups or direct chats"
                value={p.chatMessages}
                onChange={(v) => setPush("chatMessages", v)}
                last
              />
            ) : null}
          </>
        )}
      </View>

      {/* Does it actually arrive?
          Every switch above is a statement of intent, and none of them can tell
          you whether a notification reaches this phone. This does, and the
          server side of it ignores the switches and quiet hours on purpose, so
          a silent result means something is broken rather than merely off. */}
      <View style={{ backgroundColor: c.surface, borderColor: c.border }} className="mx-4 mt-4 rounded-16 border">
        <Touchable
          feel="slab"
          onPress={runTest}
          disabled={testPush.isPending}
          accessibilityRole="button"
          accessibilityState={{ disabled: testPush.isPending }}
          className="flex-row items-center gap-3 px-4 py-3"
        >
          <View className="flex-1">
            <Text className="text-md font-medium text-fg">
              {testPush.isPending ? "Sending…" : "Send a test notification"}
            </Text>
            <Text className="text-2xs text-muted">
              Goes to this phone now, whatever the settings above say
            </Text>
          </View>
          <BellIcon size={18} color={testPush.isPending ? c.textFaint : c.brand} />
        </Touchable>

        {verdict ? (
          <View
            accessibilityLiveRegion="polite"
            style={{ borderTopColor: c.border }}
            className="border-t px-4 py-3"
          >
            <Text style={{ color: TONE[verdict.tone](c) }} className="text-2xs">
              {verdict.text}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Its own card, because it isn't a notification setting: these are the
          sounds the app makes while you're looking at it, and they're kept on
          this phone rather than on the account — the same choice the web keeps
          in its own browser. */}
      <View style={{ backgroundColor: c.surface, borderColor: c.border }} className="mx-4 mt-4 rounded-16 border">
        <Toggle
          label="In-app sounds"
          detail="A cue when a message is sent or arrives, while the app is open"
          value={sound}
          onChange={setSound}
          last
        />
      </View>

      {p?.quietHours ? (
        <Text className="px-5 pt-2 text-2xs text-faint">
          Quiet hours {p.quietHours.start}–{p.quietHours.end}
          {p.timezone ? ` (${p.timezone})` : ""} — set on the web.
        </Text>
      ) : null}

      <View className="flex-row items-center gap-2 px-5 pb-1.5 pt-6">
        <ContrastIcon size={14} color={c.textFaint} />
        <Text style={{ color: c.textFaint }} className="text-2xs font-semibold uppercase tracking-wider">
          Appearance
        </Text>
      </View>
      <View style={{ backgroundColor: c.surface, borderColor: c.border }} className="mx-4 rounded-16 border p-1">
        {/* A segmented row rather than an on/off switch, because "dark mode: off"
            can't say whether you mean permanently light or following the phone —
            and following the phone is what most people want and what this
            defaults to. */}
        <View className="flex-row gap-1">
          {(["system", "light", "dark"] as const).map((opt) => {
            const on = appearance.preference === opt;
            return (
              <Touchable feel="chip"
                key={opt}
                onPress={() => appearance.set(opt)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={APPEARANCE_LABEL[opt]}
                style={{ backgroundColor: on ? c.brandTint : "transparent" }}
                className="flex-1 items-center rounded-12 py-2.5"
              >
                <Text
                  style={{ color: on ? c.brandStrong : c.textMuted }}
                  className={`text-md ${on ? "font-semibold" : "font-medium"}`}
                >
                  {APPEARANCE_LABEL[opt]}
                </Text>
              </Touchable>
            );
          })}
        </View>
      </View>

      <Touchable feel="slab"
        onPress={async () => {
          // Delete the device row *before* the session goes: the call needs the
          // token that logging out throws away. A phone that keeps buzzing
          // after sign-out is a bug people report as a security problem.
          await push.unregister();
          logout.mutate();
        }}
        accessibilityRole="button"
        style={{ backgroundColor: c.surface, borderColor: c.border }}
        className="mx-4 mt-6 flex-row items-center justify-center gap-2 rounded-16 border py-3.5"
      >
        <LogoutIcon size={18} color={c.danger} />
        <Text style={{ color: c.danger }} className="text-md font-semibold">
          Sign out
        </Text>
      </Touchable>

      <BuildStamp />
      <ActionSheet visible={photoSheet} title="Profile photo" actions={photoActions} onClose={() => setPhotoSheet(false)} />
    </ScrollView>
  );
}

const APPEARANCE_LABEL: Record<Appearance, string> = {
  system: "Automatic",
  light: "Light",
  dark: "Dark",
};

/* ─────────────────────────────────────────── the test push's three outcomes ── */

type Tone = "ok" | "warn" | "danger";
interface Verdict {
  tone: Tone;
  text: string;
}

const TONE: Record<Tone, (c: ThemeColors) => string> = {
  ok: (c) => c.brandStrong,
  warn: (c) => c.amber,
  danger: (c) => c.danger,
};

/**
 * Turn the server's three numbers into the one sentence that says what to do.
 *
 * They exist to separate failures that are indistinguishable from the outside —
 * "I pressed it and nothing happened" is true of all of them:
 *
 *  - `devices: 0` — no push token ever reached the server, so nothing was even
 *    attempted. Either the OS permission was refused or registration failed.
 *  - `failed` — the push service took the request and rejected it: a bad FCM
 *    credential, or a token that has since been revoked.
 *  - `sent` with nothing arriving — the app's side worked and the problem is
 *    downstream, in the phone's own notification settings or battery policy.
 *    Worth saying out loud, because that is the one case where more fiddling
 *    inside this app cannot help.
 */
function readResult(r: { devices: number; sent: number; failed: number }): Verdict {
  if (r.devices === 0)
    return {
      tone: "warn",
      text:
        "This phone isn't registered for push. Allow notifications above; if they're already " +
        "allowed, sign out and back in to register it.",
    };
  if (r.sent === 0 && r.failed > 0)
    return {
      tone: "danger",
      text: `The push service rejected all ${r.failed} ${plural(r.failed, "device")}. That's a credential or a stale token, not a setting.`,
    };
  if (r.sent === 0)
    return {
      tone: "danger",
      text: `${r.devices} ${plural(r.devices, "device")} registered, but nothing was sent.`,
    };
  return {
    tone: "ok",
    text:
      `Sent to ${r.sent} ${plural(r.sent, "device")}` +
      (r.failed ? `, ${r.failed} rejected` : "") +
      ". If it doesn't appear within a few seconds, the block is in this phone's own " +
      "notification or battery settings.",
  };
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

function Toggle({
  label,
  detail,
  value,
  onChange,
  last,
}: {
  label: string;
  detail: string;
  value: boolean;
  onChange: (v: boolean) => void;
  last?: boolean;
}) {
  const { c } = useTheme();
  return (
    <View
      style={{ borderBottomColor: last ? "transparent" : c.border }}
      className={`flex-row items-center gap-3 px-4 py-3 ${last ? "" : "border-b"}`}
    >
      <View className="flex-1">
        <Text className="text-md font-medium text-fg">{label}</Text>
        <Text className="text-2xs text-muted">{detail}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: c.brand, false: c.surface2 }}
        thumbColor="#fff"
      />
    </View>
  );
}
