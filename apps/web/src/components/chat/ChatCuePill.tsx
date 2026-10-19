import { useEffect, useRef, useState } from "react";
import type { ChatCue } from "@ding/schemas";
import { onChatCue, usePeople } from "../../hooks";
import { AtIcon, XIcon } from "../../lib/icons";
import { Avatar } from "../Avatar";

/** How long a pop-up stays, counted while the page is in view and not hovered. */
const SHOW_MS = 6_000;

/**
 * A Team Chat message, popped up at the top of the page: who, where, what.
 *
 * Only for what the server says this person should hear about — so never a
 * muted chat or their own message — and never for the chat they already have
 * open in front of them. A new one replaces the last rather than stacking:
 * the list has the rest. Clicking it opens the chat.
 */
export function ChatCuePill({ onOpen }: { onOpen: (roomId: string) => void }) {
  const people = usePeople();
  const [cue, setCue] = useState<(ChatCue & { key: number }) | null>(null);
  const [shown, setShown] = useState(false);
  const [hover, setHover] = useState(false);
  const seq = useRef(0);

  useEffect(
    () =>
      onChatCue((c) => {
        if (c.onScreen || !c.title) return;
        setCue({ ...c, key: ++seq.current });
        setShown(true);
      }),
    [],
  );

  // The clock only runs while someone could be reading it: a pop-up that went
  // off in a background tab is still there when they come back to it.
  useEffect(() => {
    if (!shown || hover) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") timer = setTimeout(() => setShown(false), SHOW_MS);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [shown, hover, cue?.key]);

  if (!cue) return null;
  const who = cue.actorUserId ? people.data?.find((m) => m.user.id === cue.actorUserId)?.user : undefined;
  const name = who?.name ?? cue.title ?? "";

  return (
    <div
      className={"cuepill" + (shown ? " show" : "")}
      role="status"
      aria-live="polite"
      aria-hidden={!shown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Rings rippling out from the pill's edge as it lands. Keyed by the
          message, so each new one ripples afresh rather than only the first. */}
      {shown && <span className="cuepill__ripple" key={cue.key} aria-hidden="true" />}
      <button
        type="button"
        className="cuepill__main"
        tabIndex={shown ? 0 : -1}
        onClick={() => {
          setShown(false);
          onOpen(cue.roomId);
        }}
      >
        <Avatar name={name} email={who?.email} color={who?.avatarColor} src={who?.avatarUrl} size={34} fontSize={13} />
        <span className="cuepill__text">
          <b>{cue.title}</b>
          <span>{cue.body}</span>
        </span>
        {cue.mention && (
          <span className="cuepill__at" title="Mentions you" aria-label="Mentions you">
            <AtIcon />
          </span>
        )}
      </button>
      <button type="button" className="cuepill__x" aria-label="Dismiss" tabIndex={shown ? 0 : -1} onClick={() => setShown(false)}>
        <XIcon />
      </button>
    </div>
  );
}
