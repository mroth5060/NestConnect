import { describe, expect, it } from "vitest";
import { chatTicks, chatSystemText, canEditChatMessage, type ChatMember, type ChatMessage } from "@ding/schemas";
import { chatDayLabel, chatDayOf, chatDays, chatItems, chatLastSeen, chatListTime, chatPreview, chatReactors, isJumboEmoji } from "@ding/client";

const NOW = new Date(2026, 9, 13, 15, 0); // Tue 13 Oct 2026, 15:00 local

const msg = (id: string, authorId: string | null, at: Date, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  roomId: "r",
  kind: "text",
  author: authorId ? { id: authorId, name: authorId === "me" ? "Nathan A" : "Amara Jones", avatarColor: null, avatarUrl: null } : null,
  body: "hi",
  system: null,
  replyTo: null,
  reactions: [],
  mentions: [],
  attachments: [],
  link: null,
  shared: null,
  editedAt: null,
  deletedAt: null,
  createdAt: at.toISOString(),
  ...over,
});
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const member = (id: string, read: Date | null, delivered: Date | null = null): ChatMember => ({
  id,
  name: id,
  avatarColor: null,
  avatarUrl: null,
  role: "member",
  lastReadAt: read?.toISOString() ?? null,
  lastDeliveredAt: delivered?.toISOString() ?? null,
  online: false,
  lastSeenAt: null,
});

describe("Team Chat: dates as people say them", () => {
  it("day lines", () => {
    expect(chatDayLabel(at(13, 9).toISOString(), NOW)).toBe("Today");
    expect(chatDayLabel(at(12, 23).toISOString(), NOW)).toBe("Yesterday");
    expect(chatDayLabel(at(9, 10).toISOString(), NOW)).toBe("Friday");
    expect(chatDayLabel(at(1, 10).toISOString(), NOW)).toBe("1 Oct");
    expect(chatDayLabel(new Date(2025, 2, 3).toISOString(), NOW)).toBe("3 Mar 2025");
  });
  it("list times", () => {
    expect(chatListTime(at(13, 9, 5).toISOString(), NOW)).toBe("9:05");
    expect(chatListTime(at(12, 9).toISOString(), NOW)).toBe("Yesterday");
    expect(chatListTime(at(10, 9).toISOString(), NOW)).toBe("Sat");
    expect(chatListTime(at(1, 9).toISOString(), NOW)).toBe("01/10/26");
  });
  it("last seen", () => {
    expect(chatLastSeen({ online: true, lastSeenAt: null }, NOW)).toBe("online");
    expect(chatLastSeen({ online: false, lastSeenAt: at(13, 14, 2).toISOString() }, NOW)).toBe("last seen today at 14:02");
    expect(chatLastSeen({ online: false, lastSeenAt: at(12, 8).toISOString() }, NOW)).toBe("last seen yesterday at 8:00");
    expect(chatLastSeen({ online: false, lastSeenAt: null }, NOW)).toBe("");
  });
});

