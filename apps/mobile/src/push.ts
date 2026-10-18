import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import { api, useChatStatus, useSession } from "@ding/client";

/** Set once, before anything can arrive. Foreground behaviour is decided here
 *  rather than per-notification so there's one answer, not several.
 *
 *  A banner still shows in the foreground because the server has already
 *  decided this person isn't looking at that thread — `isViewing` checks the
 *  socket room before it sends. Suppressing again here would silence the
 *  legitimate case: a message in a *different* conversation while the app is
 *  open, which is exactly when a banner is most useful. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/** Remembers that this person has already been asked, so a decline isn't
 *  re-asked on every launch — iOS only shows the system prompt once anyway, and
 *  nagging is how an app gets its notifications turned off for good. */
const ASKED_KEY = "nest.push.asked.v1";
/** The device row id, kept so sign-out can delete the right one. */
const DEVICE_KEY = "nest.push.deviceId.v1";

/**
 * Android notification channels — one per class, matching the server's map.
 *
 * Mandatory on Android 8+, and the reason someone can silence "every message"
 * while staying reachable for a direct mention. Created before any notification
 * arrives, because a notification naming a channel that doesn't exist is put in
 * a default one and the user's per-class choices stop meaning anything.
 */
async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  const channels: [string, string, Notifications.AndroidImportance][] = [
    ["messages", "Messages", Notifications.AndroidImportance.HIGH],
    ["mentions", "Mentions", Notifications.AndroidImportance.HIGH],
    ["assignments", "Assignments", Notifications.AndroidImportance.DEFAULT],
    ["reminders", "Snooze reminders", Notifications.AndroidImportance.HIGH],
  ];
  await Promise.all(
    channels.map(([id, name, importance]) =>
      Notifications.setNotificationChannelAsync(id, {
        name,
        importance,
        // Group per conversation so the tray shows one entry per chat.
        showBadge: true,
        sound: "default",
      }),
    ),
  );
}

/**
 * Notification categories — the quick actions on the banner.
 *
 * Registered with the same ids the server sends as `categoryId`, on both
 * platforms: iOS calls them categories and Android calls them actions, but
 * expo-notifications takes the same declaration for each, and a reply field is
 * `UNTextInputNotificationAction` on one and `RemoteInput` on the other.
 *
 * Only messages get a category. An assignment or a reminder has nothing to do
 * from the banner except open, and a button that only opens is a button lying
 * about being a shortcut.
 *
 * `opensAppToForeground: false` is what makes these worth having — the reply
 * goes out and the banner closes without the app taking over the screen. The
 * handler for that runs in a short-lived background process, which is why a
 * quick reply is written to the durable send queue rather than posted directly
 * (see notification-routing.ts).
 */
async function ensureCategories(): Promise<void> {
  if (Platform.OS === "web") return;
  await Notifications.setNotificationCategoryAsync("message", [
    {
      identifier: "reply",
      buttonTitle: "Reply",
      textInput: { submitButtonTitle: "Send", placeholder: "Message…" },
      options: { opensAppToForeground: false },
    },
    { identifier: "read", buttonTitle: "Mark read", options: { opensAppToForeground: false } },
  ]);
}

/** The Expo push token for this install, or null if push can't work here. */
async function getToken(): Promise<string | null> {
  // A simulator has no APNs/FCM registration to hand out, and asking throws.
  if (!Device.isDevice) return null;
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return data;
  } catch {
    return null;
  }
}

/**
 * Push registration, from asking to revoking.
 *
 * The rules this implements, in the order they matter:
 *
 *  - **Never ask on cold start.** The prompt appears once the person is signed
 *    in and has seen the inbox, so "can we notify you" is a question about work
 *    they can already see rather than an interruption before the app has
 *    justified itself. iOS gives exactly one chance at that prompt.
 *  - **Re-register on every start.** Push tokens rotate; the server upsert is
 *    cheap, and sending the new one is the only way we learn the new address.
 *  - **Detect revocation.** Someone can turn notifications off in OS settings
 *    without telling the app. On every foreground the real permission is
 *    re-read, and a revoked one deletes the device row so the server stops
 *    pushing at an address that will never ring.
 *  - **Delete on sign-out.** A signed-out phone that keeps buzzing is a bug
 *    people describe as a security problem, and they're not wrong.
 */
