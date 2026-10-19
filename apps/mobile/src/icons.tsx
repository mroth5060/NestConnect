import type { ColorValue } from "react-native";
import Svg, { Path, type SvgProps } from "react-native-svg";
import type { JSX } from "react";
import type { ChannelType } from "@ding/schemas";
import {
  ICON_STROKE,
  channelIcons,
  icons,
  teamIcons,
  tickIcons,
  type IconSpec,
} from "@ding/design/icons";
import type { ThemeColors } from "./theme";

/**
 * The icon set, rendered for react-native-svg.
 *
 * The geometry lives in `@ding/design/icons` and is shared with the web. It used
 * to be copied here by hand, with a comment on both files asking whoever edited
 * one to edit the other; they drifted anyway — different stroke weights, a dozen
 * glyphs the app never received, and two the web never got. Now there is one set
 * and two renderers, and this is the renderer.
 *
 * Round caps and joins and the single stroke weight are applied here, once, for
 * every glyph — not chosen per icon, which is how the old set lost them.
 *
 * The one necessary difference from the web is colour. The web leans on
 * `currentColor` and lets CSS cascade a colour in; React Native has no cascade,
 * so every icon takes an explicit `color`. `size` sets both width and height,
 * since every glyph but the ticks is drawn in a square box.
 */
export interface IconProps {
  /** Width and height in px. The viewBox is square, so one number does both. */
  size?: number;
  /** `ColorValue` rather than `string` because React Navigation hands its tab
   *  icons one, and react-native-svg accepts it as a paint. */
  color?: ColorValue;
}

type P = IconProps & Omit<SvgProps, "color">;

/**
 * Turn a spec into a component.
 *
 * Non-square glyphs (the ticks) keep their aspect ratio off `size` as the
 * height, so a tick set next to a timestamp matches the type's height rather
 * than being squashed into a square.
 */
