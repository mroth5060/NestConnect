import { Text, View } from "react-native";
import type { Conversation } from "@ding/schemas";
import { followUpLabel } from "@ding/schemas";
import { useDismissFollowUp, usePeople } from "@ding/client";
import { AtIcon } from "../icons";
import { useTheme } from "../theme";
import { Touchable } from "./Touchable";

/**
 * This conversation isn't mine, but its notes put it in my My Inbound: someone
 * mentioned me, or wrote in notes I'm part of. Answering in the notes (or to
 * the customer) takes it out on its own; Dismiss is for "seen it, nothing to
 * say" — a "Thanks!" that needs no answer. The web's FollowUpBar, the same words.
 */
export function FollowUpBar({ conv }: { conv: Conversation }) {
  const { c } = useTheme();
  const people = usePeople();
  const dismiss = useDismissFollowUp();
  if (!conv.followUp) return null;
  const by = people.data?.find((m) => m.user.id === conv.followUp?.byUserId)?.user.name;
  return (
    <View
      style={{ backgroundColor: c.brandTint, borderBottomColor: c.border }}
      className="flex-row items-center gap-2.5 border-b px-4 py-2"
      accessibilityRole="summary"
    >
      <View style={{ backgroundColor: c.brand }} className="h-7 w-7 items-center justify-center rounded-full">
        <AtIcon size={15} color="#fff" />
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm font-semibold text-fg">
          {followUpLabel(conv.followUp, by)}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted">
          Reply in the notes, or dismiss it.
        </Text>
      </View>
      <Touchable
        onPress={() => dismiss.mutate(conv.id)}
        disabled={dismiss.isPending}
        accessibilityRole="button"
        accessibilityLabel="Dismiss from my inbound"
        style={{ backgroundColor: c.surface, borderColor: c.border }}
        className="rounded-full border px-3.5 py-1.5"
      >
        <Text style={{ color: c.brandStrong }} className="text-sm font-semibold">
          Dismiss
        </Text>
      </Touchable>
    </View>
  );
}
