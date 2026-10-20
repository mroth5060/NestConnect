import 'dart:async';

import 'package:flutter/material.dart';
import 'package:nestconnect_client/nestconnect_client.dart';
import 'package:url_launcher/url_launcher.dart';

import 'bubble.dart';
import 'header.dart';
import 'home.dart';
import 'message_row.dart';
import 'recorder.dart';
import 'skeleton.dart';
import 'minimised.dart';
import 'theme.dart';
import 'typing.dart';
import 'voice.dart';

/// What a host app hands back when the customer wants to attach something.
///
/// The app owns the picker, because it already has one and already has the
/// permission. A plugin here would mean native build config and a permissions
/// prompt for every app that takes this package, used or not.
typedef NestFilePicker = Future<NestPickedFile?> Function();

/// A file the host app picked.
class NestPickedFile {
  const NestPickedFile({required this.bytes, required this.filename, required this.mime});
  final List<int> bytes;
  final String filename;
  final String mime;
}

/// Where the messenger is: the front door, the conversation, or an old one.
enum NestView {
  /// The cards. Only ever reached when the channel has a home screen turned on.
  home,

  /// The live conversation, with a composer.
  thread,

  /// One of the customer's earlier conversations, read and not written to.
  past,
}

/// The chat itself: header, thread, composer — and the home screen in front of
/// them, where the business has turned one on.
///
/// Usually shown by [showNestMessenger] rather than built directly, but it is a
/// plain widget — an app that wants chat on a page of its own can put it there.
class NestMessenger extends StatefulWidget {
  const NestMessenger({
    super.key,
    required this.chat,
    this.onPickFile,
    this.onClose,
    this.onOpenLink,
    this.startOnConversation = false,
  });

  final NestConnect chat;

  /// Open on the conversation even where the channel has a home screen — what
  /// tapping a notification about a reply should do. The cards are one tap
  /// back.
  final bool startOnConversation;

  /// Omit it and there is no attach button. Better than a button that opens
  /// nothing.
  final NestFilePicker? onPickFile;
  final VoidCallback? onClose;

  /// What to do when a home card is tapped. Defaults to handing the link to the
  /// phone, which is what every one of them wants: a help centre opens in a
  /// browser, a `tel:` opens the dialler, a `mailto:` opens Mail. An app that
  /// would rather keep people inside — its own in-app browser, say — passes its
  /// own.
  final ValueChanged<NestHomeCard>? onOpenLink;

  @override
  State<NestMessenger> createState() => _NestMessengerState();
}

/// How many messengers are mounted — so a notification tapped while the chat
/// is already up does not stack a second one on top of it.
///
/// Counted by the screens themselves rather than by the sheets opened: a sheet
/// whose navigator is torn down never reports closing, and a count of sheets
/// would then say "open" for the rest of the app's life, and no notification
/// would open the chat again.
int nestMessengersShowing = 0;

class _NestMessengerState extends State<NestMessenger> with WidgetsBindingObserver {
  final _composer = TextEditingController();
  final _scroll = ScrollController();
  final _staged = <NestUpload>[];
  StreamSubscription<List<NestMessage>>? _sub;
  StreamSubscription<bool>? _closedSub;
  StreamSubscription<bool>? _typingSub;
  bool _restarting = false;
  Timer? _typing;
  bool _sending = false;
  bool _attaching = false;
  String? _error;
  /// The message the composer is answering, set by a swipe.
  NestMessage? _replyTo;
  /// Flashing, because a quote above was tapped and this is what it pointed at.
  String? _flash;
  /// One key per message, so tapping a quote can scroll to the real widget
  /// rather than to a guess at where it is.
  final _keys = <String, GlobalKey>{};

  /// Which of the three screens is up. Starts on the conversation and is moved
  /// to the front door once the config says there is one — the config arrives
  /// over the network a moment after the sheet opens, and opening onto a blank
  /// screen that then becomes a home screen is worse than opening onto the chat.
  NestView _view = NestView.thread;

  /// Whether the customer has been shown the front door yet. Without this, going
  /// Home → chat would be undone by the next config rebuild.
  bool _landed = false;

  /// A reply was waiting when the chat opened — so it opens on the reply.
  ///
  /// Taken before the chat is marked read, which zeroes the count. An app that
  /// opens the messenger from a notification tap with plain [showNestMessenger]
  /// lands here too: the badge says why the customer came, so the home screen
  /// would be one tap in the way.
  bool _replyWaiting = false;

  /// The customer's own earlier conversations, for the home screen.
  List<NestPastConversation> _history = const [];
  bool _loadingHistory = false;

  /// The old conversation being read, and what was said in it.
  NestPastConversation? _reading;
  List<NestMessage> _readingMessages = const [];

