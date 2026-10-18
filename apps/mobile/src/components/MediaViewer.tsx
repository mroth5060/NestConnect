import { useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { timing } from "../motion";
import { useVideoPlayer, VideoView } from "expo-video";
import type { Attachment } from "@ding/schemas";
import { formatBytes } from "@ding/client";
import { mediaSource } from "../api-config";
import { DownloadIcon, XIcon } from "../icons";
import { useInsets } from "../insets";
import { useThemeVars } from "../theme";
import { useStableCallback } from "../stable-callback";
import { saveAttachment } from "../attachment-open";
import { useToast } from "./Toast";
import { Touchable } from "./Touchable";

/**
 * A photo or a video, full screen.
 *
 * Tapping one used to call `Linking.openURL` on the media endpoint — which is
 * behind the session guard, and a URL handed to the OS carries no session. The
 * phone opened a browser, the browser got a 401, and the user got a blank page.
 * That was "opening photos and videos doesn't work".
 *
 * So nothing leaves the app. `mediaSource` attaches the bearer token as a
 * header, `<Image>` and `expo-video` both accept headers on a remote source,
 * and the file is fetched by the app that already has the credentials. The one
 * thing that does still go out to the system — Share, which needs a real file —
 * downloads it here first, with the header, and hands over the local copy.
 */
export function MediaViewer({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  const themeVars = useThemeVars();
  const insets = useInsets();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const isVideo = attachment.kind === "video";
  // Null for a still: the hook has to run either way, and a player with no
  // source costs nothing.
  const player = useVideoPlayer(isVideo ? mediaSource(attachment.url) : null, (p) => {
    p.loop = false;
    p.play();
  });

  async function share() {
    if (saving) return;
    setSaving(true);
    const err = await saveAttachment(attachment);
    setSaving(false);
    if (err) toast({ text: err, tone: "error" });
  }

  /**
   * Flick the photo away to close it.
   *
   * The gesture every phone gallery has, and the one people try first — it did
   * nothing here, so the only way out was the small X in the corner or a tap,
   * neither of which is what a thumb already holding the photo wants to do.
   *
   * Either direction, because a photo viewer has no "down": the picture is
   * being pushed off the screen, and which way is whichever way the thumb was
   * already moving. The image follows the finger and the black behind it thins
   * as it goes, so the dismissal is visible before it commits rather than
   * after.
   */
  const drag = useSharedValue(0);
  const DISMISS_AT = 110;

  // Built once, like the Sheet's: see `useStableCallback`.
  const close = useStableCallback(onClose);
  const dismiss = useMemo(() => Gesture.Pan()
    .activeOffsetY([-14, 14])
    .failOffsetX([-20, 20])
    .onUpdate((e) => {
      drag.value = e.translationY;
    })
    .onEnd((e) => {
      // Velocity as well as distance: a fast short flick is as clear an
      // instruction as a slow long drag, and requiring the distance from both
      // makes the quick one feel ignored.
      const far = Math.abs(drag.value) > DISMISS_AT;
      const fast = Math.abs(e.velocityY) > 900 && Math.abs(drag.value) > 40;
      if (far || fast) runOnJS(close)();
      else drag.value = withTiming(0, timing.base);
    }), [drag, close]);

  const pulled = useAnimatedStyle(() => ({
    // `flex: 1` belongs here rather than in a second style object beside it: an
    // animated style is the only style that reaches the element, so the pair
    // arrives as `pulled` alone and the image loses its region.
    flex: 1,
    transform: [
      { translateY: drag.value },
      { scale: interpolate(Math.abs(drag.value), [0, 260], [1, 0.86], "clamp") },
    ],
    opacity: interpolate(Math.abs(drag.value), [0, 260], [1, 0.4], "clamp"),
  }));

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* Black regardless of the app's theme — a photo viewer's ground is not a
          surface colour, it's the absence of one. The palette variables still
          have to be republished for the chrome on top of it: a Modal renders
          outside the tree that publishes them. */}
      <View style={[themeVars, { flex: 1, backgroundColor: "#000" }]}>
        <View
          style={{ paddingTop: insets.top + 8 }}
          className="absolute left-0 right-0 top-0 z-10 flex-row items-center gap-2 px-3 pb-3"
        >
          <Touchable feel="chip"
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
            className="h-9 w-9 items-center justify-center rounded-full"
          >
            <XIcon size={17} color="#fff" />
          </Touchable>

          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-md font-medium text-white">
              {attachment.filename || (isVideo ? "Video" : "Photo")}
            </Text>
            {attachment.size ? (
              <Text className="text-2xs" style={{ color: "rgba(255,255,255,0.65)" }}>
                {formatBytes(attachment.size)}
              </Text>
            ) : null}
          </View>

          <Touchable feel="chip"
            onPress={() => void share()}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Share or save"
            accessibilityState={{ busy: saving }}
            hitSlop={12}
            style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
            className="h-9 w-9 items-center justify-center rounded-full"
          >
            {saving ? <ActivityIndicator size="small" color="#fff" /> : <DownloadIcon size={18} color="#fff" />}
          </Touchable>
        </View>

        {isVideo ? (
          <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls />
        ) : (
          // Dismiss on tap, the way every phone gallery does — the close button
          // is for thumbs that started at the top of the screen — and on a
          // flick in either vertical direction, which is the gesture people
          // reach for first and which did nothing at all before.
          <GestureDetector gesture={dismiss}>
          <Animated.View style={pulled}>
          <Pressable onPress={onClose} accessible={false} style={{ flex: 1 }}>
            <Image
              source={mediaSource(attachment.url)}
              style={{ flex: 1 }}
              contentFit="contain"
              // Almost always already on disk from the thumbnail in the thread,
              // so the full-screen view opens on the image rather than on black.
              cachePolicy="memory-disk"
              transition={140}
              accessibilityLabel={attachment.filename || "Photo"}
            />
          </Pressable>
          </Animated.View>
          </GestureDetector>
        )}
      </View>
    </Modal>
  );
}
