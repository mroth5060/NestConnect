// Deterministic screenshot harness for the CSS→Tailwind migration gate.
// Usage: node snap.mjs <outdir>
// Captures a fixed set of app views into <outdir>/<name>.png. The clock is
// frozen (shared FIXED across runs) and motion reduced, so baseline vs after
// screenshots differ ONLY where real styling changed — see diff.mjs.
import pkg from "/home/user/Chat/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js";
import { mkdirSync } from "node:fs";
const { chromium } = pkg;
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = "http://localhost:5173";
const outdir = process.argv[2];
if (!outdir) { console.error("usage: node snap.mjs <outdir>"); process.exit(1); }
mkdirSync(outdir, { recursive: true });

// One frozen instant shared by every run (baseline + after), so time-derived
// text — countdowns, "active Nh ago", SLA — is byte-stable across captures.
// Pass the SAME value via SNAP_FIXED for both the baseline and after runs.
const FIXED = Number(process.env.SNAP_FIXED) || Date.now();

const freezeClock = `(() => {
  const OD = Date; const F = ${FIXED};
  function D(...a){ return a.length ? new OD(...a) : new OD(F); }
  D.now = () => F; D.parse = OD.parse; D.UTC = OD.UTC; D.prototype = OD.prototype;
  // eslint-disable-next-line no-global-assign
  window.Date = D;
})();`;

async function login(page) {
  await page.addInitScript(freezeClock);
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', "nathan@hermolis.com").catch(() => {});
  await page.fill('input[type="password"]', "ding1234");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".conv", { timeout: 20000 });
  await page.waitForTimeout(600);
}

const b = await chromium.launch({ executablePath: EXE });

async function shot(name, { width, height, mobile, theme, prep, bare }) {
  const ctx = await b.newContext({
    viewport: { width, height }, deviceScaleFactor: 2,
    isMobile: !!mobile, hasTouch: !!mobile, colorScheme: "light", reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  if (bare) {
    // Pre-auth: capture the login screen itself (never reached by login()).
    await page.addInitScript(freezeClock);
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector(".login", { timeout: 20000 });
  } else {
    await login(page);
  }
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await page.waitForTimeout(bare ? 250 : 150);
  if (prep) await prep(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outdir}/${name}.png` });
  await ctx.close();
  console.log("  ✓", name);
}

const openFirstConv = async (page) => { await page.locator(".conv").first().click(); await page.waitForSelector(".thread__head h2", { timeout: 8000 }); };

console.log("capturing ->", outdir, "(FIXED=" + FIXED + ")");
// Desktop: full app with a conversation open (Sidebar, List, Thread, Composer, IconRail)
await shot("desktop-light", { width: 1360, height: 900, theme: "light", prep: openFirstConv });
await shot("desktop-dark", { width: 1360, height: 900, theme: "dark", prep: openFirstConv });
// Mobile: list pane, and thread pane
await shot("mobile-list-light", { width: 390, height: 844, mobile: true, theme: "light" });
await shot("mobile-list-dark", { width: 390, height: 844, mobile: true, theme: "dark" });
await shot("mobile-thread-light", { width: 390, height: 844, mobile: true, theme: "light", prep: openFirstConv });
await shot("mobile-thread-dark", { width: 390, height: 844, mobile: true, theme: "dark", prep: openFirstConv });
// Mobile drawer open (Sidebar in full, incl. its footer)
const openDrawer = async (page) => { await page.locator(".list__burger").first().click(); await page.waitForTimeout(500); };
await shot("mobile-drawer-light", { width: 390, height: 844, mobile: true, theme: "light", prep: openDrawer });
await shot("mobile-drawer-dark", { width: 390, height: 844, mobile: true, theme: "dark", prep: openDrawer });

// Pre-auth login screen (LoginScreen + its .btn / .field primitives)
await shot("login-light", { width: 1360, height: 900, theme: "light", bare: true });
await shot("login-dark", { width: 1360, height: 900, theme: "dark", bare: true });

// Settings pane (Settings — .field / .btn / .switch / .iconbtn primitives, tabs)
const openSettings = async (page) => { await page.click('.railbtn[title="Settings"]'); await page.waitForSelector('[aria-label="Settings"]', { timeout: 8000 }); await page.waitForTimeout(300); };
await shot("desktop-settings-light", { width: 1360, height: 900, theme: "light", prep: openSettings });
await shot("desktop-settings-dark", { width: 1360, height: 900, theme: "dark", prep: openSettings });

// Customers directory (Customers — reuses .settings shell; .tag, .av, .btn primitives)
const openCustomers = async (page) => { await page.click('.railbtn[title="Customers"]'); await page.waitForSelector('[aria-label="Customers"]', { timeout: 8000 }); await page.waitForTimeout(300); };
await shot("desktop-customers-light", { width: 1360, height: 900, theme: "light", prep: openCustomers });
await shot("desktop-customers-dark", { width: 1360, height: 900, theme: "dark", prep: openCustomers });

// Wide desktop (>1399px) so the ContextPanel (.panel) shows inline alongside the thread
await shot("desktop-wide-light", { width: 1440, height: 900, theme: "light", prep: openFirstConv });
await shot("desktop-wide-dark", { width: 1440, height: 900, theme: "dark", prep: openFirstConv });

await b.close();
console.log("done.");
