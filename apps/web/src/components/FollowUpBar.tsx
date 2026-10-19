import type { Conversation } from "@ding/schemas";
import { followUpLabel } from "@ding/schemas";
import { useDismissFollowUp, usePeople } from "../hooks";
import { AtIcon } from "../lib/icons";

/**
 * This conversation isn't mine, but its notes put it in my My Inbound: someone
 * mentioned me, or wrote in notes I'm part of. Answering in the notes (or to
 * the customer) takes it out on its own; Dismiss is for "seen it, nothing to
 * say" — a "Thanks!" that needs no answer. The conversation itself is left as
 * it is; it stays in Mentions.
 */
export function FollowUpBar({ conv }: { conv: Conversation }) {
  const people = usePeople();
  const dismiss = useDismissFollowUp();
  if (!conv.followUp) return null;
  const by = people.data?.find((m) => m.user.id === conv.followUp?.byUserId)?.user.name;
  return (
    <div className="fubar" role="region" aria-label="In your inbound because of the notes">
      <span className="fubar__ic" aria-hidden="true">
        <AtIcon />
      </span>
      <span className="fubar__text">
        <b>{followUpLabel(conv.followUp, by)}</b>
        <span>Reply in the notes, or dismiss it from your inbound.</span>
      </span>
      <button type="button" className="fubar__btn" disabled={dismiss.isPending} onClick={() => dismiss.mutate(conv.id)}>
        Dismiss
      </button>
    </div>
  );
}