export function usePushRegistration(signedIn: boolean, account?: string) {
  const [status, setStatus] = useState<Notifications.PermissionStatus | null>(null);
  const registered = useRef(false);

  // Push needs a real device with a real APNs/FCM registration. A simulator has
  // none, and the web build has no native notification stack at all — asking
  // there would put a permission sheet in front of someone for something that
  // cannot work, which is worse than staying quiet.
  const supported = Device.isDevice && Platform.OS !== "web";

  /** Register (or refresh) this device with the server. */
  const register = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const device = await api.registerDevice({
        pushToken: token,
        platform: Platform.OS === "ios" ? "ios" : "android",
        appVersion: Constants.expoConfig?.version ?? undefined,
        osVersion: Device.osVersion ?? undefined,
        deviceName: Device.deviceName ?? undefined,
      });
      await AsyncStorage.setItem(DEVICE_KEY, device.id);
      registered.current = true;
    } catch {
      // Never fatal: the app works without push, and a failed registration
      // retries on the next foreground.
    }
  }, []);

  /** Stop this device receiving pushes — revocation, or signing out. */
  const unregister = useCallback(async () => {
    registered.current = false;
    const id = await AsyncStorage.getItem(DEVICE_KEY).catch(() => null);
    if (!id) return;
    await api.deleteDevice(id).catch(() => {});
    await AsyncStorage.removeItem(DEVICE_KEY).catch(() => {});
  }, []);

  /**
   * Ask for permission, at the moment the caller decides has earned it.
   *
   * Returns whether it was granted, so the caller can explain what was lost
   * rather than silently doing nothing.
   */
  const requestPermission = useCallback(async (): Promise<boolean> => {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let next = existing;
    if (existing !== "granted") {
      ({ status: next } = await Notifications.requestPermissionsAsync());
    }
    await AsyncStorage.setItem(ASKED_KEY, "1").catch(() => {});
    setStatus(next);
    if (next === "granted") {
      await ensureAndroidChannels();
      await ensureCategories();
      await register();
    }
    return next === "granted";
  }, [register]);

  /** Whether we've ever put the prompt in front of this person. */
  const hasAsked = useCallback(async () => {
    return (await AsyncStorage.getItem(ASKED_KEY).catch(() => null)) === "1";
  }, []);

  // Re-read the real permission whenever the app comes forward — and whenever
  // the account changes (switching workspace is a new session as someone else,
  // and the phone has to be registered for that one) — and reconcile:
  // granted → make sure we're registered (tokens rotate); anything else →
  // make sure we're not, because the OS has stopped delivering.
  useEffect(() => {
    if (!signedIn || !supported) return;
    let cancelled = false;

    const sync = async () => {
      const { status: current } = await Notifications.getPermissionsAsync();
      if (cancelled) return;
      setStatus(current);
      if (current === "granted") {
        await ensureAndroidChannels();
        await ensureCategories();
        await register();
      } else if (registered.current) {
        await unregister();
      }
    };

    void sync();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void sync();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [signedIn, account, supported, register, unregister]);

  return {
    /** False on web and simulators — nothing here will work, so ask nothing. */
    supported,
    status,
    granted: status === "granted",
    requestPermission,
    hasAsked,
    unregister,
  };
}

/** Take the number off the app icon — on sign-out, when nothing is anyone's. */
export async function clearBadge(): Promise<void> {
  await Notifications.setBadgeCountAsync(0).catch(() => {});
}

/**
 * Leaving a workspace: its number comes off the icon and its notifications
 * come out of the tray, straight away rather than whenever the next workspace's
 * count arrives. Those notifications open conversations this session can't
 * see, and an Android launcher's badge counts them, so left in place they kept
 * the old workspace's number on the icon.
 */
export async function forgetWorkspaceNotifications(): Promise<void> {
  await Notifications.dismissAllNotificationsAsync().catch(() => {});
  await clearBadge();
}

/**
 * Keep the app-icon number equal to what's actually unread: conversations in
 * My Inbound plus team chats, as the server counts them.
 *
 * It used to be set only by the number riding on each push and wiped to zero
 * whenever the inbox list showed — so it said 0 with unread conversations still
 * there, then jumped on the next notification. Now the app asks for the real
 * number when it comes to the front and whenever the lists or chats change,
 * and opening a conversation or chat takes it down by one.
 *
 * Keyed under "views" so the realtime updates that refresh the sidebar counts
 * refresh this with them.
 */
export function useAppBadge(enabled: boolean) {
  // Keyed by who's signed in: a switch of workspace is a different person
  // there, and their number must never be read out of the last one's cache.
  const account = useSession().data?.user?.id;
  const on = enabled && Platform.OS !== "web" && !!account;
  const badge = useQuery({ queryKey: ["views", "badge", account], queryFn: () => api.appBadge(), enabled: on, staleTime: 0 });
  const chatUnread = useChatStatus(on).data?.unread;
  const { refetch } = badge;

  // Team Chat's own updates don't touch the conversation lists; its count moving is the cue.
  useEffect(() => {
    if (on) void refetch();
  }, [on, chatUnread, refetch]);

  useEffect(() => {
    if (!on) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refetch();
    });
    return () => sub.remove();
  }, [on, refetch]);

  const count = badge.data?.count;
  useEffect(() => {
    if (on && typeof count === "number") void Notifications.setBadgeCountAsync(count).catch(() => {});
  }, [on, count]);
}
