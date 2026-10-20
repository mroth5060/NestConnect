/// What the server says, as Dart.
///
/// Hand-written rather than generated, and parsed defensively throughout: this
/// package runs inside somebody else's app, against a server that may be newer
/// than it. A field that arrives missing, null, or as a type we did not expect
/// must not throw — an app whose chat crashes because we added a field is an
/// app that stops shipping our updates.
library;

/// Which build of the SDK an app is actually running.
///
/// Exists because "have you pulled the latest?" is not a question anybody can
/// answer by looking. A host app takes this package as a git dependency, and
/// `pubspec.lock` pins the commit it resolved to: pulling the NestConnect repo
/// moves nothing, `pub get` honours the lock, and the app goes on building the
/// same SDK it built last month while the repository looks completely current.
///
/// Print it at startup, or put it behind a debug screen. One line settles what
/// otherwise takes a round trip and a screenshot:
///
/// ```dart
/// debugPrint('Nest Connect SDK $nestConnectSdkVersion');
/// ```
///
/// Kept in step with both pubspecs by tools/check-sdk-version.ts, because a
/// version constant that drifts from the package it names is worse than none:
/// it answers the question confidently and wrongly.
const String nestConnectSdkVersion = '0.6.3';

/// How hard the channel checked who you said you were.
enum NestIdentity {
  /// The details sent were trusted, and the chat is on that customer's record.
  verified,

  /// Nobody was identified: an anonymous thread, none of the details kept.
  anonymous,
}

/// A file on a message.
class NestAttachment {
  const NestAttachment({
    required this.id,
    required this.filename,
    required this.mime,
    this.kind,
    this.durationMs,
    this.waveform = const [],
  });

  final String id;
  final String filename;
  final String mime;

  /// What the server calls it: `voice`, `image`, `video`, `audio`, `file`.
  ///
  /// Carried rather than sniffed from [mime], because a recording and an audio
  /// file somebody attached are both `audio/…` and only one of them is drawn
  /// as a waveform with a play button.
  final String? kind;

  /// How long a recording runs, so a bubble can say "0:07" before a byte of it
  /// has been fetched.
  final int? durationMs;

  /// The bars to draw, 0..1. Measured by whoever recorded it, while it was
  /// being recorded — the alternative is every reader decoding the whole file
  /// to arrive at a shape that is the same for all of them.
  final List<double> waveform;

  bool get isImage => mime.startsWith('image/');
  bool get isVoice => kind == 'voice';

  static NestAttachment? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final id = _str(raw['id']);
    if (id == null) return null;
    return NestAttachment(
      id: id,
      filename: _str(raw['filename']) ?? 'file',
      mime: _str(raw['mime']) ?? 'application/octet-stream',
      kind: _str(raw['kind']),
      durationMs: _int(raw['durationMs']),
      waveform: _list(raw['waveform'])
          .map(_double)
          .whereType<double>()
          // Clamped rather than trusted: a bar outside 0..1 is drawn as a
          // sliver or as a spike through the bubble above.
          .map((v) => v.clamp(0.0, 1.0))
          .toList(growable: false),
    );
  }
}

/// An emoji somebody put on a message.
class NestReaction {
  const NestReaction({required this.emoji, required this.mine});

  final String emoji;

  /// Put there by the person holding this phone. The server writes `by` from
  /// the reader's point of view, so this needs no interpretation here.
  final bool mine;

  static NestReaction? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final emoji = _str(raw['emoji']);
    if (emoji == null || emoji.isEmpty) return null;
    return NestReaction(emoji: emoji, mine: _str(raw['by']) == 'visitor');
  }
}

/// The message a reply is answering.
///
/// Flattened onto the reply by the server rather than referenced by id: the
/// original may be older than the window this client holds, and a quote that
/// renders blank because it scrolled out of memory is worse than no quote.
class NestQuote {
  const NestQuote({
    required this.id,
    required this.fromMe,
    required this.preview,
    this.authorName,
    this.kind,
  });

  final String id;

  /// Quoting the person holding this phone, rather than an agent.
  final bool fromMe;

  /// Already trimmed by the server. Empty when the original had no words, in
  /// which case [kind] says what it was instead.
  final String preview;
  final String? authorName;
  final String? kind;