function glyph(spec: IconSpec, fallbackSize = 22) {
  const [, , vw, vh] = (spec.viewBox ?? "0 0 24 24").split(" ").map(Number);
  return function Icon({ size = fallbackSize, color = "currentColor", ...rest }: P): JSX.Element {
    return (
      <Svg
        width={(size * vw) / vh}
        height={size}
        viewBox={spec.viewBox ?? "0 0 24 24"}
        fill="none"
        {...rest}
      >
        {spec.d ? (
          <Path
            d={spec.d}
            stroke={color}
            strokeWidth={ICON_STROKE}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {spec.fill ? <Path d={spec.fill} fill={color} /> : null}
      </Svg>
    );
  };
}

/* ── navigation ──────────────────────────────────────────────────────────── */

export const InboxIcon = glyph(icons.inbox);
export const ContactsIcon = glyph(icons.contacts);
/** Clipboard of ticked lines — Business Ops. */
export const OpsIcon = glyph(icons.ops);
export const InsightsIcon = glyph(icons.insights);
export const SettingsIcon = glyph(icons.settings);
/** Half-filled circle — the light/dark control in Settings. */
export const ContrastIcon = glyph(icons.contrast);
export const SearchIcon = glyph(icons.search);
/** A phone number on file — not a channel, so drawn in the text colour. */
export const PhoneIcon = glyph(icons.phone);
export const MoreIcon = glyph(icons.more);

/* ── arrows and chevrons ─────────────────────────────────────────────────── */

export const PlusIcon = glyph(icons.plus);
export const XIcon = glyph(icons.x);
export const CheckIcon = glyph(icons.check);
export const BackIcon = glyph(icons.back);
export const ChevronDown = glyph(icons.chevronDown);
export const ChevronRight = glyph(icons.chevronRight);
export const SendIcon = glyph(icons.send);
export const ReplyIcon = glyph(icons.reply);
export const ReplyAllIcon = glyph(icons.replyAll);
export const ForwardIcon = glyph(icons.forward);
export const DownloadIcon = glyph(icons.download);
export const ReopenIcon = glyph(icons.reopen);
/** Door with an arrow leaving it — sign out. */
export const LogoutIcon = glyph(icons.logout);

/* ── conversation state ──────────────────────────────────────────────────── */

export const ClockIcon = glyph(icons.clock);
export const SnoozeIcon = glyph(icons.snooze);
export const CheckCircleIcon = glyph(icons.checkCircle);
/** Exclamation-in-a-circle — a failed/undelivered message tick. */
export const AlertIcon = glyph(icons.alert);
export const EyeIcon = glyph(icons.eye);
export const ProfileIcon = glyph(icons.profile);
export const LockIcon = glyph(icons.lock);
export const TagIcon = glyph(icons.tag);
export const BellIcon = glyph(icons.bell);
/** A mention. The geometry is the web's, so the two bells draw the same glyph. */
export const AtIcon = glyph(icons.at);
export const DetailsIcon = glyph(icons.details);

/* ── the composer and the thread ─────────────────────────────────────────── */

export const AttachIcon = glyph(icons.attach);
export const EmojiIcon = glyph(icons.emoji);
export const NoteIcon = glyph(icons.note);
export const TeamChatIcon = glyph(icons.teamChat);
export const PinIcon = glyph(icons.pin);
export const CopyIcon = glyph(icons.copy);
export const SoundOffIcon = glyph(icons.soundOff);
export const ComposeIcon = glyph(icons.compose);
export const StarIcon = glyph(icons.star);
export const MicIcon = glyph(icons.mic);
export const CameraIcon = glyph(icons.camera);
export const ImageIcon = glyph(icons.image);
/** Four-point sparkle — AI assist (the composer's Polish action). */
export const SparkleIcon = glyph(icons.sparkle);
export const BoltIcon = glyph(icons.bolt);
export const MacroIcon = glyph(icons.macro);
export const EditIcon = glyph(icons.edit);
export const TrashIcon = glyph(icons.trash);
export const DocIcon = glyph(icons.doc);
export const LinkIcon = glyph(icons.link);
export const HistoryIcon = glyph(icons.history);
export const PlayIcon = glyph(icons.play);
export const PauseIcon = glyph(icons.pause);

/* ── read receipts ───────────────────────────────────────────────────────── */

export const CheckSingle = glyph(tickIcons.checkSingle, 16);
export const CheckDouble = glyph(tickIcons.checkDouble, 16);

/* ── channel badges ──────────────────────────────────────────────────────── */

const WaGlyph = glyph(channelIcons.whatsapp);
const GroupGlyph = glyph(channelIcons.group);
const EmailGlyph = glyph(channelIcons.email);
const NestChatGlyph = glyph(channelIcons.nestchat);
const SmsGlyph = glyph(channelIcons.sms);

export interface ChannelMeta {
  /** Key into the theme palette — resolved per scheme by the caller. */
  colorKey: "wa" | "group" | "email" | "nestchat" | "sms";
  label: string;
  Glyph: (p: P) => JSX.Element;
}

/** Mirrors the web's channelMeta. Colour comes back as a token key rather than a
 *  CSS var, because a native component reads the palette for the active scheme. */
export function channelMeta(type: ChannelType): ChannelMeta {
  switch (type) {
    case "whatsapp":
      return { colorKey: "wa", label: "WhatsApp", Glyph: WaGlyph };
    case "whatsapp_group":
      return { colorKey: "group", label: "WhatsApp group", Glyph: GroupGlyph };
    case "nestchat":
      return { colorKey: "nestchat", label: "NestChat", Glyph: NestChatGlyph };
    case "sms":
      return { colorKey: "sms", label: "SMS", Glyph: SmsGlyph };
    default:
      return { colorKey: "email", label: "Email", Glyph: EmailGlyph };
  }
}

/** The channel's colour for the current scheme, in one call. */
export function channelColor(type: ChannelType, c: ThemeColors): string {
  return c[channelMeta(type).colorKey];
}

/* ── the team icon library ───────────────────────────────────────────────── */

/** The same keys Settings › Teams offers on the web, so a team picked there
 *  shows the icon it was given here. */
const TEAM_GLYPHS: Record<string, (p: P) => JSX.Element> = Object.fromEntries(
  Object.entries(teamIcons).map(([name, spec]) => [name, glyph(spec, 20)]),
);

/** A team's chosen icon, falling back to the generic group-of-people glyph. */
export function TeamGlyph({ icon, ...rest }: IconProps & { icon?: string | null }): JSX.Element {
  const Ic = (icon && TEAM_GLYPHS[icon]) || TEAM_GLYPHS.users;
  return <Ic size={20} {...rest} />;
}
