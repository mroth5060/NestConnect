import type { NestChatField, NestChatPreChat, NestChatPublicRouting } from "@ding/schemas";

/**
 * What the visitor still has to answer before they can write.
 *
 * Its own module because it is the one piece of the widget that is pure
 * decision and no drawing — six interacting booleans over two independently
 * configurable halves, where getting one wrong means either a form nobody can
 * get past or a form that lets them past without answering it. That is worth
 * being able to assert on directly, rather than only through a rendered widget.
 */

/**
 * Enough of an email check to catch a typo, and no more.
 *
 * The server validates properly; this exists so a visitor who wrote
 * "nathan@hermolis" is told before they press the button rather than after a
 * round trip that comes back as a generic failure.
 */
export const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Is this field one the visitor must fill in before they can start? */
function unmet(field: NestChatField | undefined, value: string): boolean {
  return Boolean(field?.enabled && field.required && !value.trim());
}

export interface PreChatInput {
  /** The form this channel asks, or undefined when it doesn't ask one. */
  preChat?: NestChatPreChat;
  /** The routing menu this channel offers, or undefined when it has none. */
  routing?: NestChatPublicRouting;
  /** This browser has already answered the identity half, on some earlier visit. */
  identified: boolean;
  /** A routing option has been chosen and accepted for this conversation. */
  chosen: boolean;
  /** There is already a conversation — so there is nothing left to gate. */
  hasThread: boolean;
  /** They have been through the form this session, by answering or skipping. */
  startDone: boolean;
  form: { name: string; email: string; phone: string };
  optionId?: string;
  starting: boolean;
}

export interface PreChatGate {
  /** The identity half still has a question in it. */
  wantsIdentity: boolean;
  /** The routing half still has a question in it. */
  wantsOption: boolean;
  /** Show the form instead of the message box. */
  gated: boolean;
  /** They have typed something in the email field that isn't an email. */
  emailTypo: boolean;
  /** The submit button can't be pressed yet. */
  blocked: boolean;
  /** Offer a way past — true exactly when nothing on the form is required. */
  canSkip: boolean;
}

export function gateFor(input: PreChatInput): PreChatGate {
  const { preChat, routing, form } = input;

  /** Asked once per browser, and not again. */
  const wantsIdentity = Boolean(preChat) && !input.identified;
  /**
   * Asked once per conversation.
   *
   * Not remembered across visits, unlike the identity half: who you are doesn't
   * change between conversations, and what you need does. Somebody coming back
   * next week should be asked what it's about, not asked their name again.
   */
  const wantsOption = Boolean(routing) && !input.chosen;

  const gated = !input.hasThread && !input.startDone && (wantsIdentity || wantsOption);

  const email = form.email.trim();
  const emailTypo = Boolean(
    wantsIdentity && preChat?.email.enabled && email && !LOOKS_LIKE_EMAIL.test(email),
  );

  const blocked =
    input.starting ||
    emailTypo ||
    (wantsIdentity &&
      (unmet(preChat?.name, form.name) ||
        unmet(preChat?.email, form.email) ||
        unmet(preChat?.phone, form.phone))) ||
    (wantsOption && Boolean(routing?.required) && !input.optionId);

  // Offered exactly when nothing on the form is required — otherwise "Skip" is
  // a lie, and a visitor who takes it gets an error instead of a chat.
  const canSkip =
    !(
      wantsIdentity &&
      [preChat?.name, preChat?.email, preChat?.phone].some((f) => f?.enabled && f.required)
    ) && !(wantsOption && Boolean(routing?.required));

  return { wantsIdentity, wantsOption, gated, emailTypo, blocked, canSkip };
}