  @override
  void initState() {
    super.initState();
    _sub = widget.chat.onMessages.listen((_) {
      if (mounted) setState(_scrollToEnd);
    });
    // Its own subscription because nothing else moves when a chat closes: no
    // message arrives, so watching the thread would never rebuild and the
    // composer would sit there looking live.
    _closedSub = widget.chat.onClosed.listen((_) {
      if (mounted) setState(() {});
    });
    // And its own again for the dots, for the same reason: an agent starting to
    // type is a change with no message attached to it.
    _typingSub = widget.chat.onAgentTyping.listen((_) {
      if (mounted) setState(_scrollToEnd);
    });
    // On screen: zeroes the badge, and turns the agent's ticks from delivered
    // to read — a different claim, and the only one worth showing them as read.
    _replyWaiting = widget.chat.unread > 0;
    unawaited(widget.chat.setViewing(true));
    // And brought up to date: the live stream does not carry what arrived while
    // it was down, and a phone drops it whenever the app sleeps — so a chat
    // opened from a notification would otherwise be missing the very reply the
    // notification was about.
    unawaited(widget.chat.refresh());
    // Open is not the same as on screen. A chat left open when the phone is
    // put down is still mounted, and if it went on telling the server it was
    // being read, no reply would ring the phone until the app was killed.
    WidgetsBinding.instance.addObserver(this);
    nestMessengersShowing++;
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToEnd());
    unawaited(_settleView());
  }

  /// The app going to the background, or coming back.
  ///
  /// In the background the chat is not on screen, whatever is mounted, and the
  /// server has to hear it or it will not push the reply that arrives meanwhile.
  /// Coming back, the stream the phone quietly killed is reopened and the
  /// thread fetched again, so the reply the notification was about is there.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final onScreen = state == AppLifecycleState.resumed;
    unawaited(widget.chat.setViewing(onScreen));
    if (onScreen) unawaited(widget.chat.resume());
  }

  /// Decide which screen this opens on, once the channel's config has landed.
  ///
  /// The config is fetched when the session opens, which may be before this
  /// widget exists or a moment after — so this waits for it rather than reading
  /// whatever happens to be there on the first frame. A chat that opens on the
  /// conversation and jumps to a home screen half a second later is worse than
  /// either one on its own.
  Future<void> _settleView() async {
    for (var waited = 0; waited < 24 && mounted; waited++) {
      if (widget.chat.config != null) break;
      await Future<void>.delayed(const Duration(milliseconds: 120));
    }
    if (!mounted || _landed) return;
    _landed = true;
    if (widget.chat.config?.home == null || widget.startOnConversation || _replyWaiting) return;
    setState(() => _view = NestView.home);
    await _loadHistory();
  }

  /// This customer's earlier conversations, for the cards on the home screen.
  Future<void> _loadHistory() async {
    if (_loadingHistory) return;
    setState(() => _loadingHistory = true);
    final found = await widget.chat.conversations();
    if (!mounted) return;
    setState(() {
      _history = found;
      _loadingHistory = false;
    });
  }

  /// Open one of them, read-only.
  Future<void> _read(NestPastConversation conversation) async {
    setState(() {
      _reading = conversation;
      _readingMessages = const [];
      _view = NestView.past;
      _error = null;
    });
    try {
      final messages = await widget.chat.conversation(conversation.id);
      if (mounted) setState(() => _readingMessages = messages);
    } on NestException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Carry on in an open conversation — the one tapped, not just whichever the
  /// session was on. With a conversation per order, each open order is its own
  /// thread; this moves the session to the one chosen before showing it.
  Future<void> _continue(NestPastConversation conversation) async {
    if (!conversation.current) {
      try {
        await widget.chat.switchTo(conversation.id);
      } on NestException {
        // Closed or gone since the list was drawn. The list, fetched again,
        // shows it as it is now — resolved, or not there — rather than opening
        // a thread it can't be.
        if (mounted) unawaited(_loadHistory());
        return;
      }
    }
    if (mounted) setState(() => _view = NestView.thread);
  }

  /// Back to the cards — or out, where there is no home screen to go back to.
  void _backHome() {
    setState(() {
      _reading = null;
      _readingMessages = const [];
      _view = widget.chat.config?.home == null ? NestView.thread : NestView.home;
    });
    // Refreshed rather than remembered: a conversation read and left may have
    // been reopened by an agent while it was on screen, and the row describing
    // it would still say "Resolved".
    if (_view == NestView.home) unawaited(_loadHistory());
  }

  /// Hand a card's link to the phone.
  Future<void> _openLink(NestHomeCard card) async {
    final custom = widget.onOpenLink;
    if (custom != null) {
      custom(card);
      return;
    }
    final uri = Uri.tryParse(card.href);
    // Nothing is said when it fails. The business configured this link; a
    // customer who taps "Call us" on a tablet with no dialler does not need an
    // error about it, and there is nothing they could do with one.
    if (uri != null) await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    nestMessengersShowing--;
    _typing?.cancel();
    unawaited(_sub?.cancel());
    unawaited(_closedSub?.cancel());
    unawaited(_typingSub?.cancel());
    unawaited(widget.chat.setViewing(false));
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// Put the newest message back under the composer.
  ///
  /// Zero, because the thread is built upwards — see `reverse` on the list. That
  /// is the whole reason this is reliable now. It used to jump to
  /// `maxScrollExtent`, which for a lazily built list is an *estimate* made from
  /// the rows that happen to have been laid out: with a real conversation above
  /// it, the jump landed a couple of hundred pixels short of the bottom and the
  /// message somebody had just sent was built below the fold — present, stored,
  /// delivered, and not on screen. Zero is not an estimate.
  void _scrollToEnd() {
    if (!_scroll.hasClients) return;
    // Jumped to rather than animated on a rebuild: a new message arriving while
    // somebody is reading should land, not glide, and an animation that
    // restarts on every keystroke is a thread that will not sit still.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(0);
    });
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if ((text.isEmpty && _staged.isEmpty) || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    final attachments = List<NestUpload>.from(_staged);
    final answering = _replyTo;
    _composer.clear();
    _staged.clear();
    // The quote chip goes the moment they send, not when the reply lands: it
    // describes an intention, and the intention has been carried out.
    _replyTo = null;
    try {
      await widget.chat.send(text, attachments: attachments, replyTo: answering);
    } on NestException catch (e) {
      // The server's own words. "That kind of file can't be attached here" is
      // an answer; "something went wrong" is a shrug.
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// A finished recording, uploaded and sent as its own message.
  Future<void> _sendVoice(RecordedNote note) async {
    final answering = _replyTo;
    setState(() {
      _replyTo = null;
      _error = null;
    });
    try {
      final staged = await widget.chat.attachVoice(
        bytes: note.bytes,
        mime: note.mime,
        durationMs: note.duration.inMilliseconds,
        waveform: note.waveform,
      );
      await widget.chat.send('', attachments: [staged], replyTo: answering);
    } on NestException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Tapping a quote goes to what it answers, and flashes it.
  void _jumpToQuote(NestQuote quote) {
    final key = _keys[quote.id];
    final target = key?.currentContext;
    if (target == null) return;
    unawaited(
      Scrollable.ensureVisible(
        target,
        duration: const Duration(milliseconds: 320),
        curve: Curves.easeOutCubic,
        alignment: 0.5,
      ),
    );
    setState(() => _flash = quote.id);
    // Clears itself. The ring marks a moment, not a state.
    Timer(const Duration(milliseconds: 1400), () {
      if (mounted && _flash == quote.id) setState(() => _flash = null);
    });
  }

  Future<void> _attach() async {
    final pick = widget.onPickFile;
    if (pick == null || _attaching) return;
    setState(() => _attaching = true);
    try {
      final file = await pick();
      if (file == null) return;
      final upload = await widget.chat.attach(
        bytes: file.bytes,
        filename: file.filename,
        mime: file.mime,
      );
      if (mounted) setState(() => _staged.add(upload));
    } on NestException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _attaching = false);
    }
  }

  void _onTyped(String value) {
    _typing?.cancel();
    // Debounced: the agent wants to see the question forming, not one request
    // per keystroke from every customer at once.
    _typing = Timer(const Duration(milliseconds: 400), () {
      unawaited(widget.chat.typing(value));
    });
  }

  Future<void> _startNewChat() async {
    setState(() {
      _restarting = true;
      _error = null;
    });
    try {
      await widget.chat.startNewChat();
      // Anything staged belonged to the conversation that just ended; carrying
      // it into a new one would attach it to a thread nobody chose it for.
      if (mounted) setState(_staged.clear);
    } on NestException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _restarting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = widget.chat.config;
    final appearance = config?.appearance ?? NestAppearance.fallback;
    final theme = NestTheme.from(appearance, Theme.of(context).brightness);

    /// Whether the keyboard is up, and so whether the header is worth its
    /// height. The greeting, the away line and the faces are an introduction,
    /// and somebody mid-sentence has been introduced.
    final compact = MediaQuery.viewInsetsOf(context).bottom > 0;

    NestHeader header({bool fade = false, bool compact = false, String? title, VoidCallback? onBack}) =>
        NestHeader(
          appearance: appearance,
          theme: theme,
          online: config?.online ?? false,
          team: config?.team ?? const [],
          teamTotal: config?.teamTotal ?? 0,
          visitorName: widget.chat.visitorName,
          fade: fade,
          compact: compact,
          title: title,
          onBack: onBack,
          onClose: widget.onClose,
          // Mid-conversation, closing is putting it down rather than away: it
          // shrinks to a bar over the app, and the arrow says so.
          minimise: _view == NestView.thread && nestChatActive(widget.chat),
        );

    /// What is under the last control: the home indicator, while the keyboard
    /// is down. Zero with it up — the keyboard covers that strip.
    final bottomInset = compact ? 0.0 : MediaQuery.paddingOf(context).bottom;

    /// The sheet, whichever screen is inside it — one shape, one clip, one
    /// decision about the keyboard, rather than three that drift.
    Widget shell(List<Widget> children) => NestKeyboardClearance(
          child: Container(
            decoration: BoxDecoration(
              color: theme.surface,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(children: children),
          ),
        );

    // The channel's look has not arrived yet — or it has, and says this opens
    // on the home screen, which the next tick will switch to. The shape of the
    // screen rather than a spinner, and rather than a glimpse of the thread
    // that is then taken away: nothing jumps when the real screen arrives.
    final goingHome = !_landed &&
        config?.home != null &&
        !widget.startOnConversation &&
        !_replyWaiting;
    if (config == null || goingHome) {
      return shell([
        Expanded(
          child: ColoredBox(
            color: theme.panel,
            child: NestShimmer(theme: theme, child: const _OpeningBones()),
          ),
        ),
      ]);
    }

    final home = config.home;
    if (_view == NestView.home && home != null) {
      return shell([
        Expanded(
          child: NestHomeScreen(
            home: home,
            theme: theme,
            header: header(fade: true),
            team: config.team,
            conversations: _history,
            loadingConversations: _loadingHistory,
            onStartChat: () => setState(() => _view = NestView.thread),
            onOpenConversation: (c) => unawaited(_read(c)),
            onContinueConversation: (c) => unawaited(_continue(c)),
            onOpenLink: (card) => unawaited(_openLink(card)),
            footer: appearance.showBranding ? _Branding(theme: theme) : null,
            bottomInset: bottomInset,
          ),
        ),
      ]);
    }

    if (_view == NestView.past) {
      final reading = _reading;
      final list = _readingMessages;
      return shell([
        header(
          compact: true,
          title: reading?.authorName == null ? null : 'Conversation with ${reading!.authorName}',
          onBack: _backHome,
        ),
        Expanded(
          child: ColoredBox(
            color: theme.panel,
            child: list.isEmpty
                ? (_error == null
                    ? NestShimmer(theme: theme, child: const NestThreadBone())
                    : Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            _error!,
                            textAlign: TextAlign.center,
                            style: TextStyle(color: theme.muted, fontSize: 14),
                          ),
                        ),
                      ))
                : ListView.builder(
                    padding: const EdgeInsets.fromLTRB(14, 14, 14, 10),
                    reverse: true,
                    itemCount: list.length,
                    // Bubbles and nothing else: no swipe, no long press, no
                    // reactions. There is nothing to reply to in a conversation
                    // that is over, and offering it would be offering something
                    // the server would refuse.
                    itemBuilder: (context, row) =>
                        _message(list, list.length - 1 - row, theme, config.team),
                  ),
          ),
        ),
        _PastFooter(theme: theme, closed: reading?.closed ?? true, onBack: _backHome),
        SizedBox(height: bottomInset),
      ]);
    }

    final messages = widget.chat.messages;
    final typing = widget.chat.agentTyping && !widget.chat.isClosed;

    return shell([
      header(
        compact: compact,
        // Only where there is something behind it. A channel with no home
        // screen has no "back", and an arrow that goes nowhere is worse than no
        // arrow.
        onBack: home == null ? null : _backHome,
      ),
      Expanded(
        child: ColoredBox(
          color: theme.panel,
          child: messages.isEmpty && !typing
              ? _Greeting(theme: theme, appearance: appearance, name: widget.chat.visitorName)
              : ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.fromLTRB(14, 14, 14, 10),
                  // Built from the bottom up, newest first.
                  //
                  // Not a style: it is what makes "the newest message is on
                  // screen" true by construction. Downwards, the bottom of the
                  // thread is `maxScrollExtent` — a guess, for a list that
                  // builds rows as they are needed — so the scroll that followed
                  // a new message landed short of it and the message was built
                  // below the fold. Upwards, the newest message is at offset
                  // zero, which needs no scrolling and cannot be estimated
                  // wrongly. It is also why the conversation hugs the composer
                  // instead of hanging from the header.
                  reverse: true,
                  itemCount: messages.length + (typing ? 1 : 0),
                  itemBuilder: (context, row) {
                    // The dots come first in a reversed list, which puts them
                    // last on screen — where the reply itself is about to
                    // appear, scrolling with the thread rather than hovering
                    // over it.
                    if (typing && row == 0) {
                      return Padding(
                        padding: const EdgeInsets.only(left: NestBubble.faceColumn + 8, top: 6),
                        child: NestTypingDots(theme: theme),
                      );
                    }
                    final i = messages.length - 1 - (typing ? row - 1 : row);
                    final m = messages[i];
                    final key = _keys.putIfAbsent(m.id, GlobalKey.new);
                    return NestMessageRow(
                      key: ValueKey(m.id),
                      message: m,
                      theme: theme,
                      highlighted: _flash == m.id,
                      // A message still on its way has no id the server would
                      // recognise, so there is nothing to react to and nothing
                      // to quote.
                      canAct: !widget.chat.isClosed && !m.id.startsWith('pending-'),
                      onReply: (target) => setState(() => _replyTo = target),
                      onReact: (target, emoji) => unawaited(widget.chat.react(target.id, emoji)),
                      onJumpToQuote: _jumpToQuote,
                      child: KeyedSubtree(key: key, child: _message(messages, i, theme, config.team)),
                    );
                  },
                ),
        ),
      ),
      if (_error != null)
        Container(
          width: double.infinity,
          color: const Color(0x14DC2626),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Text(_error!, style: const TextStyle(color: Color(0xFFDC2626), fontSize: 13)),
        ),
      if (_staged.isNotEmpty)
        NestStagedFiles(
          files: _staged,
          onRemove: (upload) => setState(() => _staged.remove(upload)),
        ),
      if (widget.chat.isClosed)
        _ClosedNotice(
          theme: theme,
          message: appearance.closedMessage,
          newChatLabel: appearance.newChatLabel,
          busy: _restarting,
          onNewChat: _startNewChat,
        )
      else ...[
        // What they are answering, above the box rather than inside it: the
        // quote is context for what they are about to type, and in the field it
        // would have to be deleted to be cleared.
        if (_replyTo != null)
          _ReplyingTo(
            theme: theme,
            message: _replyTo!,
            onCancel: () => setState(() => _replyTo = null),
          ),
        _Composer(
          controller: _composer,
          theme: theme,
          placeholder: appearance.placeholder,
          sending: _sending,
          attaching: _attaching,
          onAttach: widget.onPickFile == null ? null : _attach,
          onSend: _send,
          onChanged: _onTyped,
          onRecorded: (note) => unawaited(_sendVoice(note)),
          onRecordError: (message) => setState(() => _error = message),
        ),
      ],
      // Dropped with the keyboard up for the same reason the greeting is: a line
      // of our own branding is not worth a line of their conversation.
      if (appearance.showBranding && !compact) _Branding(theme: theme),
      SizedBox(height: bottomInset),
    ]);
  }

  /// One message, drawn the same way in the live thread and in an old one: the
  /// author over the first of a run, the face and the time under the last.
  Widget _message(List<NestMessage> list, int i, NestTheme theme, List<NestTeamMate> team) {
    final m = list[i];
    final firstOfRun = i == 0 || list[i - 1].from != m.from;
    final lastOfRun = i == list.length - 1 || list[i + 1].from != m.from;
    final face = m.isMine ? null : NestAgentFace(name: m.authorName, team: team, theme: theme);
    final voice = m.voice;
    if (voice != null) {
      // A recording is the whole bubble rather than a file listed under one:
      // the waveform *is* the message, and wrapping it in an empty text bubble
      // would put a box round it for no reason.
      return Padding(
        padding: EdgeInsets.only(top: firstOfRun ? 10 : 3, bottom: lastOfRun ? 4 : 0),
        child: Row(
          mainAxisAlignment: m.isMine ? MainAxisAlignment.end : MainAxisAlignment.start,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            if (!m.isMine) ...[
              SizedBox(width: NestBubble.faceColumn, child: lastOfRun ? face : null),
              const SizedBox(width: 8),
            ],
            NestVoiceNote(
              attachment: voice,
              source: widget.chat.attachmentUrl(voice),
              mine: m.isMine,
              theme: theme,
            ),
          ],
        ),
      );
    }
    return NestBubble(
      message: m,
      theme: theme,
      attachmentUrl: widget.chat.attachmentUrl,
      showAuthor: firstOfRun,
      lastOfRun: lastOfRun,
      face: face,
    );
  }
}