  /// What to show when there were no words — "" under a reply reads as a
  /// broken quote rather than as a recording.
  String get label {
    if (preview.isNotEmpty) return preview;
    switch (kind) {
      case 'voice':
        return 'Voice message';
      case 'image':
        return 'Photo';
      case 'video':
        return 'Video';
      case 'audio':
        return 'Audio';
      default:
        return 'Attachment';
    }
  }

  static NestQuote? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final id = _str(raw['id']);
    if (id == null) return null;
    return NestQuote(
      id: id,
      fromMe: _str(raw['from']) != 'agent',
      preview: _str(raw['preview']) ?? '',
      authorName: _str(raw['authorName']),
      kind: _str(raw['kind']),
    );
  }
}

/// Who said it.
enum NestAuthor { visitor, agent }

/// One message in the thread.
class NestMessage {
  const NestMessage({
    required this.id,
    required this.from,
    required this.body,
    required this.at,
    this.authorName,
    this.attachments = const [],
    this.reactions = const [],
    this.quote,
    this.pending = false,
    this.failed = false,
  });

  final String id;
  final NestAuthor from;
  final String body;
  final DateTime at;

  /// The agent's name, when an agent said it and the channel shows names.
  final String? authorName;
  final List<NestAttachment> attachments;

  /// Emoji on this message, at most one per person.
  final List<NestReaction> reactions;

  /// The message this one answers, if it answers one.
  final NestQuote? quote;

  /// The voice note on this message, if it is one. A recording is the whole
  /// message rather than a file listed under it — the waveform *is* the
  /// message, so the UI asks this rather than walking the attachments.
  NestAttachment? get voice {
    for (final a in attachments) {
      if (a.isVoice) return a;
    }
    return null;
  }

  /// On its way. Shown immediately so the thread never looks frozen while the
  /// network decides; replaced by the server's copy when it lands.
  final bool pending;

  /// It did not go. Kept in the thread rather than removed, because a message
  /// that vanishes looks like one that was sent.
  final bool failed;

  bool get isMine => from == NestAuthor.visitor;

  NestMessage copyWith({
    bool? pending,
    bool? failed,
    List<NestReaction>? reactions,
  }) =>
      NestMessage(
        id: id,
        from: from,
        body: body,
        at: at,
        authorName: authorName,
        attachments: attachments,
        reactions: reactions ?? this.reactions,
        quote: quote,
        pending: pending ?? this.pending,
        failed: failed ?? this.failed,
      );

  static NestMessage? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final id = _str(raw['id']);
    if (id == null) return null;
    return NestMessage(
      id: id,
      from: _str(raw['from']) == 'agent' ? NestAuthor.agent : NestAuthor.visitor,
      body: _str(raw['body']) ?? '',
      // A message we cannot date is still a message. Dropping it would leave a
      // hole in the conversation; putting it at "now" keeps the order sensible.
      at: DateTime.tryParse(_str(raw['at']) ?? '')?.toLocal() ?? DateTime.now(),
      authorName: _str(raw['authorName']),
      attachments: _list(raw['attachments'])
          .map(NestAttachment.tryParse)
          .whereType<NestAttachment>()
          .toList(growable: false),
      reactions: _list(raw['reactions'])
          .map(NestReaction.tryParse)
          .whereType<NestReaction>()
          .toList(growable: false),
      quote: NestQuote.tryParse(raw['quote']),
    );
  }
}

/// How the channel looks and what it says — the same settings the web widget
/// reads, so a brand colour changed in Settings reaches the app without an app
/// release.
class NestAppearance {
  const NestAppearance({
    required this.accent,
    required this.onAccent,
    required this.title,
    required this.subtitle,
    required this.headline,
    required this.greeting,
    required this.placeholder,
    required this.awayMessage,
    required this.closedMessage,
    required this.newChatLabel,
    required this.showBranding,
    this.logoUrl,
    this.accentTo,
    this.headerGradient = false,
    this.theme = 'light',
  });

  final String accent;
  final String onAccent;

  /// The far end of the header's gradient, and whether there is one at all.
  /// The same pair the web widget reads, so a business that turned the gradient
  /// on sees it on both surfaces rather than on its website alone.
  final String? accentTo;
  final bool headerGradient;

  /// `light`, `dark` or `auto` — chosen by the business, not inherited from the
  /// phone. A brand that set its chat to light should not open dark because the
  /// customer's phone is.
  final String theme;
  final String title;
  final String subtitle;
  final String headline;

