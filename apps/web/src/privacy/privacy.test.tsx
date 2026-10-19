import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivacyPage } from "./PrivacyPage";
import {
  OWNER_FIELDS,
  OWNER_FIELD_NAMES,
  buildPolicy,
  containsPlaceholderMarker,
  documentText,
  resolvePolicy,
  unresolvedOwnerFields,
  type PrivacyOwnerFields,
  type ResolvedOwnerFields,
} from "./policy";
import { isPrivacyPath } from "./route";

/** Test fixture values only — deliberately not real owner facts. */
const FILLED: ResolvedOwnerFields = {
  controllerName: "Fixture Company Ltd",
  companyDetails: "registered in Fixtureland, number 00000000",
  postalAddress: "1 Fixture Street, Fixture Town, FX1 1XX",
  contactEmail: "privacy@fixture-company.test",
  effectiveDate: "2026-01-15",
  endCustomerDataRole: "processor",
  hostingProvider: "Fixture Hosting",
  hostingRegion: "Fixtureland",
  internationalTransfersStatement: "Fixture statement about international transfers.",
  retentionStatement: "Fixture statement about retention periods.",
  backupStatement: "Fixture statement about backups.",
  legalBasesStatement: "Fixture statement about legal bases.",
  jurisdictionalRightsStatement: "Fixture statement about regional rights.",
  childrenStatement: "Fixture statement about children.",
  secretEncryptionEnabledInProduction: true,
  sentryEnabledInProduction: true,
  cloudflareInFrontOfDomain: true,
  r2StorageInProduction: true,
  whatsappCloudApiInUse: true,
  gmailIntegrationInUse: true,
  postmarkInUse: true,
  resendInUse: true,
  smtpInUse: true,
  anthropicPolishAvailable: true,
  sdkCustomerPushInUse: true,
};

const ALL_UNRESOLVED = Object.fromEntries(OWNER_FIELD_NAMES.map((k) => [k, null])) as unknown as PrivacyOwnerFields;

const html = (fields?: PrivacyOwnerFields) => renderToStaticMarkup(<PrivacyPage fields={fields} />);

/** Visible text only, so attribute values and markup can't hide or fake a match. */
const visibleText = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("privacy policy — unresolved owner fields (fail closed)", () => {
  it("ships the owner-approved policy: every field resolved and the page published", () => {
    expect(unresolvedOwnerFields(OWNER_FIELDS)).toEqual([]);
    const resolved = resolvePolicy();
    expect(resolved.status).toBe("ready");
    const out = html();
    expect(out).toContain('data-testid="privacy-policy"');
    expect(out).not.toContain('data-testid="privacy-pending"');
    const text = visibleText(out);
    expect(containsPlaceholderMarker(text)).toBe(false);
    for (const fact of ["Nest Partners Limited", "17089989", "14 Grosvenor Way, London, E5 9ND", "info@swiftee.co.uk", "19 October 2026", "Railway"])
      expect(text).toContain(fact);
    // Production configuration as verified: Postmark and Sentry are off.
    expect(text).not.toMatch(/Postmark|Sentry/);
  });

  it("shows only the neutral 'being finalised' state", () => {
    const out = html(ALL_UNRESOLVED);
    expect(out).toContain('data-testid="privacy-pending"');
    expect(out).toContain("being finalised");
    expect(out).not.toContain('data-testid="privacy-policy"');
  });

  it("contains no placeholder markers, field names or null-ish values", () => {
    const text = visibleText(html(ALL_UNRESOLVED));
    expect(containsPlaceholderMarker(text)).toBe(false);
    for (const name of OWNER_FIELD_NAMES) expect(text).not.toContain(name);
    expect(text).not.toMatch(/\bnull\b|\bundefined\b|NaN/);
  });

  it("contains none of the draft policy body", () => {
    const text = visibleText(html(ALL_UNRESOLVED));
    const draft = buildPolicy(FILLED);
    for (const s of draft.sections) expect(text).not.toContain(s.title);
    expect(text).not.toContain("Workspace users");
    expect(text).not.toContain("Gravatar");
    expect(text).not.toContain("bcrypt");
  });

  it("stays pending while even one field is missing", () => {
    for (const name of OWNER_FIELD_NAMES) {
      const partial = { ...FILLED, [name]: null } as PrivacyOwnerFields;
      expect(resolvePolicy(partial).status, name).toBe("pending");
      expect(html(partial), name).not.toContain('data-testid="privacy-policy"');
    }
  });

  it("treats blanks, placeholder text and malformed values as unresolved", () => {
    const cases: Partial<PrivacyOwnerFields>[] = [
      { controllerName: "   " },
      { controllerName: "[OWNER: company name]" },
      { postalAddress: "TBD" },
      { retentionStatement: "We keep data for {{period}}." },
      { contactEmail: "⟦contactEmail⟧" },
      { contactEmail: "not-an-email" },
      { contactEmail: "privacy@example.com" },
      { effectiveDate: "2026-02-30" },
      { effectiveDate: "soon" },
      { endCustomerDataRole: "both" as never },
      { backupStatement: "TODO confirm with hosting" },
      { legalBasesStatement: "Lorem ipsum dolor" },
    ];
    for (const c of cases) {
      const fields = { ...FILLED, ...c } as PrivacyOwnerFields;
      expect(unresolvedOwnerFields(fields).length, JSON.stringify(c)).toBeGreaterThan(0);
      expect(resolvePolicy(fields).status, JSON.stringify(c)).toBe("pending");
    }
  });
});

