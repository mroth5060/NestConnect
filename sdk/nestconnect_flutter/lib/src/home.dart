import 'package:flutter/material.dart';
import 'package:nestconnect_client/nestconnect_client.dart';

import 'header.dart';
import 'icons.dart';
import 'skeleton.dart';
import 'theme.dart';

/// The screen a customer lands on, when the business has turned one on.
///
/// The web widget's home screen, rebuilt card for card: the header dissolving
/// into the panel, the first card riding up into the colour, every card white
/// on the panel with the same lift. Then the part the web does not have yet and
/// a messenger needs: every conversation this customer has had, open or closed,
/// marked as which.
class NestHomeScreen extends StatelessWidget {
  const NestHomeScreen({
    super.key,
    required this.home,
    required this.theme,
    required this.header,
    required this.team,
    required this.conversations,
    required this.loadingConversations,
    required this.onStartChat,
    required this.onOpenConversation,
    required this.onOpenLink,
    this.onContinueConversation,
    this.footer,
    this.bottomInset = 0,
  });

  final NestHome home;
  final NestTheme theme;

  /// The fading header, built by the messenger so it is the same one the
  /// conversation uses.
  final Widget header;

  /// Who answers, so a conversation row can show the face of whoever replied.
  final List<NestTeamMate> team;

  /// This customer's conversations, newest first, open and closed.
  final List<NestPastConversation> conversations;
  final bool loadingConversations;

  final VoidCallback onStartChat;

  /// A closed conversation, tapped: read it.
  final ValueChanged<NestPastConversation> onOpenConversation;

  /// An open one, tapped: carry on in it. Without this, [onStartChat] — which
  /// is the session's own conversation, whichever row was tapped.
  final ValueChanged<NestPastConversation>? onContinueConversation;
  final ValueChanged<NestHomeCard> onOpenLink;

  /// "Powered by", under the last card.
  final Widget? footer;

  /// The home indicator, which the scroll runs under rather than stopping at —
  /// a white strip below the panel reads as the screen ending early.
  final double bottomInset;

  @override
  Widget build(BuildContext context) {
    final live = conversations.where((c) => !c.closed).firstOrNull;
    var i = 0;

    final cards = <Widget>[
      // The conversation already going, first — the thing somebody coming back
      // is most likely here for. The way Intercom leads with "Recent message".
      if (live != null)
        _Rise(
          index: i++,
          child: _Card(
            theme: theme,
            onTap: onStartChat,
            padding: EdgeInsets.zero,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _CardTitle(theme: theme, text: 'Recent message'),
                _ConversationRow(
                  conversation: live,
                  theme: theme,
                  team: team,
                  showStatus: false,
                  onTap: onStartChat,
                ),
              ],
            ),
          ),
        ),

      // The chat's own door. A white card like the rest, with the send glyph in
      // the brand colour — the only coloured thing on it, which is what makes it
      // read as something to press.
      _Rise(
        index: i++,
        child: _Card(
          theme: theme,
          onTap: onStartChat,
          child: Row(
            children: [
              Expanded(
                child: _CardText(
                  theme: theme,
                  label: home.chatLabel,
                  sublabel: home.chatSublabel,
                ),
              ),
              const SizedBox(width: 10),
              Icon(Icons.send_rounded, color: theme.accent, size: 20),
            ],
          ),
        ),
      ),