  /// The channel's opening line, shown before anybody has said anything. Where
  /// the thread's empty state is the invitation, this is the business's own
  /// words for it — and it takes the customer's name the way the headline does.
  final String greeting;
  final String placeholder;
  final String awayMessage;
  /// What the business says when an agent closes a chat. Blank on purpose is a
  /// real choice: some would rather the chat simply stop than announce it.
  final String closedMessage;
  /// The way back in, once a chat has been closed.
  final String newChatLabel;
  final bool showBranding;
  final String? logoUrl;

  static const fallback = NestAppearance(
    accent: '#2563eb',
    onAccent: '#ffffff',
    title: 'How can we help?',
    subtitle: 'We usually reply in a few minutes',
    headline: '',
    greeting: '',
    placeholder: 'Write a message…',
    awayMessage: "We're away — leave a message and we'll reply.",
    closedMessage: 'This chat has been closed. Thanks for getting in touch!',
    newChatLabel: 'Start a new chat',
    showBranding: true,
  );

  static NestAppearance parse(Object? raw, {String? baseUrl}) {
    if (raw is! Map) return fallback;
    final logo = _str(raw['logoUrl']);
    return NestAppearance(
      accent: _str(raw['accent']) ?? fallback.accent,
      // `accentText`, which is what the server sends. This read `onAccent` — a
      // key that has never existed — so every business got white text on its
      // header whatever it chose, which is unreadable on exactly the pale brand
      // colours that choice exists for.
      onAccent: _str(raw['accentText']) ?? _str(raw['onAccent']) ?? fallback.onAccent,
      accentTo: _str(raw['accentTo']),
      headerGradient: raw['headerGradient'] == true,
      theme: _str(raw['theme']) ?? 'light',
      title: _str(raw['title']) ?? fallback.title,
      subtitle: _str(raw['subtitle']) ?? fallback.subtitle,
      headline: _str(raw['headline']) ?? fallback.headline,
      greeting: _str(raw['greeting']) ?? fallback.greeting,
      placeholder: _str(raw['placeholder']) ?? fallback.placeholder,
      awayMessage: _str(raw['awayMessage']) ?? fallback.awayMessage,
      // `_str` treats '' as absent, which is right for a title and wrong here:
      // the settings pane documents a blank closing message as a real choice —
      // the chat simply stops rather than announcing that it has — so an empty
      // string has to survive instead of being replaced by the default.
      closedMessage: raw['closedMessage'] is String
          ? raw['closedMessage']! as String
          : fallback.closedMessage,
      newChatLabel: _str(raw['newChatLabel']) ?? fallback.newChatLabel,
      showBranding: raw['showBranding'] is bool
          ? raw['showBranding'] as bool
          : fallback.showBranding,
      // Root-relative when the business uploaded it, which is right for the web
      // widget and useless in an app — the same treatment the faces get. Read
      // raw, it was a path with no host, and the logo silently never loaded.
      logoUrl: logo == null ? null : _absolute(logo, baseUrl),
    );
  }
}

/// One card on the channel's home screen — another way to reach the business.
///
/// The words and the link are the business's; the mark is a key from a fixed set
/// rather than an emoji, so a WhatsApp card carries the same glyph on every
/// phone instead of four styles at four weights.
class NestHomeCard {
  const NestHomeCard({
    required this.id,
    required this.label,
    required this.sublabel,
    required this.href,
    this.icon,
  });

  final String id;
  final String label;

  /// The quiet second line — "Usually answers within the hour".
  final String sublabel;

  /// Where it goes. The server only ever stores http, https, mailto and tel, so
  /// this is a link and never a script.
  final String href;

  /// One of `chat`, `whatsapp`, `email`, `phone`, `instagram`, `facebook`, and
  /// whatever the server adds next. Null — including for a key this build has
  /// never heard of — means no mark rather than no card.
  final String? icon;

  static NestHomeCard? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final label = _str(raw['label']);
    final href = _str(raw['href']);
    if (label == null || href == null) return null;
    return NestHomeCard(
      id: _str(raw['id']) ?? label,
      label: label,
      sublabel: _str(raw['sublabel']) ?? '',
      href: href,
      icon: _str(raw['icon']),
    );
  }
}

/// The screen a customer lands on before the conversation.
///
/// Off unless the business turned it on, which is the server's decision and not
/// this package's: it puts a tap between somebody and the message box, and a
/// business that answers on one channel does not need it.
class NestHome {
  const NestHome({
    required this.chatLabel,
    required this.chatSublabel,
    this.cards = const [],
  });