describe("Team Chat: the thread as rows", () => {
  it("a day line wherever the date changes, and runs per person", () => {
    const items = chatItems(
      [
        msg("1", "amara", at(12, 10, 0)),
        msg("2", "me", at(13, 9, 0)),
        msg("3", "me", at(13, 9, 2)),
        msg("4", "me", at(13, 9, 20)),
        msg("5", "amara", at(13, 9, 21)),
      ],
      { meId: "me", now: NOW },
    );
    expect(items.filter((i) => i.kind === "day").map((i) => (i.kind === "day" ? i.label : ""))).toEqual(["Yesterday", "Today"]);
    const runs = items.flatMap((i) => (i.kind === "message" ? [`${i.message.id}:${i.first ? "F" : ""}${i.last ? "L" : ""}`] : []));
    // 2, 3 and 4 are one run: the same person, back to back, on one day — 4
    // coming 18 minutes later doesn't make it someone new. 1 is the day before.
    expect(runs).toEqual(["1:FL", "2:F", "3:", "4:L", "5:FL"]);
  });
  it("an unread line before the first message from someone else I haven't read", () => {
    const items = chatItems([msg("1", "amara", at(13, 9)), msg("2", "me", at(13, 10)), msg("3", "amara", at(13, 11)), msg("4", "amara", at(13, 12))], {
      meId: "me",
      unreadAfter: at(13, 10, 30).toISOString(),
      now: NOW,
    });
    const idx = items.findIndex((i) => i.kind === "unread");
    expect(items[idx]).toMatchObject({ kind: "unread", count: 2 });
    expect(items[idx + 1]).toMatchObject({ kind: "message", message: { id: "3" } });
  });
  it("grouped by day, so each day's date sticks only while you read that day", () => {
    const items = chatItems(
      [msg("1", "amara", at(12, 10)), msg("2", "me", at(13, 9)), msg("3", "amara", at(13, 11))],
      { meId: "me", unreadAfter: at(13, 10).toISOString(), now: NOW },
    );
    const days = chatDays(items);
    expect(days.map((d) => d.label)).toEqual(["Yesterday", "Today"]);
    expect(days.map((d) => d.items.map((i) => i.kind))).toEqual([["message"], ["message", "unread", "message"]]);
  });
  it("the day each row is in, oldest-first or newest-first (the app's inverted list)", () => {
    const items = chatItems([msg("1", "amara", at(12, 10)), msg("2", "me", at(13, 9)), msg("3", "me", at(13, 10))], { meId: "me", now: NOW });
    expect(chatDayOf(items)).toEqual(["Yesterday", "Yesterday", "Today", "Today", "Today"]);
    const reversed = [...items].reverse();
    expect(chatDayOf(reversed, true)).toEqual(["Today", "Today", "Today", "Yesterday", "Yesterday"]);
  });
  it("system messages never join a run", () => {
    const sys = msg("s", null, at(13, 9, 1), { kind: "system", system: { event: "added", actorName: "Nathan A", targetNames: ["Amara"] } });
    const items = chatItems([msg("1", "me", at(13, 9)), sys, msg("2", "me", at(13, 9, 2))], { meId: "me", now: NOW });
    expect(items.filter((i) => i.kind === "message").every((i) => i.kind === "message" && i.first && i.last)).toBe(true);
  });
});

describe("Team Chat: ticks from read markers", () => {
  const sent = msg("m", "me", at(13, 10));
  it("one grey, two grey, blue", () => {
    expect(chatTicks(sent, [member("me", null), member("amara", null)], "me")).toBe("sent");
    expect(chatTicks(sent, [member("me", null), member("amara", null, at(13, 10, 1))], "me")).toBe("delivered");
    expect(chatTicks(sent, [member("me", null), member("amara", at(13, 10, 5))], "me")).toBe("read");
  });
  it("in a group, blue only once everyone else has read it", () => {
    const members = [member("me", null), member("a", at(13, 11)), member("b", null, at(13, 11))];
    expect(chatTicks(sent, members, "me")).toBe("delivered");
    expect(chatTicks(sent, [...members.slice(0, 2), member("b", at(13, 11))], "me")).toBe("read");
  });
  it("edits only for 15 minutes", () => {
    const now = at(13, 10).getTime();
    expect(canEditChatMessage(msg("m", "me", at(13, 9, 50)), now)).toBe(true);
    expect(canEditChatMessage(msg("m", "me", at(13, 9, 40)), now)).toBe(false);
  });
});