      // Every conversation, open or closed. A finished one used to vanish from
      // this side the moment an agent closed it.
      if (loadingConversations && conversations.isEmpty)
        _Rise(
          index: i++,
          child: _Card(
            theme: theme,
            padding: EdgeInsets.zero,
            child: NestShimmer(
              theme: theme,
              child: const Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: EdgeInsets.fromLTRB(16, 16, 16, 4),
                    child: NestBone(width: 120, height: 11),
                  ),
                  NestConversationBone(),
                  NestConversationBone(wide: false),
                  NestConversationBone(),
                ],
              ),
            ),
          ),
        )
      else if (conversations.isNotEmpty)
        _Rise(
          index: i++,
          child: _Card(
            theme: theme,
            padding: EdgeInsets.zero,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _CardTitle(theme: theme, text: 'Your conversations'),
                for (var r = 0; r < conversations.length; r++) ...[
                  if (r > 0) Divider(height: 1, thickness: 1, indent: 66, color: theme.line),
                  _ConversationRow(
                    conversation: conversations[r],
                    theme: theme,
                    team: team,
                    showStatus: true,
                    onTap: () => conversations[r].closed
                        ? onOpenConversation(conversations[r])
                        : onContinueConversation != null
                            ? onContinueConversation!(conversations[r])
                            : onStartChat(),
                  ),
                ],
                const SizedBox(height: 4),
              ],
            ),
          ),
        ),

      for (final card in home.cards)
        _Rise(
          index: i++,
          child: _Card(
            theme: theme,
            onTap: () => onOpenLink(card),
            child: Row(
              children: [
                if (card.icon != null) ...[
                  NestCardIcon(name: card.icon!, color: theme.accent),
                  const SizedBox(width: 12),
                ],
                Expanded(
                  child: _CardText(theme: theme, label: card.label, sublabel: card.sublabel),
                ),
                const SizedBox(width: 10),
                Icon(Icons.chevron_right_rounded, color: theme.accent, size: 22),
              ],
            ),
          ),
        ),
    ];

    return ColoredBox(
      color: theme.panel,
      child: SingleChildScrollView(
        padding: EdgeInsets.only(bottom: bottomInset),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            header,
            // Pulled up into the header's fade, so the colour is still live
            // behind the first card's top and dies out under it — the card is
            // what the last of the gradient goes behind, which is why the eye
            // never finds the place it stops. In the same column as the header,
            // so it paints after it: in separate slivers the header painted
            // over the first card and hid its top.
            Transform.translate(
              offset: const Offset(0, -NestHeader.overlap),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final c in cards)
                      Padding(padding: const EdgeInsets.only(bottom: 10), child: c),
                    if (footer != null)
                      Padding(padding: const EdgeInsets.only(top: 6), child: footer),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A card: white on the panel, a hairline, and the web's two-layer lift. Gives
/// a little under the finger, the way a thing that is pressed does.
class _Card extends StatefulWidget {
  const _Card({
    required this.theme,
    required this.child,
    this.onTap,
    this.padding = const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
  });

  final NestTheme theme;
  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsets padding;

  @override
  State<_Card> createState() => _CardState();
}

class _CardState extends State<_Card> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final t = widget.theme;
    return AnimatedScale(
      scale: _down ? 0.978 : 1,
      duration: Duration(milliseconds: _down ? 90 : 280),
      curve: _down ? Curves.easeOut : const Cubic(0.34, 1.3, 0.64, 1),
      child: Container(
        decoration: BoxDecoration(
          color: t.raised,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: t.line),
          boxShadow: t.cardLift,
        ),
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: widget.onTap,
            onHighlightChanged: widget.onTap == null ? null : (v) => setState(() => _down = v),
            borderRadius: BorderRadius.circular(14),
            child: Padding(padding: widget.padding, child: widget.child),
          ),
        ),
      ),
    );
  }
}

class _CardText extends StatelessWidget {
  const _CardText({required this.theme, required this.label, required this.sublabel});
  final NestTheme theme;
  final String label;
  final String sublabel;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.15,
              color: theme.text,
            ),
          ),
          if (sublabel.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                sublabel,
                style: TextStyle(fontSize: 13, height: 1.35, color: theme.muted),
              ),
            ),
        ],
      );
}

class _CardTitle extends StatelessWidget {
  const _CardTitle({required this.theme, required this.text});
  final NestTheme theme;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 2),
        child: Text(
          text,
          style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: theme.text),
        ),
      );
}

/// One conversation: whose face, what was last said, when — and whether it is
/// still open.
class _ConversationRow extends StatelessWidget {
  const _ConversationRow({
    required this.conversation,
    required this.theme,
    required this.team,
    required this.showStatus,
    required this.onTap,
  });

  final NestPastConversation conversation;
  final NestTheme theme;
  final List<NestTeamMate> team;
  final bool showStatus;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = conversation;
    final who = c.fromMe ? 'You' : (c.authorName ?? 'Support');
    final preview = c.preview.isEmpty ? 'Conversation' : c.preview;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 14, 12),
        child: Row(
          children: [
            _RowFace(name: c.authorName, team: team, theme: theme),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    preview,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: c.closed ? FontWeight.w400 : FontWeight.w600,
                      color: theme.text,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    '$who · ${nestAgo(c.at)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12.5, color: theme.muted),
                  ),
                ],
              ),
            ),
            if (showStatus) ...[
              const SizedBox(width: 10),
              _StatusTag(closed: c.closed, theme: theme),
            ],
            const SizedBox(width: 4),
            Icon(Icons.chevron_right_rounded, color: theme.muted, size: 20),
          ],
        ),
      ),
    );
  }
}