/// Files chosen but not yet sent.
///
/// Removable, because picking the wrong photo is the most ordinary mistake
/// there is and the alternative is closing the chat to undo it. Its own widget
/// so the staged state can be looked at on its own — the messenger around it
/// needs a network to exist, and this does not.
class NestStagedFiles extends StatelessWidget {
  const NestStagedFiles({super.key, required this.files, required this.onRemove});

  final List<NestUpload> files;
  final ValueChanged<NestUpload> onRemove;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
        child: Wrap(
          spacing: 6,
          children: [
            for (final upload in files)
              Chip(
                label: Text(upload.filename, overflow: TextOverflow.ellipsis),
                onDeleted: () => onRemove(upload),
              ),
          ],
        ),
      );
}

/// Lifts what it holds clear of the keyboard — by exactly as much as the
/// keyboard covers it, and no more.
///
/// It used to lift by the keyboard's full height, read from `MediaQuery`. That
/// is right only when nothing above has already moved out of the way, and the
/// app this was reported from had: its whole navigator was lifted for the
/// keyboard — its own tab bar sat *on top of* the keyboard in the screenshot —
/// without taking the inset out of what it handed down. So the keyboard was
/// paid for twice, and the sheet floated a full keyboard's height above it with
/// the app showing through the gap.
///
/// What a host does about the keyboard is its own business and cannot be known
/// from in here. Where this box actually ends on the screen can. So it measures:
/// its own bottom edge against the top of the keyboard, both read from the
/// window itself rather than from a `MediaQuery` an ancestor may have edited,
/// and pads by the overlap. Lifted by somebody else, the overlap is nothing and
/// so is the padding; lifted by nobody, it is the whole keyboard.
///
/// Measured after each frame and applied on the next, so while the keyboard is
/// animating it follows one frame behind — about sixteen milliseconds, which is
/// not something a thumb can feel.
class NestKeyboardClearance extends StatefulWidget {
  const NestKeyboardClearance({super.key, required this.child});
  final Widget child;

