// GENERATED FILE — DO NOT EDIT.
//
// Written by scripts/generate-tokens.mjs from tokens.css, which is the single
// source of truth for both platforms. Change a value there and re-run
// `pnpm --filter @ding/design build`; editing this file is undone by the next
// generate, and CI fails when the two disagree.
//
// The web reads tokens.css directly through `var()`. React Native has no
// cascade, so it reads these — the same numbers, resolved: `var()` references
// followed, and `color-mix(…, transparent)` flattened to rgba.

/** The light palette. `dark` has exactly the same keys. */
export const light = {
  bg: "#FAFAF9",
  surface: "#FFFFFF",
  surface2: "#F1F3F5",
  elevated: "#FFFFFF",
  border: "#E8E7E4",
  borderStrong: "#D8D7D3",
  text: "#1A1A18",
  textMuted: "#6B6B67",
  textFaint: "#9A9A95",
  brand: "#1DAA61",
  brandStrong: "#128048",
  brandTint: "#E3F6E9",
  brandRing: "rgba(29, 170, 97, 0.35)",
  amber: "#E68A00",
  amberTint: "#FBEFD9",
  danger: "#E0544D",
  dangerTint: "#FBE7E5",
  wa: "#1FBE5B",
  email: "#5B8DEF",
  group: "#A06CF2",
  nestchat: "#D94590",
  sms: "#0E9AA7",
  ai: "#C15F3C",
  hover: "rgba(26, 26, 24, 0.04)",
  sel: "rgba(26, 26, 24, 0.065)",
  glass: "#FFFFFF",
  glassBrd: "rgba(26, 26, 24, 0.08)",
  glassLine: "rgba(26, 26, 24, 0.07)",
  glassHi: "rgba(255, 255, 255, 0.62)",
  scrim: "rgba(24, 24, 22, 0.3)",
} as const;

export const dark = {
  bg: "#0D0D0C",
  surface: "#151514",
  surface2: "#1C1C1A",
  elevated: "#1F1F1D",
  border: "#282826",
  borderStrong: "#383835",
  text: "#ECECEA",
  textMuted: "#9A9A94",
  textFaint: "#6E6E69",
  brand: "#3CC27A",
  brandStrong: "#2BA866",
  brandTint: "#0E2418",
  brandRing: "rgba(60, 194, 122, 0.4)",
  amber: "#F2A73C",
  amberTint: "#2A2012",
  danger: "#F0716B",
  dangerTint: "#2B1615",
  wa: "#33D06B",
  email: "#78A0F5",
  group: "#B98BF6",
  nestchat: "#F077B8",
  sms: "#3CC4CF",
  ai: "#E08159",
  hover: "rgba(236, 236, 234, 0.04)",
  sel: "rgba(236, 236, 234, 0.065)",
  glass: "#1F1F1D",
  glassBrd: "rgba(236, 236, 234, 0.08)",
  glassLine: "rgba(236, 236, 234, 0.07)",
  glassHi: "rgba(255, 255, 255, 0.11)",
  scrim: "rgba(0, 0, 0, 0.58)",
} as const;

/** One theme's colours. Index with `colors[scheme]`. `as const` above gives
 *  each value a literal type, which is useful for autocomplete but would make
 *  `dark` incompatible with `light` — so the shared shape widens to string. */
export type ThemeColors = { readonly [K in keyof typeof light]: string };
export const colors: Record<"light" | "dark", ThemeColors> = { light, dark };

/** Corner radii, in px. `full` is the pill. */
export const radius = {
  r2: 2,
  r4: 4,
  r6: 6,
  r8: 8,
  r12: 12,
  r16: 16,
  r20: 20,
  r24: 24,
  full: 9999,
  sm: 8,
  lg: 16,
} as const;

/** The spacing step scale, in px. */
export const space = {
  sp1: 4,
  sp2: 8,
  sp3: 12,
  sp4: 16,
  sp5: 20,
  sp6: 24,
  sp8: 32,
  sp10: 40,
  sp12: 48,
  sp16: 64,
} as const;

/** Type scale, in px. */
export const fontSize = {
  fs2xs: 11,
  xs: 12,
  sm: 13,
  md: 14,
  lg: 16,
  xl: 18,
  fs2xl: 24,
} as const;

/** Three weights, plus 700 for numerals that must punch. */
export const fontWeight = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
} as const;

/** Unitless line-height multipliers — multiply by the font size for native. */
export const lineHeight = {
  tight: 1.25,
  snug: 1.4,
  body: 1.5,
} as const;

/** Tracking in em. Native wants px: `fontSize * letterSpacing.tight`. */
export const letterSpacing = {
  tight: -0.02,
  snug: -0.01,
  caps: 0.06,
} as const;

/** Motion durations, in ms. */
export const duration = {
  fast: 120,
  base: 160,
  slow: 240,
} as const;

/** The font stacks, as authored for CSS. Native resolves its own system font,
 *  so this is here for completeness rather than for use in a style object. */
export const fontFamily = {
  sans: "-apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,\"Helvetica Neue\",Arial,sans-serif",
  mono: "ui-monospace,\"SF Mono\",\"Cascadia Code\",Menlo,Consolas,monospace",
} as const;