/// "Open" or "Closed", as a small pill.
class _StatusTag extends StatelessWidget {
  const _StatusTag({required this.closed, required this.theme});
  final bool closed;
  final NestTheme theme;

  @override
  Widget build(BuildContext context) {
    // Open is green rather than the brand colour: a pink "Open" on a pink brand
    // reads as decoration, and this is the one word on the row that is status.
    final fg = closed ? theme.muted : const Color(0xFF15803D);
    final bg = closed
        ? theme.line.withValues(alpha: theme.isDark ? 1 : 0.7)
        : const Color(0xFF22C55E).withValues(alpha: 0.14);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(
        closed ? 'Closed' : 'Open',
        style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: fg),
      ),
    );
  }
}

/// The face beside a conversation: whoever last answered, if they are one of
/// the team the header shows, and their initials otherwise.
class _RowFace extends StatelessWidget {
  const _RowFace({required this.name, required this.team, required this.theme});
  final String? name;
  final List<NestTeamMate> team;
  final NestTheme theme;

  @override
  Widget build(BuildContext context) {
    const size = 38.0;
    final mate = name == null ? null : team.where((m) => m.name == name).firstOrNull;
    final own = NestTheme.parseColor(mate?.color ?? '');
    final initials = name == null || name!.trim().isEmpty
        ? null
        : (mate?.initials ??
            name!
                .trim()
                .split(RegExp(r'\s+'))
                .take(2)
                .map((p) => p.characters.first.toUpperCase())
                .join());
    final fallback = Center(
      child: initials == null
          ? NestCardIcon(name: 'chat', color: theme.onAccent, size: 18)
          : Text(
              initials,
              style: TextStyle(
                color: own != null ? Colors.white : theme.onAccent,
                fontSize: 13,
                fontWeight: FontWeight.w700,
              ),
            ),
    );
    final url = mate?.avatarUrl;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(shape: BoxShape.circle, color: own ?? theme.accent),
      clipBehavior: Clip.antiAlias,
      child: url == null || url.isEmpty
          ? fallback
          : Image.network(
              url,
              fit: BoxFit.cover,
              frameBuilder: (_, child, frame, __) => frame == null ? fallback : child,
              errorBuilder: (_, __, ___) => fallback,
            ),
    );
  }
}

/// When, the way somebody would say it.
String nestAgo(DateTime at) {
  final ago = DateTime.now().difference(at);
  if (ago.inMinutes < 1) return 'just now';
  if (ago.inMinutes < 60) return '${ago.inMinutes}m ago';
  if (ago.inHours < 24) return '${ago.inHours}h ago';
  if (ago.inDays < 7) return '${ago.inDays}d ago';
  return '${at.day}/${at.month}/${at.year}';
}

/// A card arriving: up and in, a beat after the one above it.
///
/// One controller per card with the delay folded into an interval, rather than
/// a timer that starts the animation later — a timer is a second clock, and a
/// card scrolled into view mid-sequence should still arrive on the same beat.
class _Rise extends StatefulWidget {
  const _Rise({required this.index, required this.child});
  final int index;
  final Widget child;

  @override
  State<_Rise> createState() => _RiseState();
}

class _RiseState extends State<_Rise> with SingleTickerProviderStateMixin {
  static const _each = 80;
  static const _maxDelay = 320;
  static const _length = 520;

  late final int _delay = (widget.index * _each).clamp(0, _maxDelay);
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: Duration(milliseconds: _delay + _length),
  )..forward();

  late final Animation<double> _t = CurvedAnimation(
    parent: _c,
    // The web's `--nc-enter`: most of the distance early, then a long settle.
    curve: Interval(_delay / (_delay + _length), 1, curve: const Cubic(0.16, 1, 0.3, 1)),
  );

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _t,
        builder: (context, child) => Opacity(
          opacity: _t.value,
          child: Transform.translate(offset: Offset(0, 13 * (1 - _t.value)), child: child),
        ),
        child: widget.child,
      );
}
