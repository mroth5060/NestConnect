# Mentions in My Inbound (note follow-ups)

Internal notes reach the people they're for by putting the conversation in their
**My Inbound**. That includes conversations that aren't theirs.

## The rule

You're **in a conversation's notes** if you wrote a note there or someone
@mentioned you in one.

| Event | Your My Inbound |
|---|---|
| A note @mentions you | It comes in, tagged **"Sara mentioned you"** |
| Anyone else writes a note in notes you're in, with no @ needed | It comes back, tagged **"Sara replied in the notes"** |
| You write a note there, or reply to the customer | It leaves |
| You press **Dismiss** | It leaves |
| The conversation is closed | It leaves, for everyone |
| The customer writes | No change: that's the owner's job |

**Dismiss** is for "seen it, nothing to say", such as a "Thanks!" that needs no
answer. It leaves the conversation itself alone: owner, status and notes are
unchanged, and it stays in **Mentions**. Your own notes never put anything in
your inbound. Each person is tracked separately: if a note mentions you and
Isaac, his answer clears his follow-up, not yours.

## Where it shows

- **List row:** the tag, before the owner, so it doesn't read as a chat handed
  to you. It appears on the web and in the app.
- **Thread:** a strip under the header with the same words and **Dismiss**,
  on both the web and the app.
- **My Inbound count and the app icon badge** include it: it's waiting on you.
  The existing bell and push notifications say the same thing.

## How it works

- `NoteFollowUp`: one row per conversation and person, holding the reason
  (`mention` or `reply`), who wrote the note, and when. It's tenant-scoped
  through its conversation.
- A new note works out its audience once (`NotificationsService.noteAudience`),
  writes the follow-ups, and sends the notifications to the same people.
- My Inbound is mine, plus queue, plus follow-ups. The badge counts follow-ups
  as unread.
- Writing a note or a reply clears the author's own follow-up. Closing clears
  them all (in the store's `setStatus`). Dismiss is
  `POST /conversations/:id/dismiss`.
- `followUp` on a conversation is per viewer. It's attached to list pages and
  to the thread for whoever is asking.

`pnpm check:note-follow-ups` pins each of these rules.
