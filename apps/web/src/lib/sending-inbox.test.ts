import { describe, expect, it } from "vitest";
import { inboxLabel, sendingInbox, type ChannelType, type InboxIdentity } from "@ding/schemas";

/**
 * Which of our numbers or addresses a reply goes out from.
 *
 * The rule has one copy, used by the server to actually send and by all three
 * clients to say what will be sent from. That is the whole point of it living
 * in the shared package: a composer that promises one number while the server
 * uses another is worse than a composer that says nothing.
 *
 * `inboxes` arrives oldest-first — the store's contract — and these lean on it.
 */

const wa1: InboxIdentity = { id: "in_wa1", type: "whatsapp", name: "Support", handle: "+44 20 7946 0100" };
const wa2: InboxIdentity = { id: "in_wa2", type: "whatsapp", name: "Sales", handle: "+44 345 900 0100" };
const mail1: InboxIdentity = { id: "in_m1", type: "email", name: "support@hermolis.com", handle: "support@hermolis.com" };
const mail2: InboxIdentity = { id: "in_m2", type: "email", name: "orders@hermolis.com", handle: "orders@hermolis.com" };
const ALL = [wa1, wa2, mail1, mail2];

const conv = (inboxId: string, channel: ChannelType) => ({ inboxId, channel });

describe("a reply on the thread's own channel", () => {
  it("goes from the thread's own inbox, not the channel's default", () => {
    // The one that matters most: an email thread on the *second* mailbox must
    // keep answering from that mailbox.
    expect(sendingInbox(ALL, conv("in_m2", "email"))?.id).toBe("in_m2");
    expect(sendingInbox(ALL, conv("in_wa2", "whatsapp"))?.id).toBe("in_wa2");
  });

  it("counts a group as the number that serves it", () => {
    expect(sendingInbox(ALL, conv("in_wa2", "whatsapp_group"))?.id).toBe("in_wa2");
  });
});

describe("a reply switched to another channel", () => {
  it("goes from that channel's oldest inbox", () => {
    // The bug this exists for: it used to be whichever row came back first.
    expect(sendingInbox(ALL, conv("in_m2", "email"), { channel: "whatsapp" })?.id).toBe("in_wa1");
    expect(sendingInbox(ALL, conv("in_wa2", "whatsapp"), { channel: "email" })?.id).toBe("in_m1");
  });

  it("gives the same answer every time", () => {
    const once = sendingInbox(ALL, conv("in_m2", "email"), { channel: "whatsapp" })?.id;
    const twice = sendingInbox([...ALL], conv("in_m2", "email"), { channel: "whatsapp" })?.id;
    expect(once).toBe(twice);
  });
});

describe("when a channel has a chosen default", () => {
  // Without one the oldest wins, which is deterministic but arbitrary. This is
  // how a workspace says which number it wants to be known by.
  const chosen = ALL.map((i) => (i.id === "in_wa2" ? { ...i, isDefault: true } : i));

  it("a cross-channel reply goes from the chosen one, not the oldest", () => {
    expect(sendingInbox(chosen, conv("in_m2", "email"), { channel: "whatsapp" })?.id).toBe("in_wa2");
  });

  it("but the thread's own inbox still wins on its own channel", () => {
    // The default answers "which number does this channel use", not "which
    // number does everything use" — a thread already running on one number
    // must not start answering from another.
    expect(sendingInbox(chosen, conv("in_wa1", "whatsapp"))?.id).toBe("in_wa1");
  });

  it("and a default on one channel doesn't touch another", () => {
    expect(sendingInbox(chosen, conv("in_wa2", "whatsapp"), { channel: "email" })?.id).toBe("in_m1");
  });

  it("falls back to the oldest once it's cleared", () => {
    expect(sendingInbox(ALL, conv("in_m2", "email"), { channel: "whatsapp" })?.id).toBe("in_wa1");
  });
});

describe("a message that was already sent", () => {
  it("says where it actually went, whatever the rule would now say", () => {
    // A number can be added, removed or re-ordered after the fact. History must
    // not quietly rewrite itself to match today's default.
    expect(
      sendingInbox(ALL, conv("in_m2", "email"), { channel: "whatsapp", recordedInboxId: "in_wa2" })?.id,
    ).toBe("in_wa2");
  });

  it("and falls back to the rule when nothing was recorded", () => {
    // Every message sent before this was recorded, which is right for any that
    // never crossed channels — nearly all of them.
    expect(sendingInbox(ALL, conv("in_m2", "email"), { recordedInboxId: null })?.id).toBe("in_m2");
  });

  it("but doesn't invent one when the recorded inbox is gone", () => {
    // A deleted number should read as unknown rather than as some other number.
    expect(sendingInbox(ALL, conv("in_m2", "email"), { recordedInboxId: "in_deleted" })).toBeUndefined();
  });
});

describe("when the workspace can't serve the channel", () => {
  it("falls back to the conversation's own inbox rather than nothing", () => {
    expect(sendingInbox([mail1], conv("in_m1", "email"), { channel: "whatsapp" })?.id).toBe("in_m1");
  });

  it("and answers nothing when there is nothing at all", () => {
    expect(sendingInbox([], conv("in_m1", "email"))).toBeUndefined();
  });
});

describe("writing an inbox down in one line", () => {
  it("doesn't say a mailbox twice", () => {
    expect(inboxLabel(mail1)).toBe("support@hermolis.com");
  });

  it("keeps a name worth having next to a number nobody recognises", () => {
    expect(inboxLabel(wa2)).toBe("Sales · +44 345 900 0100");
  });

  it("drops a name that is only the number with the spaces rubbed out", () => {
    expect(inboxLabel({ name: "+44 20 7946", handle: "+44 20 7946 0100" })).toBe("+44 20 7946 0100");
  });

  it("copes with a missing half", () => {
    expect(inboxLabel({ name: "Sales", handle: "" })).toBe("Sales");
    expect(inboxLabel({ name: "", handle: "+44 345 900 0100" })).toBe("+44 345 900 0100");
  });
});
