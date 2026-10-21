import { useEffect, useState, type FormEvent } from "react";
import { GROUP_MAX_MEMBERS } from "@ding/schemas";
import { useCreateGroup, useInboxes } from "../hooks";
import { XIcon } from "../lib/icons";

interface Props {
  onClose: () => void;
  onToast: (msg: string) => void;
  onSelectView: (key: string) => void;
}

/**
 * Create a WhatsApp group. The Groups API is invite-only, so this is a two-step
 * flow: pick a host number + name → we create the group and hand back a
 * shareable invite link. People join through the link (there's no add-by-number);
 * removing members and resetting the link happen from the group's details panel.
 */
export function CreateGroupModal({ onClose, onToast, onSelectView }: Props) {
  const { data: inboxes } = useInboxes();
  const create = useCreateGroup();
  const waNumbers = (inboxes ?? []).filter((i) => i.type === "whatsapp" && i.connected);

  const [inboxId, setInboxId] = useState("");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ inboxId: string; inviteLink?: string } | null>(null);

  useEffect(() => {
    if (!inboxId && waNumbers.length) setInboxId(waNumbers[0].id);
  }, [waNumbers, inboxId]);

  const valid = Boolean(inboxId && name.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    create.mutate(
      // Invite-only: no roster at creation — members join via the link.
      { inboxId, name: name.trim(), members: [] },
      {
        onSuccess: (conv) => {
          setCreated({ inboxId: conv.inboxId, inviteLink: conv.inviteLink ?? undefined });
          onToast(`Group “${name.trim()}” created`);
        },
        onError: (err) => onToast((err as Error)?.message ?? "Couldn’t create the group"),
      },
    );
  };

  const copyLink = () => {
    if (created?.inviteLink) {
      navigator.clipboard?.writeText(created.inviteLink);
      onToast("Invite link copied");
    }
  };
  const openGroup = () => {
    if (created) {
      onSelectView(`inbox:${created.inboxId}`);
      onClose();
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <form className="modal__box" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal__head">
          <h2>New WhatsApp group</h2>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>

        <div className="modal__body">
          {created ? (
            <>
              <p className="fieldhint">
                Your group is ready. Share this invite link — people join through it (up to {GROUP_MAX_MEMBERS}).
              </p>
              {created.inviteLink ? (
                <div className="invite">
                  <code>{created.inviteLink}</code>
                  <button type="button" onClick={copyLink}>Copy</button>
                </div>
              ) : (
                <div className="login__err">
                  No invite link came back yet — open the group and use “Reset link” in its details panel.
                </div>
              )}
            </>
          ) : (
            <>
              {waNumbers.length === 0 && (
                <div className="login__err">
                  Connect a WhatsApp number under Settings → Channels first — a group is hosted by a number.
                </div>
              )}
              <label className="field">
                <span>Host number</span>
                <select value={inboxId} onChange={(e) => setInboxId(e.target.value)}>
                  {waNumbers.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                      {i.channelConfigPublic?.displayNumber ? ` · ${i.channelConfigPublic.displayNumber}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Group name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Maple Road Shul kiddush committee"
                  autoFocus
                  required
                />
              </label>
              <p className="fieldhint">
                Groups are invite-only (max {GROUP_MAX_MEMBERS}). You’ll get a link to share — there’s no
                add-by-number. This needs the number to be an Official Business Account.
              </p>
            </>
          )}
        </div>

        <div className="modal__foot">
          {created ? (
            <>
              <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
              <button type="button" className="btn-primary" onClick={openGroup}>Open group</button>
            </>
          ) : (
            <>
              <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={create.isPending || !valid}>
                {create.isPending ? "Creating…" : "Create group"}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
