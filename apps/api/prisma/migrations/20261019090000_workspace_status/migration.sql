-- A workspace's life: active, suspended, archived, or being deleted.
ALTER TABLE "Organization" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "Organization" ADD COLUMN "statusAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "purgeAt" TIMESTAMP(3);
