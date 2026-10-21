/**
 * Every icon in the product, as path data, in one place.
 *
 * There used to be two icon files — `apps/web/src/lib/icons.tsx` and
 * `apps/mobile/src/icons.tsx` — with a comment on the second asking whoever
 * touched one to touch the other. They drifted anyway: the web grew a dozen
 * glyphs the app never got, the app grew two the web doesn't have, and the
 * shared ones picked up eight different stroke weights between them. A set of
 * icons only reads as a set when it *is* one, so this is the set, and each app
 * only supplies the rendering.
 *
 * ## The system
 *
 * - **24×24, ~20×20 live.** Every glyph sits in the same box with the same
 *   margin, so none of them looks larger than its neighbours at the same size.
 * - **One stroke weight**, {@link ICON_STROKE}. This is the single biggest
 *   reason the old set read as unsystematic: it ranged from 1.7 to 2.4, and the
 *   eye reads that as sloppiness long before it can name it.
 * - **Round caps and joins, always.** The previous set only set them on about
 *   a quarter of its glyphs; the rest ended in square butt caps and mitred
 *   corners, which is precisely the "boxy" everyone could see and nobody could
 *   point at. It is not a per-icon choice here — the renderers set it once.
 * - **Generous corner radii.** Rectangles are r3.6 rather than r2 at this size.
 * - **No `<circle>`/`<rect>` elements.** Both are expressible as path data, and
 *   collapsing to one primitive means an icon is one string, a renderer is ten
 *   lines, and the old special-case switch for "which team icons also need a
 *   circle" is gone.
 *
 * ## The shape of an entry
 *
 * `d` is stroked; `fill` is filled. Most glyphs are one or the other; a few
 * (the tag's punch-hole, the smiley's eyes) are both, which is why they're
 * separate fields rather than a mode flag.
 */

/**
 * The stroke weight for every outlined glyph.
 *
 * 1.8 rather than a rounder 1.5 or 2: it was the most common value in the set
 * being replaced, so unifying on it snaps the outliers into line without
 * changing the weight of the icons that were already right.
 */
export const ICON_STROKE = 1.8;

/** A full circle, as two arcs, starting at the top. */
const circle = (cx: number, cy: number, r: number): string =>
  `M${cx} ${cy - r}a${r} ${r} 0 1 0 0 ${r * 2}a${r} ${r} 0 1 0 0 ${-r * 2}`;