  /// The chat's own card. Not one of [cards] — it is the front door rather than
  /// a link out, always first, and only its words are configurable.
  final String chatLabel;
  final String chatSublabel;
  final List<NestHomeCard> cards;

  static NestHome? tryParse(Object? raw) {
    if (raw is! Map) return null;
    return NestHome(
      chatLabel: _str(raw['chatLabel']) ?? 'Send us a message',
      chatSublabel: _str(raw['chatSublabel']) ?? '',
      cards: _list(raw['cards'])
          .map(NestHomeCard.tryParse)
          .whereType<NestHomeCard>()
          .toList(growable: false),
    );
  }
}

/// One of the customer's own earlier conversations, as a row on the home screen.
///
/// Deliberately not a [NestMessage] list. A chat list row needs what was last
/// said, by whom, when, and whether the thread is still open — and fetching
/// every message of twenty threads to draw twenty rows is twenty threads of
/// traffic for twenty lines of text.
class NestPastConversation {
  const NestPastConversation({
    required this.id,
    required this.closed,
    required this.preview,
    required this.at,
    this.fromMe = false,
    this.authorName,
    this.current = false,
  });

  final String id;

  /// The one this session is writing to. Another open one is switched to with
  /// [NestConnect.switchTo] before it can be written in.
  final bool current;

  /// Resolved by the business. Readable, not writable — a new message starts a
  /// new conversation rather than reopening somebody's finished ticket.
  final bool closed;

  /// The last thing said that this customer is allowed to see. Never an internal
  /// note: the server builds it through the same projection the thread goes
  /// through.
  final String preview;

  /// Whether that last word was theirs, so a row can read "You: …".
  final bool fromMe;

  /// Who answered, for a name on the row.
  final String? authorName;
  final DateTime at;

  static NestPastConversation? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final id = _str(raw['id']);
    if (id == null) return null;
    return NestPastConversation(
      id: id,
      closed: raw['closed'] == true,
      preview: _str(raw['preview']) ?? '',
      fromMe: _str(raw['from']) == 'visitor',
      authorName: _str(raw['authorName']),
      at: DateTime.tryParse(_str(raw['at']) ?? '')?.toLocal() ?? DateTime.now(),
      current: raw['current'] == true,
    );
  }
}

/// One of the faces behind the counter.
class NestTeamMate {
  const NestTeamMate({
    required this.name,
    required this.initials,
    this.color,
    this.avatarUrl,
    this.online = false,
  });

  final String name;

  /// Theirs, not the first letter of their name: "Mary-Jane O'Neill" is MO, and
  /// a name that starts with an emoji has initials that do not.
  final String initials;

  /// Their own avatar colour, so the fallback circle is theirs rather than a
  /// generic one — the same face they have everywhere else in the product.
  final String? color;

  /// Absolute by the time it gets here. The server sends it root-relative,
  /// which is right for a widget resolving against the page that served it and
  /// useless in an app, where there is no page.
  final String? avatarUrl;

  final bool online;

  static NestTeamMate? tryParse(Object? raw, {String? baseUrl}) {
    if (raw is! Map) return null;
    final name = _str(raw['name']);
    if (name == null) return null;
    final path = _str(raw['avatarUrl']);
    return NestTeamMate(
      name: name,
      initials: _str(raw['initials']) ?? (name.isEmpty ? '?' : name.substring(0, 1).toUpperCase()),
      color: _str(raw['color']),
      avatarUrl: path == null ? null : _absolute(path, baseUrl),
      online: raw['online'] == true,
    );
  }
}

/// A root-relative path made loadable from an app.
String _absolute(String path, String? baseUrl) {
  if (!path.startsWith('/') || baseUrl == null) return path;
  return '${baseUrl.replaceAll(RegExp(r'/+$'), '')}$path';
}

/// Put the customer's name into a line the business wrote — "Hello {name} 👋".
///
/// The same rule the web widget applies, spelled out again here because the two
/// have to agree: an app and a website showing the same channel must greet the
/// same person the same way.
///
/// A missing name leaves the sentence readable — the token goes and the space
/// before it goes with it, so "Hello {name} 👋" reads "Hello 👋" rather than
/// "Hello  👋". Only the first name is used: a greeting that says "Hello Nathan
/// Amos" reads like a letter from a bank.
String fillVisitorName(String text, String? name) {
  final first = (name ?? '').trim().split(RegExp(r'\s+')).firstWhere((p) => p.isNotEmpty, orElse: () => '');
  if (first.isEmpty) {
    return text.replaceAll(RegExp(r'\s*\{name\}'), '').replaceAll(RegExp(r'\s{2,}'), ' ').trim();
  }
  return text.replaceAll('{name}', first);
}

