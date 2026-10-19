-- Someone else's conversation in a person's My Inbound because of its notes:
-- a note @mentioned them, or someone wrote in notes they're part of.
CREATE TABLE "NoteFollowUp" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "byUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteFollowUp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NoteFollowUp_conversationId_userId_key" ON "NoteFollowUp"("conversationId", "userId");
CREATE INDEX "NoteFollowUp_userId_idx" ON "NoteFollowUp"("userId");

ALTER TABLE "NoteFollowUp" ADD CONSTRAINT "NoteFollowUp_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NoteFollowUp" ADD CONSTRAINT "NoteFollowUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