/** A rounded rectangle, clockwise from the top-left corner's end. */
const box = (x: number, y: number, w: number, h: number, r: number): string =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}` +
  `h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`;

export interface IconSpec {
  /** Outline, stroked in the icon's colour at {@link ICON_STROKE}. */
  d?: string;
  /** Solid shapes, filled in the icon's colour. */
  fill?: string;
  /** Only where a glyph isn't square — the read-receipt ticks. */
  viewBox?: string;
}

/* ─────────────────────────────────────────────────────────── navigation ── */

export const icons = {
  /** A tray with the classic dip, so it isn't just a rectangle. */
  inbox: {
    d:
      box(3, 5, 18, 14, 3.6) +
      "M3 13.4h3.7a1.5 1.5 0 0 1 1.34.83l.32.64a1.5 1.5 0 0 0 1.34.83h4.6a1.5 1.5 0 0 0 1.34-.83l.32-.64a1.5 1.5 0 0 1 1.34-.83H21",
  },
  contacts: {
    d:
      circle(9.2, 8.4, 3.3) +
      "M3.4 19.7a5.8 5.8 0 0 1 11.6 0" +
      "M16.6 6.1a3.4 3.4 0 0 1 0 6.6M18 19.7a5.5 5.5 0 0 0-2.7-4.6",
  },
  /** Three bars. Round caps turn them into pills, which is the whole point. */
  insights: { d: "M6 19.6v-6.2M12 19.6V5.4M18 19.6v-9.4" },
  /**
   * The gear, kept.
   *
   * It looks like a wall of numbers because every tooth is a rounded corner
   * rather than a mitre — which is exactly the property the rest of this set
   * was missing, so it is the one glyph that was already right.
   */
  settings: {
    d:
      "M10.32 3.2a1 1 0 0 1 .98-.8h1.4a1 1 0 0 1 .98.8l.26 1.36a6.9 6.9 0 0 1 1.7 1l1.32-.46a1 1 0 0 1 1.18.44l.7 1.21a1 1 0 0 1-.2 1.26l-1.06.92a6.95 6.95 0 0 1 0 1.96l1.06.92a1 1 0 0 1 .2 1.26l-.7 1.21a1 1 0 0 1-1.18.44l-1.32-.46a6.9 6.9 0 0 1-1.7 1l-.26 1.36a1 1 0 0 1-.98.8h-1.4a1 1 0 0 1-.98-.8l-.26-1.36a6.9 6.9 0 0 1-1.7-1l-1.32.46a1 1 0 0 1-1.18-.44l-.7-1.21a1 1 0 0 1 .2-1.26l1.06-.92a6.95 6.95 0 0 1 0-1.96l-1.06-.92a1 1 0 0 1-.2-1.26l.7-1.21a1 1 0 0 1 1.18-.44l1.32.46a6.9 6.9 0 0 1 1.7-1l.26-1.36Z" +
      circle(12, 12, 2.8),
  },
  /** Half-filled circle: the one light/dark mark that doesn't read as a moon. */
  contrast: { d: circle(12, 12, 8.6) + "M12 3.4v17.2" },
  /** Moon — shown in light mode, meaning "go dark". */
  theme: { d: "M20.6 13.2A8.6 8.6 0 1 1 10.8 3.4a6.7 6.7 0 0 0 9.8 9.8Z" },
  /** Sun — shown in dark mode, meaning "go light". */
  sun: {
    d:
      circle(12, 12, 4) +
      "M12 2.8v1.6M12 19.6v1.6M5.05 5.05l1.13 1.13M17.82 17.82l1.13 1.13" +
      "M2.8 12h1.6M19.6 12h1.6M5.05 18.95l1.13-1.13M17.82 6.18l1.13-1.13",
  },
  search: { d: circle(10.8, 10.8, 6.8) + "M15.9 15.9 20 20" },
  menu: { d: "M4 6.5h16M4 12h16M4 17.5h16" },
  more: { fill: circle(5.2, 12, 1.9) + circle(12, 12, 1.9) + circle(18.8, 12, 1.9) },

  /* ── arrows and chevrons ───────────────────────────────────────────── */

  plus: { d: "M12 5.2v13.6M5.2 12h13.6" },
  x: { d: "m6.6 6.6 10.8 10.8M17.4 6.6 6.6 17.4" },
  check: { d: "m4.8 12.6 4.8 4.8 9.6-10.8" },
  back: { d: "m14.6 18.4-6.4-6.4 6.4-6.4" },
  chevronDown: { d: "m6.6 9.4 5.4 5.4 5.4-5.4" },
  chevronUp: { d: "m6.6 14.6 5.4-5.4 5.4 5.4" },
  chevronRight: { d: "m9.4 6.6 5.4 5.4-5.4 5.4" },
  chevronsLeft: { d: "m11 6.6-5.4 5.4 5.4 5.4M18 6.6 12.6 12l5.4 5.4" },
  send: { d: "M4.4 12h14.2M12.8 6.2 18.6 12l-5.8 5.8" },
  reply: { d: "M9 7.8 4.2 12 9 16.2M4.6 12h9.6a5.8 5.8 0 0 1 5.8 5.8v1.4" },
  // Reply, with a second arrowhead behind it — the one difference every mail
  // client draws, so it reads without a label. Same tail as `reply`, shifted
  // right to make room, so the two sit together in a menu.
  replyAll: { d: "M7.4 7.8 2.6 12l4.8 4.2M12.2 7.8 7.4 12l4.8 4.2M7.8 12h6.4a5.8 5.8 0 0 1 5.8 5.8v1.4" },
  /** Reply's mirror. The pair has to read as a pair. */
  forward: { d: "m15 7.8 4.8 4.2-4.8 4.2M19.4 12H9.8A5.8 5.8 0 0 0 4 17.8v1.4" },
  // Arrowhead as one polyline through the tip, so the vertex gets a real round
  // join rather than two capped strokes meeting at a point.
  download: { d: "M12 4.2v10.2M8.4 10.8 12 14.4l3.6-3.6M5.2 19h13.6" },
  refresh: { d: "M20.6 12a8.6 8.6 0 1 1-2.52-6.08M20.6 4.4v4.4h-4.4" },
  reopen: { d: "M3.4 12a8.6 8.6 0 1 0 2.52-6.08M3.4 3.6V8h4.4" },
  logout: {
    d: "M9.4 20.6H6.4a2.2 2.2 0 0 1-2.2-2.2V5.6a2.2 2.2 0 0 1 2.2-2.2h3M15.8 16.4 20.2 12l-4.4-4.4M20.2 12H9.4",
  },

  /* ── conversation state ────────────────────────────────────────────── */

  clock: { d: circle(12, 12, 8.6) + "M12 7.2V12l3 1.9" },
  /** A clock with an alarm bar over it — snoozed, not merely timed. */
  snooze: { d: circle(12, 13.2, 7.8) + "M12 9.4v3.8l2.6 2.4M9 2.6h6" },
  checkCircle: { d: circle(12, 12, 8.6) + "M8.2 12.2 10.8 14.8 15.8 9.2" },
  alert: { d: circle(12, 12, 8.6) + "M12 7.6v4.8", fill: circle(12, 16.1, 1.15) },
  eye: { d: "M2.6 12S6 5.6 12 5.6 21.4 12 21.4 12 18 18.4 12 18.4 2.6 12 2.6 12Z" + circle(12, 12, 3.1) },
  profile: { d: circle(12, 8, 4) + "M4.2 20a7.8 7.8 0 0 1 15.6 0" },
  /** A padlock. The lock target a held voice recording slides up onto. */
  lock: { d: box(4.6, 10.4, 14.8, 10, 3) + "M8.4 10.4V7.6a3.6 3.6 0 0 1 7.2 0v2.8" },
  /** A luggage tag with a punched hole. */
  tag: {
    d: "M11.7 3H5.6A2.6 2.6 0 0 0 3 5.6v6.1a2.2 2.2 0 0 0 .64 1.56l7.7 7.7a2.2 2.2 0 0 0 3.12 0l6.1-6.1a2.2 2.2 0 0 0 0-3.12l-7.7-7.7A2.2 2.2 0 0 0 11.7 3Z",
    fill: circle(7.9, 7.9, 1.35),
  },
  bell: {
    d:
      "M18.4 9.2a6.4 6.4 0 1 0-12.8 0c0 4.4-1.05 6.2-1.88 7.2a1 1 0 0 0 .77 1.64h15.02a1 1 0 0 0 .77-1.64c-.83-1-1.88-2.8-1.88-7.2Z" +
      "M14.2 20.6a2.4 2.4 0 0 1-4.4 0",
  },
  at: { d: circle(12, 12, 3.9) + "M15.9 8.1v5.1a3.05 3.05 0 0 0 6.1 0V12a10 10 0 1 0-3.9 7.94" },

  /* ── the composer ──────────────────────────────────────────────────── */

  attach: {
    d: "M20.7 11.6 12.4 19.9a5 5 0 0 1-7.07-7.07l8-8a3.3 3.3 0 0 1 4.67 4.67l-7.96 7.96a1.6 1.6 0 0 1-2.26-2.26l7.32-7.32",
  },
  emoji: {
    d: circle(12, 12, 8.6) + "M8.4 14.2a4.6 4.6 0 0 0 7.2 0",
    fill: circle(9.2, 9.8, 1.15) + circle(14.8, 9.8, 1.15),
  },
  /** A speech bubble with a soft tail — an internal note. */
  note: {
    d: "M6 4.4h12a2.2 2.2 0 0 1 2.2 2.2v8.2a2.2 2.2 0 0 1-2.2 2.2h-7.6l-3.9 3.1a.7.7 0 0 1-1.14-.55V17H6a2.2 2.2 0 0 1-2.2-2.2V6.6A2.2 2.2 0 0 1 6 4.4Z",
  },
  mic: {
    d: box(8.9, 2.6, 6.2, 11.2, 3.1) + "M5.4 11.2a6.6 6.6 0 0 0 13.2 0M12 17.8v3.2M8.6 21h6.8",
  },
  camera: {
    d:
      "M4 8.4h2.9l1.3-2.1a1.5 1.5 0 0 1 1.28-.72h5.04a1.5 1.5 0 0 1 1.28.72l1.3 2.1H20a1.5 1.5 0 0 1 1.5 1.5v8.1A1.5 1.5 0 0 1 20 19.5H4a1.5 1.5 0 0 1-1.5-1.5V9.9A1.5 1.5 0 0 1 4 8.4Z" +
      circle(12, 13.4, 3.5),
  },
  image: {
    d:
      box(3, 4.4, 18, 15.2, 3.6) +
      "M4.1 17.4 8.1 13.4a2 2 0 0 1 2.83 0l4.6 4.6",
    fill: circle(8.6, 9.6, 1.5),
  },
  /** Four-point sparkle: AI assist. */
  sparkle: {
    d:
      "M12 3.4c.7 3.4 1.9 4.6 5.3 5.3-3.4.7-4.6 1.9-5.3 5.3-.7-3.4-1.9-4.6-5.3-5.3 3.4-.7 4.6-1.9 5.3-5.3Z" +
      "M18 15.2c.35 1.7.95 2.3 2.65 2.65-1.7.35-2.3.95-2.65 2.65-.35-1.7-.95-2.3-2.65-2.65 1.7-.35 2.3-.95 2.65-2.65Z",
  },
  bolt: { fill: "M13.6 2.4a.7.7 0 0 1 1.22.62l-1.1 6.18h4.62a.9.9 0 0 1 .72 1.44l-8.68 11.0a.7.7 0 0 1-1.22-.62l1.1-6.18H5.64a.9.9 0 0 1-.72-1.44Z" },
  compose: {
    d: "M12 4.4H6.4a2.2 2.2 0 0 0-2.2 2.2v11a2.2 2.2 0 0 0 2.2 2.2h11a2.2 2.2 0 0 0 2.2-2.2V12M18.1 2.9a2.15 2.15 0 0 1 3.04 3.04L12.2 14.9l-4.1 1.06 1.06-4.1Z" },
  edit: { d: "M4.4 19.6h4L18.6 9.4a2.05 2.05 0 0 0-2.9-2.9L5.5 16.7ZM13.6 6.6l3.8 3.8" },
  trash: {
    d: "M4.4 7h15.2M9.2 7V5.2a1.2 1.2 0 0 1 1.2-1.2h3.2a1.2 1.2 0 0 1 1.2 1.2V7M6.2 7l.86 12.1a1.4 1.4 0 0 0 1.4 1.3h7.08a1.4 1.4 0 0 0 1.4-1.3L17.8 7M10.2 11v5.6M13.8 11v5.6",
  },
  doc: {
    d: "M13.8 3.2v4.4a1.4 1.4 0 0 0 1.4 1.4h4.4M13.8 3.2H6.9a1.7 1.7 0 0 0-1.7 1.7v14.2a1.7 1.7 0 0 0 1.7 1.7h10.2a1.7 1.7 0 0 0 1.7-1.7V8.1Z",
  },
  link: {
    d: "M9.6 13.4a4.1 4.1 0 0 0 5.8 0l3-3a4.1 4.1 0 1 0-5.8-5.8l-1.5 1.5M14.4 10.6a4.1 4.1 0 0 0-5.8 0l-3 3a4.1 4.1 0 1 0 5.8 5.8l1.5-1.5",
  },
  soundOn: { d: "M11.4 4.9a.6.6 0 0 1 .6.6v13a.6.6 0 0 1-.98.47L6.6 15.2H3.8a1.2 1.2 0 0 1-1.2-1.2v-4a1.2 1.2 0 0 1 1.2-1.2h2.8l4.42-3.77a.6.6 0 0 1 .38-.13ZM16 9.4a3.9 3.9 0 0 1 0 5.2M18.6 6.6a7.8 7.8 0 0 1 0 10.8" },
  soundOff: { d: "M11.4 4.9a.6.6 0 0 1 .6.6v13a.6.6 0 0 1-.98.47L6.6 15.2H3.8a1.2 1.2 0 0 1-1.2-1.2v-4a1.2 1.2 0 0 1 1.2-1.2h2.8l4.42-3.77a.6.6 0 0 1 .38-.13ZM16.4 9.6l4.8 4.8M21.2 9.6l-4.8 4.8" },
  play: { fill: "M8.4 5.5a1.3 1.3 0 0 1 1.98-1.1l9.7 6.5a1.3 1.3 0 0 1 0 2.2l-9.7 6.5A1.3 1.3 0 0 1 8.4 18.5Z" },
  pause: { fill: box(6.2, 4.8, 4.2, 14.4, 1.6) + box(13.6, 4.8, 4.2, 14.4, 1.6) },
  star: { d: "m12 3.4 2.66 5.39 5.94.87-4.3 4.19 1.02 5.92L12 16.97l-5.32 2.8 1.02-5.92-4.3-4.19 5.94-.87Z" },
  storage: { d: "M7 18.6a4.1 4.1 0 0 1-.62-8.15 5.6 5.6 0 0 1 10.83-1.45A3.85 3.85 0 0 1 17 18.6Z" },
  /** Branching arrows — a conversation going one way or the other. */
  route: {
    d:
      "M3.2 12h3.1a4 4 0 0 0 3.3-1.75l1.5-2.2A4 4 0 0 1 14.4 6.3h3.9" +
      "M9.6 13.75l1.5 2.2a4 4 0 0 0 3.3 1.75h3.9" +
      "M15.6 3.6 18.8 6.3l-3.2 2.7M15.6 15.1l3.2 2.6-3.2 2.7",
  },
  panelLeft: { d: box(3, 4.4, 18, 15.2, 3.6) + "M9.2 4.4v15.2" },
  /** The same panel, divided the other way — "show details". */
  details: { d: box(3, 4.4, 18, 15.2, 3.6) + "M14.8 4.4v15.2" },
  // The real ⌘ knot, not a keycap: it sits next to a literal "K" in the
  // command-menu hint, so it has to read as the symbol rather than as a box
  // with lines in it. One continuous stroke — four loops off a centre square.
  cmd: { d: "M15 6.6v10.8a2.7 2.7 0 1 0 2.7-2.7H6.3a2.7 2.7 0 1 0 2.7 2.7V6.6a2.7 2.7 0 1 0-2.7 2.7h11.4a2.7 2.7 0 1 0-2.7-2.7" },
  mail: { d: box(3, 5.2, 18, 13.6, 3.2) + "M3.7 7.8 11.05 12.9a1.65 1.65 0 0 0 1.9 0L20.3 7.8" },
  phone: {
    d:
      "M21 16.43v2.7a1.8 1.8 0 0 1-1.96 1.8 17.81 17.81 0 0 1-7.77-2.76" +
      "a17.55 17.55 0 0 1-5.4-5.4 17.81 17.81 0 0 1-2.76-7.8A1.8 1.8 0 0 1 4.9 3h2.7" +
      "a1.8 1.8 0 0 1 1.8 1.55 11.56 11.56 0 0 0 .63 2.53 1.8 1.8 0 0 1-.41 1.9" +
      "L8.48 10.12a14.4 14.4 0 0 0 5.4 5.4l1.14-1.14a1.8 1.8 0 0 1 1.9-.41" +
      " 11.56 11.56 0 0 0 2.53.63A1.8 1.8 0 0 1 21 16.43Z",
  },
} satisfies Record<string, IconSpec>;

export type IconName = keyof typeof icons;

/* ───────────────────────────────────────────────── the read-receipt ticks ── */

/**
 * The delivery ticks, in their own wider boxes.
 *
 * Not square, because two overlapping ticks need the room and squeezing them
 * into 24×24 would make each stroke shorter than the single tick's — which
 * reads as a different weight sitting next to it in the same line of text.
 */
export const tickIcons = {
  checkSingle: { viewBox: "0 0 18 14", d: "m2 8 4 4 9.4-10.4" },
  checkDouble: { viewBox: "0 0 22 14", d: "m1 8 3.5 3.5L12.2 2M9.2 11.2l1 1L19 2.4" },
} satisfies Record<string, IconSpec>;

/* ───────────────────────────────────────────────────────── channel marks ── */

/**
 * Filled brand glyphs. These are marks, not icons — WhatsApp's is theirs, and
 * redrawing it "on grid" would make it wrong rather than consistent. They are
 * left alone deliberately.
 */
export const channelIcons = {
  whatsapp: {
    fill: "M12.04 2.5c-5.2 0-9.42 4.22-9.42 9.42 0 1.66.44 3.28 1.26 4.71L2.5 21.5l4.99-1.31a9.4 9.4 0 0 0 4.55 1.16c5.2 0 9.42-4.22 9.42-9.42 0-2.52-.98-4.89-2.76-6.67a9.36 9.36 0 0 0-6.66-2.76Zm5.5 13.4c-.23.65-1.36 1.25-1.87 1.32-.48.07-1.09.1-1.76-.11-.4-.13-.93-.3-1.6-.59-2.82-1.22-4.66-4.06-4.8-4.25-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07.99-2.36.26-.28.57-.35.76-.35.19 0 .38 0 .54.01.17.01.41-.07.64.49.23.57.8 1.97.87 2.11.07.14.12.31.02.5-.09.19-.14.31-.28.47-.14.17-.29.37-.42.5-.14.14-.28.29-.12.57.16.28.71 1.17 1.53 1.9 1.05.94 1.94 1.23 2.22 1.37.28.14.44.12.6-.07.16-.19.69-.81.88-1.09.19-.28.37-.23.64-.14.26.1 1.66.78 1.94.93.28.14.47.21.54.32.07.12.07.7-.16 1.35Z",
  },
  group: {
    fill: "M8.5 11.4a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm7 .1a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8Zm-7 1.3c-3 0-5.6 1.55-5.6 3.85V18.4h11.2v-1.75c0-2.3-2.6-3.85-5.6-3.85Zm7 .25c-.44 0-.86.04-1.26.11 1.05.86 1.66 1.98 1.66 3.24v1.4h5.2v-1.6c0-2.02-2.55-3.15-5.6-3.15Z",
  },
  email: {
    fill: "M4 5h16c1.1 0 2 .9 2 2v.5l-10 5.6L2 7.5V7c0-1.1.9-2 2-2Zm18 4.8V17c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V9.8l9.52 5.33c.3.16.66.16.96 0L22 9.8Z",
  },
  /**
   * NestChat — our own live chat. A speech bubble with a tail, kept solid so it
   * reads at the 8px dot size the conversation list uses; the WhatsApp mark is
   * also a bubble, so this one is squarer, and its tail hangs from the left
   * rather than the corner.
   */
  nestchat: {
    fill: "M6 3.4h12A3.6 3.6 0 0 1 21.6 7v6.6A3.6 3.6 0 0 1 18 17.2h-6.1l-4.2 3.4a.85.85 0 0 1-1.38-.66V17.2H6a3.6 3.6 0 0 1-3.6-3.6V7A3.6 3.6 0 0 1 6 3.4Z",
  },
  /** Gmail's envelope, with the tell-tale "M" valley. Coloured Gmail red. */
  gmail: {
    fill: "M4 5h1.4L12 9.9 18.6 5H20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-2.6v-8.2L12 14 6.6 9.8V19H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  },
  /** Outlook's slanted tile with its "O" cut out, an envelope behind it.
   *  The hole is wound the other way, so it punches through under nonzero. */
  outlook: {
    fill: "M3 5.5 13 4v16L3 18.5Z M8 9a2.4 3 0 1 0 0 6 2.4 3 0 1 0 0-6Z",
    d: "M13 7h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-7 M13 9.5l4 3 4-3",
  },
} satisfies Record<string, IconSpec>;

/* ──────────────────────────────────────────────────── the team icon library ── */

/** What Settings › Teams offers. Same keys on both clients, same glyphs. */
export const teamIcons = {
  headset: {
    d:
      "M4.2 13.2v-1.2a7.8 7.8 0 0 1 15.6 0v1.2" +
      "M4.4 13.2a2.1 2.1 0 0 1 2.1 2.1v1.9a2.1 2.1 0 1 1-4.2 0v-1.9a2.1 2.1 0 0 1 2.1-2.1Z" +
      "M19.6 13.2a2.1 2.1 0 0 1 2.1 2.1v1.9a2.1 2.1 0 1 1-4.2 0v-1.9a2.1 2.1 0 0 1 2.1-2.1Z" +
      "M19.8 17.4v.8a3.1 3.1 0 0 1-3.1 3.1h-2.9",
  },
  cart: {
    d: "M2.8 4.2h1.9l2.34 10.9a1.2 1.2 0 0 0 1.17.93h7.98a1.2 1.2 0 0 0 1.17-.92L20.2 8.2H6" + circle(9.2, 19.6, 1.5) + circle(17.6, 19.6, 1.5),
  },
  truck: {
    d:
      "M2.6 8a1.8 1.8 0 0 1 1.8-1.8h8v9.2H2.6Z" +
      "M14 9.6h3.3a1.8 1.8 0 0 1 1.42.7l2.1 2.7a1.8 1.8 0 0 1 .38 1.1v1.3H14Z" +
      circle(7.2, 17.9, 1.7) +
      circle(17.4, 17.9, 1.7),
  },
  wrench: {
    d: "M14.9 6.2a4.1 4.1 0 0 0-5.6 5.4l-5.4 5.4 3.2 3.2 5.4-5.4a4.1 4.1 0 0 0 5.4-5.6l-2.5 2.5-2.4-.6-.6-2.4Z",
  },
  briefcase: { d: box(2.8, 6.8, 18.4, 13.4, 2.6) + "M8.2 6.8V5a2.1 2.1 0 0 1 2.1-2.1h3.4A2.1 2.1 0 0 1 15.8 5v1.8M2.8 12.2h18.4" },
  userplus: { d: circle(9.2, 8.2, 3.4) + "M3.4 19.8a5.8 5.8 0 0 1 11.6 0M18.6 8.2v6M15.6 11.2h6" },
  users: {
    d:
      circle(9.2, 8.4, 3.3) +
      "M3.4 19.7a5.8 5.8 0 0 1 11.6 0M16.6 6.1a3.4 3.4 0 0 1 0 6.6M18 19.7a5.5 5.5 0 0 0-2.7-4.6",
  },
  star: { d: "m12 3.4 2.66 5.39 5.94.87-4.3 4.19 1.02 5.92L12 16.97l-5.32 2.8 1.02-5.92-4.3-4.19 5.94-.87Z" },
  flag: { d: "M5.2 21V3.6M5.2 4.8h11.2l-2 3.1 2 3.1H5.2" },
  bolt: { d: "M13.4 2.6 4.6 14.2h6.6l-1 7.2 8.8-11.6h-6.6Z" },
  shield: { d: "M12 3.2 19 6.2v4.9c0 4.4-2.9 7.9-7 9.7-4.1-1.8-7-5.3-7-9.7V6.2Z" },
  heart: { d: "M12 20.2S4.2 15.2 4.2 9.7A3.7 3.7 0 0 1 12 7.1a3.7 3.7 0 0 1 7.8 2.6c0 5.5-7.8 10.5-7.8 10.5Z" },
  tag: {
    d: "M11.7 3H5.6A2.6 2.6 0 0 0 3 5.6v6.1a2.2 2.2 0 0 0 .64 1.56l7.7 7.7a2.2 2.2 0 0 0 3.12 0l6.1-6.1a2.2 2.2 0 0 0 0-3.12l-7.7-7.7A2.2 2.2 0 0 0 11.7 3Z" + circle(7.9, 7.9, 1.35),
  },
  box: { d: "M12 3.2 4.4 7.1v9.8l7.6 3.9 7.6-3.9V7.1ZM4.4 7.1 12 11l7.6-3.9M12 20.8V11" },
  calendar: { d: box(3, 5.2, 18, 15.8, 3.2) + "M3 10h18M8.2 3.2v4M15.8 3.2v4" },
  chart: { d: "M4.2 3.8v16h16M8.8 16.2v-5M13 16.2V8M17.2 16.2v-3.2" },
  globe: { d: circle(12, 12, 8.6) + "M3.4 12h17.2M12 3.4c2.6 2.6 2.6 15.4 0 17.2M12 3.4c-2.6 2.6-2.6 15.4 0 17.2" },
  phone: {
    d:
      "M21 16.43v2.7a1.8 1.8 0 0 1-1.96 1.8 17.81 17.81 0 0 1-7.77-2.76" +
      "a17.55 17.55 0 0 1-5.4-5.4 17.81 17.81 0 0 1-2.76-7.8A1.8 1.8 0 0 1 4.9 3h2.7" +
      "a1.8 1.8 0 0 1 1.8 1.55 11.56 11.56 0 0 0 .63 2.53 1.8 1.8 0 0 1-.41 1.9" +
      "L8.48 10.12a14.4 14.4 0 0 0 5.4 5.4l1.14-1.14a1.8 1.8 0 0 1 1.9-.41" +
      " 11.56 11.56 0 0 0 2.53.63A1.8 1.8 0 0 1 21 16.43Z",
  },
} satisfies Record<string, IconSpec>;

export type TeamIconName = keyof typeof teamIcons;
export const TEAM_ICON_NAMES = Object.keys(teamIcons) as TeamIconName[];
