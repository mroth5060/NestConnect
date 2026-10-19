-- Customers who have written to us on WhatsApp are on WhatsApp.
--
-- A WhatsApp id is what marks a contact as on WhatsApp (Contact.onWhatsApp).
-- One is written when somebody new arrives from WhatsApp, and since this change
-- when somebody already known by their phone number writes there. Before it,
-- a customer first added by hand or met by text kept only their phone, however
-- often they wrote on WhatsApp afterwards. This gives them the WhatsApp id
-- they would have had: one per phone number, for contacts with a message of
-- their own in a WhatsApp conversation (sending them a template proves
-- nothing; a reply does). The value is the phone's canonical digits, which is
-- the shape WhatsApp sends its ids in.
--
-- Data only, and safe to run again: contacts that already have a WhatsApp id
-- are skipped, and one another contact in the workspace already holds is left
-- alone.
INSERT INTO "ContactIdentity" ("id", "contactId", "orgId", "kind", "value", "normalizedValue", "verified")
SELECT DISTINCT ON (c."orgId", p."normalizedValue")
  'wabf_' || md5(c."id" || ':' || p."normalizedValue"),
  c."id",
  c."orgId",
  'wa_id',
  p."normalizedValue",
  p."normalizedValue",
  false
FROM "Contact" c
JOIN "ContactIdentity" p
  ON p."contactId" = c."id" AND p."kind" = 'phone' AND p."normalizedValue" IS NOT NULL AND p."normalizedValue" <> ''
WHERE EXISTS (
    SELECT 1
    FROM "Conversation" v
    JOIN "Message" m ON m."conversationId" = v."id"
    WHERE v."contactId" = c."id"
      AND v."channel" = 'whatsapp'
      AND m."direction" = 'in'
      AND m."authorType" = 'contact'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "ContactIdentity" w WHERE w."contactId" = c."id" AND w."kind" = 'wa_id'
  )
ORDER BY c."orgId", p."normalizedValue", c."createdAt"
ON CONFLICT ("orgId", "kind", "value") DO NOTHING;