/// Everything the messenger needs before it draws anything.
class NestConfig {
  const NestConfig({
    required this.appearance,
    required this.online,
    this.team = const [],
    this.teamTotal = 0,
    this.home,
  });

  final NestAppearance appearance;

  /// The front door, when the business has turned one on. Null means go straight
  /// to the conversation, which is the default and the common case.
  final NestHome? home;

  /// Whether anybody is actually there. Drives which of the two subtitles the
  /// header shows, and it is the difference between a promise we keep and one
  /// we make at 3am.
  final bool online;
  final List<NestTeamMate> team;

  /// Everybody who could answer, of whom [team] is the few shown. The rest are
  /// the "+2" at the end of the stack.
  final int teamTotal;

  static NestConfig parse(Object? raw, {String? baseUrl}) {
    final map = raw is Map ? raw : const <String, Object?>{};
    return NestConfig(
      appearance: NestAppearance.parse(map['appearance'], baseUrl: baseUrl),
      online: map['online'] == true,
      // `faces`, which is what the server sends. This read `members` for its
      // whole life, so the list was always empty and the header never showed
      // anybody — the same mistake as the stream events: written from what
      // seemed reasonable rather than from the payload.
      team: _list((map['team'] as Map?)?['faces'])
          .map((f) => NestTeamMate.tryParse(f, baseUrl: baseUrl))
          .whereType<NestTeamMate>()
          .toList(growable: false),
      teamTotal: ((map['team'] as Map?)?['total'] as num?)?.toInt() ?? 0,
      // Sent only when the business enabled it — the server leaves the key out
      // otherwise, which is the same answer as "go straight to the chat".
      home: NestHome.tryParse(map['home']),
    );
  }
}

/// A file staged for sending, and the ticket that redeems it.
class NestUpload {
  const NestUpload({
    required this.ticket,
    required this.filename,
    required this.mime,
    required this.size,
    this.kind,
    this.durationMs,
    this.waveform = const [],
  });

  final String ticket;
  final String filename;
  final String mime;
  final int size;
  final String? kind;

  /// Set only on a recording: what [NestChatClient.attachVoice] measured.
  final int? durationMs;
  final List<double> waveform;

  /// What the pending bubble draws while this is on its way.
  ///
  /// Without it a voice note sent from a phone is a blank bubble until the
  /// round trip finishes — which is the one case where the person already
  /// knows exactly what they sent, because they watched themselves record it.
  NestAttachment? get preview => durationMs == null
      ? null
      : NestAttachment(
          id: ticket.hashCode.toRadixString(16),
          filename: filename,
          mime: mime,
          kind: 'voice',
          durationMs: durationMs,
          waveform: waveform,
        );

  static NestUpload parse(
    Object? raw, {
    int? durationMs,
    List<double> waveform = const [],
  }) {
    final map = raw is Map ? raw : const <String, Object?>{};
    return NestUpload(
      ticket: _str(map['ticket']) ?? '',
      filename: _str(map['filename']) ?? 'file',
      mime: _str(map['mime']) ?? 'application/octet-stream',
      size: map['size'] is num ? (map['size'] as num).toInt() : 0,
      kind: _str(map['kind']),
      durationMs: durationMs,
      waveform: waveform,
    );
  }
}

/// Something went wrong, with the server's own words where it gave any.
class NestException implements Exception {
  const NestException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;

  /// Whether trying again could plausibly work. A 4xx means we asked wrongly
  /// and asking again identically will fail identically.
  bool get isRetryable => statusCode == null || statusCode! >= 500;

  @override
  String toString() => 'NestException: $message';
}

String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;
List<Object?> _list(Object? v) => v is List ? v : const [];

/// JSON numbers arrive as `int` or `double` depending on whether the encoder
/// felt like writing a decimal point, and a server that sends `7400` today can
/// send `7400.0` tomorrow without anybody calling it a change.
int? _int(Object? v) {
  if (v is int) return v;
  if (v is double && v.isFinite) return v.round();
  if (v is String) return int.tryParse(v);
  return null;
}

double? _double(Object? v) {
  if (v is num) return v.isFinite ? v.toDouble() : null;
  if (v is String) return double.tryParse(v);
  return null;
}