describe("Team Chat: previews", () => {
  const people = [{ name: "Nathan A", email: "nathan@swiftee.co.uk" }];
  it("says who, in a group", () => {
    expect(chatPreview(msg("1", "amara", NOW, { body: "On my way" }), { meId: "me", group: true, people })).toBe("Amara: On my way");
    expect(chatPreview(msg("1", "me", NOW, { body: "Thanks" }), { meId: "me", group: true, people })).toBe("You: Thanks");
    expect(chatPreview(msg("1", "amara", NOW, { body: "On my way" }), { meId: "me", group: false, people })).toBe("On my way");
  });
  it("shows mentions by name, and deleted as deleted", () => {
    expect(chatPreview(msg("1", "amara", NOW, { body: "@nathan can you?" }), { meId: "me", group: false, people })).toBe("@Nathan A can you?");
    expect(chatPreview(msg("1", "amara", NOW, { deletedAt: NOW.toISOString(), body: "" }), { meId: "me", group: false, people })).toBe("This message was deleted");
    const photo = { id: "a", kind: "image" as const, mime: "image/jpeg", size: 1, filename: "van.jpg", url: "/api/media/a" };
    expect(chatPreview(msg("1", "amara", NOW, { body: "", attachments: [photo] }), { meId: "me", group: true, people })).toBe("Amara: 📷 Photo");
    expect(chatPreview(msg("1", "amara", NOW, { body: "The van", attachments: [photo] }), { meId: "me", group: false, people })).toBe("📷 The van");
    const voice = { ...photo, kind: "voice" as const, durationMs: 72_000 };
    expect(chatPreview(msg("1", "me", NOW, { body: "", attachments: [voice] }), { meId: "me", group: false, people })).toBe("You: 🎤 Voice message (1:12)");
    const shared = { conversationId: "c", contactName: "Northside Logistics", contactAvatarColor: null, channel: "whatsapp" as const, subject: null, status: "open" as const, assigneeName: null, quote: null };
    expect(chatPreview(msg("1", "amara", NOW, { body: "", shared }), { meId: "me", group: true, people })).toBe("Amara: 💬 Northside Logistics");
    expect(chatPreview(msg("1", "amara", NOW, { body: "Can someone check?", shared }), { meId: "me", group: false, people })).toBe("💬 Can someone check?");
  });
  it("system lines read as sentences", () => {
    expect(chatSystemText({ event: "added", actorName: "Nathan A", targetNames: ["Amara", "James", "Sam"] })).toBe("Nathan A added Amara, James and Sam");
    expect(chatSystemText({ event: "created", actorName: "Amara", value: "Dispatch London" })).toBe("Amara created the group “Dispatch London”");
  });
  it("big emoji only for a few emoji on their own", () => {
    expect(isJumboEmoji("👍")).toBe(true);
    expect(isJumboEmoji("🎉🎉")).toBe(true);
    expect(isJumboEmoji("ok 👍")).toBe(false);
    expect(isJumboEmoji("123")).toBe(false);
  });
});

describe("who reacted", () => {
  const people = [
    { id: "me", name: "Nathan A", avatarColor: null, avatarUrl: null },
    { id: "amara", name: "Amara Jones", avatarColor: "#F43F5E", avatarUrl: null },
    { id: "james", name: "James", avatarColor: null, avatarUrl: "/api/media/j" },
  ];
  const reactions = [
    { emoji: "👍", userIds: ["amara", "me"] },
    { emoji: "❤️", userIds: ["james", "gone"] },
  ];

  it("lists everyone, you first, then in the order they reacted", () => {
    const rows = chatReactors(reactions, people, "me");
    expect(rows.map((r) => `${r.name}:${r.emoji}`)).toEqual(["Nathan A:👍", "Amara Jones:👍", "James:❤️", "Former teammate:❤️"]);
    expect(rows[0]!.mine).toBe(true);
    expect(rows.slice(1).every((r) => !r.mine)).toBe(true);
  });

  it("carries each person's face", () => {
    const rows = chatReactors(reactions, people, "me");
    expect(rows.find((r) => r.userId === "james")?.avatarUrl).toBe("/api/media/j");
    expect(rows.find((r) => r.userId === "amara")?.avatarColor).toBe("#F43F5E");
  });

  it("the first name we know wins (a chat member over the workspace list)", () => {
    const rows = chatReactors([{ emoji: "👍", userIds: ["amara"] }], [{ id: "amara", name: "Amara (Ops)" }, ...people], null);
    expect(rows[0]!.name).toBe("Amara (Ops)");
  });
});