  @override
  State<NestKeyboardClearance> createState() => _NestKeyboardClearanceState();
}

class _NestKeyboardClearanceState extends State<NestKeyboardClearance>
    with WidgetsBindingObserver {
  double _lift = 0;
  bool _queued = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// The keyboard moving is a change in the window's metrics — heard here even
  /// when an ancestor has hidden it from the `MediaQuery` below it.
  @override
  void didChangeMetrics() => _queue();

  void _queue() {
    if (_queued) return;
    _queued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _queued = false;
      _measure();
    });
  }

  void _measure() {
    if (!mounted) return;
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.hasSize || !box.attached) return;
    final view = View.of(context);
    final ratio = view.devicePixelRatio;
    final keyboard = view.viewInsets.bottom / ratio;
    var lift = 0.0;
    if (keyboard > 0) {
      final keyboardTop = view.physicalSize.height / ratio - keyboard;
      // The box's own bottom edge does not move with the lift — the lift is
      // padding inside it — so this converges in one step.
      final bottom = box.localToGlobal(Offset(0, box.size.height)).dy;
      lift = (bottom - keyboardTop).clamp(0.0, keyboard);
    }
    if ((lift - _lift).abs() > 0.5) setState(() => _lift = lift);
  }

  @override
  Widget build(BuildContext context) {
    // A dependency on the keyboard, so the ordinary case rebuilds and measures
    // as it moves without waiting on the metrics callback.
    MediaQuery.viewInsetsOf(context);
    _queue();
    return Padding(padding: EdgeInsets.only(bottom: _lift), child: widget.child);
  }
}

