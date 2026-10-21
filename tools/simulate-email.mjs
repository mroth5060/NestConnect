#!/usr/bin/env node
/**
 * Simulate an inbound email (Postmark-style) against a running Ding API.
 * No dependencies — uses Node's global fetch (Node 18+).
 *
 * New email:
 *   node tools/simulate-email.mjs "sam@acme.co.uk" "Sam Rivera" "support@hermolis.com" "Quote request" "Hi, can you quote weekly collections?"
 *
 * Threaded reply (pass the Message-ID of a prior message in the thread):
 *   node tools/simulate-email.mjs "sam@acme.co.uk" "Sam Rivera" "support@hermolis.com" "Re: Quote request" "One more question…" --in-reply-to "<ding.conv_x.123@hermolis.com>"
 *
 * Env: DING_API (default http://localhost:3001), EMAIL_INBOUND_TOKEN (optional)
 */
const API = process.env.DING_API ?? "http://localhost:3001";
const TOKEN = process.env.EMAIL_INBOUND_TOKEN ?? "";
const args = process.argv.slice(2);

let inReplyTo;
const idx = args.indexOf("--in-reply-to");
if (idx >= 0) {
  inReplyTo = args[idx + 1];
  args.splice(idx, 2);
}

const [
  from = "sam@acme.co.uk",
  name = "Sam Rivera",
  to = "support@hermolis.com",
  subject = "Quote request",
  text = "Hi, could you quote for weekly collections?",
] = args;

const headers = [{ Name: "Message-ID", Value: `<inbound.${Date.now()}@acme.co.uk>` }];
if (inReplyTo) {
  headers.push({ Name: "In-Reply-To", Value: inReplyTo });
  headers.push({ Name: "References", Value: inReplyTo });
}

const body = { FromFull: { Email: from, Name: name }, ToFull: [{ Email: to }], Subject: subject, TextBody: text, Headers: headers };
const url = `${API}/api/channels/email/webhook` + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");

const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log(`${res.status} ${res.statusText}:`, await res.text());