describe("privacy policy — all owner fields filled (fixture values)", () => {
  it("renders the full policy", () => {
    const out = html(FILLED);
    expect(out).toContain('data-testid="privacy-policy"');
    expect(out).not.toContain('data-testid="privacy-pending"');
    const doc = buildPolicy(FILLED);
    const text = visibleText(out);
    for (const s of doc.sections) expect(text).toContain(s.title);
    expect(text).toContain("Effective 15 January 2026");
    expect(text).toContain("Fixture Company Ltd");
    expect(out).toContain('href="mailto:privacy@fixture-company.test"');
  });

  it("contains no placeholder markers", () => {
    const resolved = resolvePolicy(FILLED);
    expect(resolved.status).toBe("ready");
    if (resolved.status !== "ready") return;
    expect(containsPlaceholderMarker(documentText(resolved.document))).toBe(false);
    const text = visibleText(html(FILLED));
    expect(containsPlaceholderMarker(text)).toBe(false);
    expect(text).not.toMatch(/\bnull\b|\bundefined\b|NaN|\[object Object\]/);
    for (const name of OWNER_FIELD_NAMES) expect(text).not.toContain(name);
  });

  it("lists only the optional services the owner confirmed", () => {
    const off: ResolvedOwnerFields = {
      ...FILLED,
      endCustomerDataRole: "controller",
      secretEncryptionEnabledInProduction: false,
      sentryEnabledInProduction: false,
      cloudflareInFrontOfDomain: false,
      r2StorageInProduction: false,
      whatsappCloudApiInUse: false,
      gmailIntegrationInUse: false,
      postmarkInUse: false,
      resendInUse: false,
      smtpInUse: false,
      anthropicPolishAvailable: false,
      sdkCustomerPushInUse: false,
    };
    const text = visibleText(html(off));
    expect(text).toContain("Privacy Policy");
    for (const absent of ["Sentry", "Anthropic", "Cloudflare", "Meta", "Gmail", "Postmark", "Resend", "SMTP", "AES-256-GCM"]) {
      expect(text, absent).not.toContain(absent);
    }
    // Code-unconditional parts are always disclosed.
    expect(text).toContain("Gravatar");
    expect(text).toContain("Expo");
    expect(text).toContain("does not send crash reports");
    expect(containsPlaceholderMarker(text)).toBe(false);

    const on = visibleText(html(FILLED));
    for (const present of ["Sentry", "Anthropic", "Cloudflare R2", "Meta", "Gmail", "Postmark", "Resend", "SMTP", "AES-256-GCM"]) {
      expect(on, present).toContain(present);
    }
  });
});

describe("privacy policy — public route", () => {
  beforeEach(() => {
    // Any network call would mean the page depends on a session/API. It must not.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network not allowed"))));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("matches /privacy (and its variants) and nothing else", () => {
    for (const p of ["/privacy", "/privacy/", "/PRIVACY", "/privacy.html"]) expect(isPrivacyPath(p), p).toBe(true);
    for (const p of ["/", "/privacy-old", "/settings/privacy", "/privacyx", "/api/privacy"]) expect(isPrivacyPath(p), p).toBe(false);
  });

  it("renders without a signed-in session, a query client or any network call", () => {
    // No QueryClientProvider, no configureClient, no cookie: just the page.
    const out = html();
    expect(out).toMatch(/data-testid="privacy-(pending|policy)"/);
    // Nothing of the login screen: no password field, no sign-in form.
    expect(out).not.toContain('type="password"');
    expect(out).not.toContain("<form");
    expect(fetch).not.toHaveBeenCalled();
    // Same with the full policy.
    const full = html(FILLED);
    expect(full).not.toContain('type="password"');
    expect(full).not.toContain("<form");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the shipped owner config renders a page with no placeholder markers, whatever its state", () => {
    const text = visibleText(html(OWNER_FIELDS));
    expect(containsPlaceholderMarker(text)).toBe(false);
    for (const name of OWNER_FIELD_NAMES) expect(text).not.toContain(name);
  });

  const webRoot = resolve(__dirname, "..", "..");

  it("has its own document and Vite entry, separate from the inbox", () => {
    const doc = readFileSync(join(webRoot, "privacy.html"), "utf8");
    expect(doc).toContain('src="/src/privacy/main.tsx"');
    const vite = readFileSync(join(webRoot, "vite.config.ts"), "utf8");
    expect(vite).toMatch(/privacy:\s*resolve\(__dirname,\s*"privacy\.html"\)/);
  });

  it("never imports the inbox, its login gate or the API client", () => {
    const dir = join(webRoot, "src", "privacy");
    for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(src, file).not.toMatch(/from\s+["'](\.\.\/App|\.\.\/hooks|\.\.\/components\/|@ding\/client|@tanstack\/react-query)/);
    }
  });

  it("is routed by the inbox entry before the session gate", () => {
    const main = readFileSync(join(webRoot, "src", "main.tsx"), "utf8");
    const branch = main.indexOf("isPrivacyPath(window.location.pathname)");
    const app = main.indexOf("<App />");
    expect(branch).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(branch);
  });
});