/// The face beside an agent's last bubble, 26 points — whoever said it, if they
/// are one of the team, and their initials on the brand colour otherwise.
class NestAgentFace extends StatelessWidget {
  const NestAgentFace({
    super.key,
    required this.name,
    required this.team,
    required this.theme,
    this.size = 26,
  });
  final String? name;
  final List<NestTeamMate> team;
  final NestTheme theme;
  final double size;

  @override
  Widget build(BuildContext context) {
    final mate = name == null ? null : team.where((m) => m.name == name).firstOrNull;
    final own = NestTheme.parseColor(mate?.color ?? '');
    final initials = mate?.initials ??
        (name ?? '?')
            .trim()
            .split(RegExp(r'\s+'))
            .where((p) => p.isNotEmpty)
            .take(2)
            .map((p) => p.characters.first.toUpperCase())
            .join();
    final fallback = Center(
      child: Text(
        initials,
        style: TextStyle(
          color: own != null ? Colors.white : theme.onAccent,
          fontSize: size * 0.4,
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
              // Initials until the photo has a frame to draw. A loading
              // builder is not enough: before the first byte arrives it is
              // handed no progress at all, which reads as "done", and the
              // circle is drawn empty.
              frameBuilder: (_, child, frame, __) => frame == null ? fallback : child,
              errorBuilder: (_, __, ___) => fallback,
            ),
    );
  }
}

/// The messenger before the channel has said what it looks like: the logo's
/// corner, the faces, the greeting's lines and the cards under them — each where
/// it is about to be, so the screen fills in rather than rearranging.
class _OpeningBones extends StatelessWidget {
  const _OpeningBones();

  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.fromLTRB(20, 16, 14, 0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              height: 38,
              child: Row(
                children: [
                  NestBone(width: 72, height: 24),
                  Spacer(),
                  NestBone(height: 38, circle: true),
                  SizedBox(width: 4),
                  NestBone(height: 38, circle: true),
                  SizedBox(width: 12),
                  NestBone(height: 32, circle: true),
                ],
              ),
            ),
            SizedBox(height: 34),
            NestBone(width: 190, height: 24),
            SizedBox(height: 10),
            NestBone(width: 240, height: 24),
            SizedBox(height: 14),
            NestBone(width: 280, height: 12),
            SizedBox(height: 40),
            Padding(
              padding: EdgeInsets.only(right: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  NestBone(height: 72, radius: 14),
                  SizedBox(height: 10),
                  NestBone(height: 150, radius: 14),
                  SizedBox(height: 10),
                  NestBone(height: 72, radius: 14),
                ],
              ),
            ),
          ],
        ),
      );
}

/// An empty conversation: the business's own opening line, as the first bubble.
///
/// Not "no messages". An empty chat is an invitation, and saying it is empty is
/// the one thing that makes it feel broken.
class _Greeting extends StatelessWidget {
  const _Greeting({required this.theme, required this.appearance, required this.name});
  final NestTheme theme;
  final NestAppearance appearance;
  final String? name;

  @override
  Widget build(BuildContext context) {
    final words = fillVisitorName(appearance.greeting, name).trim();
    return Align(
      alignment: Alignment.bottomLeft,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14 + NestBubble.faceColumn + 8, 14, 40, 14),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
          decoration: BoxDecoration(
            color: theme.raised,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(18),
              topRight: Radius.circular(18),
              bottomRight: Radius.circular(18),
              bottomLeft: Radius.circular(6),
            ),
            boxShadow: theme.lift,
          ),
          child: Text(
            words.isEmpty ? 'Ask us anything — we read every message.' : words,
            style: TextStyle(fontSize: 15, height: 1.42, color: theme.text),
          ),
        ),
      ),
    );
  }
}

/// Where the customer writes: the web widget's composer — a rounded field on
/// the panel colour, the attach button before it, and the send button after.
class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.theme,
    required this.placeholder,
    required this.sending,
    required this.attaching,
    required this.onSend,
    required this.onChanged,
    required this.onRecorded,
    required this.onRecordError,
    this.onAttach,
  });

  final TextEditingController controller;
  final NestTheme theme;
  final String placeholder;
  final bool sending;
  final bool attaching;
  final VoidCallback onSend;
  final ValueChanged<String> onChanged;
  final ValueChanged<RecordedNote> onRecorded;
  final ValueChanged<String> onRecordError;
  final VoidCallback? onAttach;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 10, 10, 10),
      decoration: BoxDecoration(
        color: theme.surface,
        border: Border(top: BorderSide(color: theme.line)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (onAttach != null)
            SizedBox(
              width: 40,
              height: 40,
              child: IconButton(
                padding: EdgeInsets.zero,
                onPressed: attaching ? null : onAttach,
                icon: attaching
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(Icons.add_photo_alternate_outlined, color: theme.muted, size: 24),
                tooltip: 'Attach',
              ),
            )
          else
            const SizedBox(width: 4),
          const SizedBox(width: 4),
          Expanded(
            child: Container(
              constraints: const BoxConstraints(minHeight: 40),
              decoration: BoxDecoration(
                color: theme.panel,
                border: Border.all(color: theme.line),
                borderRadius: BorderRadius.circular(20),
              ),
              child: TextField(
                controller: controller,
                onChanged: onChanged,
                minLines: 1,
                maxLines: 5,
                cursorColor: theme.accent,
                textCapitalization: TextCapitalization.sentences,
                // Newline, not send. On a phone the return key is next to
                // everything, and a half-written complaint sent by accident is
                // worse than one extra tap.
                textInputAction: TextInputAction.newline,
                keyboardType: TextInputType.multiline,
                style: TextStyle(fontSize: 16, height: 1.3, color: theme.text),
                decoration: InputDecoration(
                  isDense: true,
                  hintText: placeholder,
                  hintStyle: TextStyle(color: theme.muted, fontSize: 16),
                  border: InputBorder.none,
                  contentPadding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          // The mic gives way to send the moment there is anything to send. Two
          // buttons side by side would make the commonest action — sending what
          // you just typed — a choice between targets.
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: controller,
            builder: (context, value, _) => value.text.trim().isEmpty
                ? SizedBox(
                    width: 40,
                    height: 40,
                    child: Center(
                      child: NestRecorderButton(
                        theme: theme,
                        enabled: !sending,
                        onRecorded: onRecorded,
                        onError: onRecordError,
                      ),
                    ),
                  )
                : _SendButton(theme: theme, sending: sending, onSend: onSend),
          ),
        ],
      ),
    );
  }
}

/// The round send button, in the brand colour.
class _SendButton extends StatelessWidget {
  const _SendButton({required this.theme, required this.sending, required this.onSend});
  final NestTheme theme;
  final bool sending;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) => AnimatedScale(
        scale: sending ? 0.94 : 1,
        duration: const Duration(milliseconds: 140),
        child: AnimatedOpacity(
          opacity: sending ? 0.5 : 1,
          duration: const Duration(milliseconds: 140),
          child: Material(
            color: theme.accent,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: sending ? null : onSend,
              child: Tooltip(
                message: 'Send',
                child: SizedBox(
                  width: 40,
                  height: 40,
                  child: Icon(Icons.arrow_upward_rounded, color: theme.onAccent, size: 22),
                ),
              ),
            ),
          ),
        ),
      );
}

/// What the composer is answering.
class _ReplyingTo extends StatelessWidget {
  const _ReplyingTo({
    required this.theme,
    required this.message,
    required this.onCancel,
  });

  final NestTheme theme;
  final NestMessage message;
  final VoidCallback onCancel;

  /// What to show when the message being answered had no words of its own.
  String get _label {
    final words = message.body.trim();
    if (words.isNotEmpty) return words;
    final voice = message.voice;
    if (voice != null) return 'Voice message';
    if (message.attachments.isEmpty) return 'Message';
    return message.attachments.first.isImage ? 'Photo' : 'Attachment';
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 0),
      padding: const EdgeInsets.fromLTRB(10, 7, 4, 7),
      decoration: BoxDecoration(
        color: theme.accent.withValues(alpha: 0.08),
        borderRadius: const BorderRadius.vertical(top: Radius.circular(8)),
        border: Border(left: BorderSide(color: theme.accent, width: 3)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  message.isMine ? 'Replying to yourself' : 'Replying to ${message.authorName ?? 'them'}',
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    color: theme.accent,
                  ),
                ),
                Text(
                  _label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, color: theme.muted),
                ),
              ],
            ),
          ),
          IconButton(
            onPressed: onCancel,
            icon: Icon(Icons.close_rounded, size: 18, color: theme.muted),
            tooltip: 'Stop replying',
            visualDensity: VisualDensity.compact,
          ),
        ],
      ),
    );
  }
}

/// What stands where the composer was, once an agent has closed the chat.
///
/// Two jobs, and the second is the one that matters. It says the conversation
/// has ended — in the business's own words, because "closed" means a resolved
/// ticket to one and an ended shift to another — and it offers the way back in.
/// Without that button this is a dead end: the customer has been told the chat
/// is over and given nothing to do about it, on a screen whose only other
/// control is the one that dismisses it.
///
/// It replaces the composer rather than disabling it. A greyed-out text field
/// invites a tap and then refuses it, which reads as the app being broken
/// rather than as the conversation being finished.
class _ClosedNotice extends StatelessWidget {
  const _ClosedNotice({
    required this.theme,
    required this.message,
    required this.newChatLabel,
    required this.busy,
    required this.onNewChat,
  });

  final NestTheme theme;

  /// The business's closing words. Deliberately blank for some of them — the
  /// chat simply stops rather than announcing that it has — so an empty string
  /// is a layout with no paragraph, not a paragraph with no text.
  final String message;
  final String newChatLabel;
  final bool busy;
  final VoidCallback onNewChat;

  @override
  Widget build(BuildContext context) {
    final label = newChatLabel.trim().isEmpty ? 'Start a new chat' : newChatLabel;
    return Container(
      width: double.infinity,
      // As with the composer: the sheet above has already moved clear of the
      // keyboard, and counting it twice was what collapsed the thread.
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: theme.surface,
        border: Border(top: BorderSide(color: theme.line)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (message.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                message,
                textAlign: TextAlign.center,
                style: TextStyle(color: theme.muted, fontSize: 13, height: 1.4),
              ),
            ),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: busy ? null : onNewChat,
              style: FilledButton.styleFrom(
                backgroundColor: theme.accent,
                foregroundColor: theme.onAccent,
                // 44pt, so it is a target rather than a thing to aim at — this
                // is the only way forward on the screen.
                minimumSize: const Size.fromHeight(44),
              ),
              child: busy
                  ? SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: theme.onAccent),
                    )
                  : Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }
}

/// Our one line, at the bottom of whichever screen is up.
class _Branding extends StatelessWidget {
  const _Branding({required this.theme});
  final NestTheme theme;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(12, 2, 12, 8),
        child: Center(
          child: Text(
            'Powered by Nest Connect',
            style: TextStyle(fontSize: 11, color: theme.muted),
          ),
        ),
      );
}

/// Under a conversation being read back: what it is, and the way out of it.
///
/// Where the live thread has a composer, this says why there isn't one. A
/// read-only thread with nothing under it looks like a chat whose box has failed
/// to load.
class _PastFooter extends StatelessWidget {
  const _PastFooter({required this.theme, required this.closed, required this.onBack});

  final NestTheme theme;
  final bool closed;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        decoration: BoxDecoration(border: Border(top: BorderSide(color: theme.line))),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              closed
                  ? 'This conversation is closed.'
                  : 'You are reading an earlier conversation.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: theme.muted),
            ),
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: onBack,
                style: FilledButton.styleFrom(
                  backgroundColor: theme.accent,
                  foregroundColor: theme.onAccent,
                ),
                // Not "start a new chat": the chat card on the screen this goes
                // back to is that offer, and making the same offer twice in two
                // wordings reads as two different things.
                child: const Text('Back'),
              ),
            ),
          ],
        ),
      );
}
