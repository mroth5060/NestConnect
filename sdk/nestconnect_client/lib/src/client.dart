import 'dart:async';

import 'models.dart';
import 'platform.dart';
import 'store.dart';
import 'transport.dart';

/// A live-chat session against one Nest Connect channel.
///
/// One of these per app, held for the app's life. It owns the token, the
/// thread, and the connection to the live stream — so the messenger UI above it
/// is a view of `messages` and nothing more, and a customer who closes the chat
/// and opens it again finds it where they left it.
///
/// ```dart
/// final chat = NestConnect(baseUrl: 'https://nestconnect.io', appKey: 'na_…');
/// await chat.login(userId: user.id, name: user.name, userHash: user.nestHash);
/// await chat.open(fields: {'order_id': 'DG-88412'});
/// ```
class NestConnect {
  NestConnect({
    required String baseUrl,
    required this.appKey,
    NestTokenStore? tokenStore,
    NestTransport? transport,
  })  : _store = tokenStore ?? NestMemoryTokenStore(),
        _transport = transport ?? NestTransport(baseUrl: baseUrl);

  /// The key from Settings › NestChat widget › In-app SDK. Public by design.
  final String appKey;

  final NestTransport _transport;
  final NestTokenStore _store;

  final _messages = <NestMessage>[];
  final _messagesController = StreamController<List<NestMessage>>.broadcast();
  final _unreadController = StreamController<int>.broadcast();
  final _closedController = StreamController<bool>.broadcast();
  final _typingController = StreamController<bool>.broadcast();

  String? _token;
  NestConfig? _config;
  StreamSubscription<Map<String, Object?>>? _streamSub;
  Timer? _reconnect;
  int _attempt = 0;

  /// Whether an agent is writing, and the timer that stops believing it.
  bool _agentTyping = false;
  Timer? _typingFor;

  /// Which stream is the current one.
  ///
  /// Every connection carries the generation it was opened in, and events from
  /// an older one are dropped. That is what lets this stop waiting on cancels:
  /// a subscription whose response the server is still holding open can take an
  /// arbitrary time to cancel — forever, if the server never lets go — and
  /// neither closing the messenger nor signing out may hang on that.
  int _generation = 0;
  bool _closed = false;

  /// The push address the host app handed us, and what kind of phone it is.
  ///
  /// Kept because registration is tied to a session and a session is not: the
  /// host gets its FCM token from Firebase whenever Firebase feels like giving
  /// it, which is routinely before anybody has opened the chat and again months
  /// later when the token rotates. Holding it means every session that opens
  /// afterwards registers it, instead of the notification quietly depending on
  /// which of the two happened first.
  String? _pushToken;
  String? _pushPlatform;

  /// What to greet them by. Kept because the header's "Hello {name}" is drawn
  /// long after `login` returned, and the session response does not echo it —
  /// so without holding it the token had nothing to be replaced with and the
  /// literal "{name}" went on screen.
  String? _visitorName;
  bool _viewing = false;
  int _unread = 0;

  /// Who [login] said this is, kept for [startNewChat].
  ///
  /// It used to open the new session with none of it, which made somebody
  /// signed in to the app an *anonymous* visitor the moment they started a
  /// second conversation: a new contact with no history, their phone's
  /// notifications moved onto it, and nothing on screen to say so.
  ({String id, String? hash, String? email, String? phone})? _identity;

  /// What the last sign-in came back as, for a repeat of it to answer with.
  NestIdentity? _lastIdentity;

  /// Repeats "the chat is on screen" while it is, so the server's belief in
  /// it expires on its own if this app is killed without saying otherwise.
  Timer? _viewingBeat;

  /// The stream dropped, so something may have arrived while it was down.
  bool _missed = false;

  /// How often an open chat says so. Under the server's minute, with room for
  /// one to go missing.
  static const viewingBeat = Duration(seconds: 25);

  String _tokenKey() => 'nestconnect.token.$appKey';

  /// The thread so far, oldest first. Replaced wholesale on every change, so a
  /// UI can rebuild from it without tracking what moved.
  List<NestMessage> get messages => List.unmodifiable(_messages);
  Stream<List<NestMessage>> get onMessages => _messagesController.stream;

  /// Unread agent replies. What a launcher badge shows.
  int get unread => _unread;
  Stream<int> get onUnread => _unreadController.stream;

  /// Whether an agent is typing to us right now.
  ///
  /// The server says "typing" and never says "stopped" — an agent closing the
  /// tab mid-sentence sends nothing at all — so this times itself out rather
  /// than waiting for a signal that may not come. Comfortably longer than the
  /// agent's ping interval, or the dots blink off and on again while somebody
  /// is still mid-sentence.
  bool get agentTyping => _agentTyping;
  Stream<bool> get onAgentTyping => _typingController.stream;

  /// How long a "typing" is believed for without being repeated.
  static const typingLifetime = Duration(seconds: 6);

  /// Whether an agent has closed this chat, as it changes.
  ///
  /// A getter alone was not enough: nothing else moves when a chat closes — no
  /// message arrives — so a UI watching [onMessages] would never rebuild, and
  /// the customer would keep typing into a composer that still looked live.
  Stream<bool> get onClosed => _closedController.stream;

  /// The name this customer was opened with, for "Hello {name}".
  String? get visitorName => _visitorName;

  /// The channel's appearance, once [open] has fetched it.
  NestConfig? get config => _config;

  /// Whether we have a session at all.
  bool get isOpen => _token != null;

  /// Whether an agent has closed this chat.
  ///
  /// Exposed because otherwise the `closed` event lands and means nothing: it
  /// stops the stream reconnecting and that is all, so a customer sits in front
  /// of a live-looking composer typing into a conversation nobody is watching.
  /// The web widget has always said so and stopped taking messages; a UI on top
  /// of this can now do the same.
  bool get isClosed => _closed;

  /// Say who this is.
  ///
  /// Calling it with a different user than last time throws the old session
  /// away first: two people sharing a phone is a real thing, and inheriting the
  /// previous one's thread would show one customer another's conversation.
  ///
  /// [userHash] is an HMAC-SHA256 of [userId] under the channel's signing
  /// secret, made by your own backend. Without it the channel decides what to
  /// do — trust the details, ignore them, or refuse — and the [NestIdentity]
  /// that comes back says which happened.
  Future<NestIdentity> login({
    required String userId,
    String? userHash,
    String? name,
    String? email,
    String? phone,
    Map<String, String>? fields,
  }) async {
    final who = (id: userId, hash: userHash, email: email, phone: phone);
    // The same person again, saying nothing new — what an app does each time
    // its home page loads. Not a reason to take down the conversation they are
    // in the middle of: tearing it down and back up dropped the live stream,
    // and the minimised chat, seeing no chat for that moment, put itself away.
    final last = _lastIdentity;
    if (_token != null && _identity == who && (fields == null || fields.isEmpty) && last != null) {
      if (name != null && name.trim().isNotEmpty) _visitorName = name.trim();
      // The channel's look is still fetched again, as a sign-in always did —
      // an app relaunched to the home page picks up a change made in Settings.
      unawaited(_loadConfig());
      return last;
    }
    // Somebody else is a different matter: they must not inherit the thread.
    // The same person with something new keeps their stored session but not
    // the live stream, which may be about a different conversation from the
    // one the new details lead to.
    if (_identity?.id != userId) {
      await _endSession();
    } else {
      _dropStream();
    }
    _identity = who;
    return _lastIdentity = await _session(
      externalId: userId,
      userHash: userHash,
      name: name,
      email: email,
      phone: phone,
      fields: fields,
    );
  }

  /// Open the chat — optionally about something, with [fields].
  ///
  /// As whoever [login] said this is, when somebody is signed in; anonymous,
  /// with the thread belonging to this install alone, when nobody is.
  ///
  /// It used to be anonymous always. The README's own example is `login`
  /// followed by `open(fields: …)`, so an app doing exactly what it was told
  /// replaced the signed-in session with a stranger's: the fields landed on an
  /// anonymous visitor's thread (or nowhere, on a channel that requires
  /// signing in), and the customer's own chat never saw them.
  Future<NestIdentity> open({Map<String, String>? fields}) {
    final who = _identity;
    if (who == null) return _session(fields: fields);
    return login(
      userId: who.id,
      userHash: who.hash,
      name: _visitorName,
      email: who.email,
      phone: who.phone,
      fields: fields,
    );
  }

  /// Forget this session. Called when somebody signs out of the host app: the
  /// next person to open the chat must not find the last one's conversation.
  Future<void> logout() async {
    // Before the session goes: the endpoint that forgets a device is scoped to
    // the token, so once `_endSession` has cleared it there is no way left to
    // say who the phone was. Getting this order wrong leaves the last person's
    // notifications arriving on a phone that has signed out of their account.
    await _forgetPush(keepAddress: true);
    await _endSession();
    _setMessages(const []);
    _setUnread(0);
  }

  Future<NestIdentity> _session({
    String? externalId,
    String? userHash,
    String? name,
    String? email,
    String? phone,
    Map<String, String>? fields,
  }) async {
    final body = <String, Object?>{
      if (externalId != null) 'externalId': externalId,
      if (userHash != null) 'userHash': userHash,
      if (name != null) 'name': name,
      if (email != null) 'email': email,
      if (phone != null) 'phone': phone,
      if (fields != null && fields.isNotEmpty) 'fields': fields,
    };
    _visitorName = name?.trim().isEmpty ?? true ? _visitorName : name!.trim();
    final raw = await _transport.postJson('/app/$appKey/session', body);
    final map = raw is Map ? raw : const <String, Object?>{};

    _token = map['token'] as String?;
    if (_token != null) await _store.write(_tokenKey(), _token!);
    _closed = false;
    // A new token can name a different conversation; the server's "on screen"
    // belongs to the one it names.
    if (_viewing) unawaited(_reportViewing());

    _setMessages(
      (map['messages'] as List? ?? const [])
          .map(NestMessage.tryParse)
          .whereType<NestMessage>()
          .toList(growable: false),
    );

    // Field keys the workspace has never heard of. Not thrown — the chat still
    // works — but surfaced where an integrator will see it on the day they
    // write the typo rather than a year later.
    final unknown = (map['unknownFields'] as List? ?? const []).whereType<String>().toList();
    if (unknown.isNotEmpty) {
      // ignore: avoid_print
      print('[nestconnect] this channel has no field named: ${unknown.join(', ')}');
    }

    unawaited(_loadConfig());
    unawaited(_registerPush());
    if (map['hasConversation'] == true) _listen();

    final identified = map['identified'] == true;
    // Said out loud, because the alternative is what happens in practice: a
    // name, an email and a phone number are sent, the chat works perfectly,
    // and every one of them was discarded on the way in. The return value has
    // always carried this and is very easy not to read — and nothing else on
    // screen looks wrong until somebody notices every customer is called
    // "Visitor" and something-hex.
    if (!identified && externalId != null) {
      // ignore: avoid_print
      print(
        '[nestconnect] this session was not verified, so the name, email and '
        'phone were discarded and the chat is anonymous. The backend must send '
        'userHash: HMAC-SHA256 of the user id, hex, under the channel\'s '
        'signing secret.',
      );
    }

    return identified ? NestIdentity.verified : NestIdentity.anonymous;
  }

  Future<void> _loadConfig() async {
    try {
      // The base url goes in so the faces' photo paths — root-relative, because
      // the web widget resolves them against whatever origin served it — come
      // back as something an app can actually load.
      _config = NestConfig.parse(
        await _transport.getJson('/app/$appKey/config'),
        baseUrl: _transport.baseUrl,
      );
    } on NestException {
      // The messenger opens in fallback colours rather than not opening. A
      // chat that refuses to appear because a greeting did not load is a chat
      // nobody can use.
      _config ??= const NestConfig(appearance: NestAppearance.fallback, online: false);
    }
  }

  /// Send a message, optionally with files already staged by [attach].
  ///
  /// The message appears in the thread immediately, marked pending, and is
  /// replaced by the server's copy when it lands. That is not decoration: on a
  /// phone the send button is pressed on a train, and a thread that shows
  /// nothing until the network answers looks broken.
  Future<void> send(
    String text, {
    List<NestUpload> attachments = const [],
    /// The message being answered. Checked against the thread by the server —
    /// an id from another conversation is dropped rather than quoted.
    NestMessage? replyTo,
  }) async {
    final token = _token;
    if (token == null) throw const NestException('Open a chat before sending');
    final body = text.trim();
    if (body.isEmpty && attachments.isEmpty) return;

    final local = NestMessage(
      id: 'pending-${DateTime.now().microsecondsSinceEpoch}',
      from: NestAuthor.visitor,
      body: body,
      at: DateTime.now(),
      pending: true,
      // Drawn from what is already on screen rather than waiting for the
      // server's copy. The quote is the reason they are typing at all, and a
      // reply that appears without it reads as the wrong reply.
      quote: replyTo == null ? null : _quoteOf(replyTo),
      attachments: attachments
          .map((a) => a.preview)
          .whereType<NestAttachment>()
          .toList(growable: false),
    );
    _setMessages([..._messages, local]);

    try {
      final raw = await _transport.postJson(
        '/message',
        {
          'body': body,
          if (attachments.isNotEmpty)
            'attachments': attachments.map((a) => a.ticket).toList(growable: false),
          if (replyTo != null) 'quotedMsgId': replyTo.id,
        },
        token: token,
      );
      final map = raw is Map ? raw : const <String, Object?>{};

      // The first message is what creates the conversation, so the token we
      // hold does not name one yet and the server hands back the one that does.
      final next = map['token'] as String?;
      if (next != null && next != _token) {
        _token = next;
        await _store.write(_tokenKey(), next);
        _listen();
        // The first message is what creates the conversation, so this is the
        // first moment there is one for the chat on screen to be showing.
        if (_viewing) unawaited(_reportViewing());
      }

      final saved = NestMessage.tryParse(map['message']);
      _setMessages([
        ..._messages.where((m) => m.id != local.id),
        if (saved != null) saved else local.copyWith(pending: false),
      ]);
    } on NestException {
      // Kept in the thread and marked, not removed. A message that disappears
      // reads as one that was sent.
      _setMessages([
        ..._messages.where((m) => m.id != local.id),
        local.copyWith(pending: false, failed: true),
      ]);
      rethrow;
    }
  }

  /// Stage a file. The result goes to [send]; nothing is sent until it does.
  Future<NestUpload> attach({
    required List<int> bytes,
    required String filename,
    required String mime,
  }) async {
    final token = _token;
    if (token == null) throw const NestException('Open a chat before attaching');
    return _transport.upload(token: token, bytes: bytes, filename: filename, mime: mime);
  }

  /// Stage a recording, with the shape that was measured while it was made.
  ///
  /// Separate from [attach] because of what the extra two arguments buy. They
  /// are what tells the server this is a voice note rather than an audio file
  /// somebody picked from their library — both are `audio/…`, and only one of
  /// them is drawn as a waveform with a play button. They also mean nobody has
  /// to decode the file to draw it: the duration is on the bubble before a
  /// byte has been fetched, and the bars are the ones the person watched
  /// while they were talking.
  Future<NestUpload> attachVoice({
    required List<int> bytes,
    required String mime,
    required int durationMs,
    required List<double> waveform,
    String filename = 'voice',
  }) async {
    final token = _token;
    if (token == null) throw const NestException('Open a chat before attaching');
    final bars = waveform
        .where((v) => v.isFinite)
        .map((v) => v.clamp(0.0, 1.0))
        .toList(growable: false);
    final staged = await _transport.upload(
      token: token,
      bytes: bytes,
      filename: filename,
      mime: mime,
      fields: {
        'durationMs': '$durationMs',
        // A JSON array in a form field, trimmed to two decimals — the bars are
        // drawn about three pixels wide and the rest is bytes nobody can see.
        'waveform': '[${bars.map((v) => v.toStringAsFixed(2)).join(',')}]',
      },
    );
    // The ticket is the server's; the shape is ours, kept so the pending
    // bubble can draw the note while it is still on its way.
    return NestUpload(
      ticket: staged.ticket,
      filename: staged.filename,
      mime: staged.mime,
      size: staged.size,
      kind: staged.kind,
      durationMs: durationMs,
      waveform: bars,
    );
  }

  /// Put an emoji on a message, or take ours off with an empty string.
  ///
  /// Drawn under the finger first and corrected when the server answers. A
  /// reaction is the one interaction where the round trip is longer than the
  /// feeling it is meant to give.
  Future<void> react(String messageId, String emoji) async {
    final token = _token;
    if (token == null || messageId.startsWith('pending-')) return;
    final at = _messages.indexWhere((m) => m.id == messageId);
    if (at == -1) return;

    final before = _messages[at];
    final optimistic = [
      ...before.reactions.where((r) => !r.mine),
      if (emoji.isNotEmpty) NestReaction(emoji: emoji, mine: true),
    ];
    _replaceAt(at, before.copyWith(reactions: optimistic));

    try {
      final raw = await _transport.postJson(
        '/react',
        {'messageId': messageId, 'emoji': emoji},
        token: token,
      );
      final map = raw is Map ? raw : const <String, Object?>{};
      final saved = NestMessage.tryParse(map['message']);
      // The server's copy is the whole message, not the one emoji: only it
      // knows what the set looks like after both sides have touched it.
      if (saved != null) {
        final now = _messages.indexWhere((m) => m.id == messageId);
        if (now != -1) _replaceAt(now, saved);
      }
    } on NestException {
      final now = _messages.indexWhere((m) => m.id == messageId);
      if (now != -1) _replaceAt(now, before);
    }
  }

  void _replaceAt(int index, NestMessage message) {
    final next = [..._messages];
    next[index] = message;
    _setMessages(next);
  }

  /// The quote a reply carries, built from the message on screen.
  ///
  /// Only has to be right for the moment before the server's copy arrives, and
  /// it is built from the same message the server resolves the id against.
  NestQuote _quoteOf(NestMessage m) {
    final words = m.body.trim().replaceAll(RegExp(r'\s+'), ' ');
    return NestQuote(
      id: m.id,
      fromMe: m.isMine,
      authorName: m.authorName,
      preview: words.length > 120 ? '${words.substring(0, 119)}\u2026' : words,
      kind: m.attachments.isEmpty ? null : m.attachments.first.kind,
    );
  }

  /// Every conversation this customer has had on this channel, newest first.
  ///
  /// Why it has to exist: a chat the business resolves is never resumed — a new
  /// session only ever joins an open thread — so the moment an agent closed one
  /// it left this side entirely. The app showed an empty box, and everything
  /// agreed about the order was readable only by the business.
  ///
  /// No id goes up. The customer and the channel both come out of the token, so
  /// this can only ever return their own.
  Future<List<NestPastConversation>> conversations() async {
    final token = _token;
    if (token == null) return const [];
    try {
      final raw = await _transport.getJson('/conversations', token: token);
      final map = raw is Map ? raw : const <String, Object?>{};
      return (map['conversations'] as List? ?? const [])
          .map(NestPastConversation.tryParse)
          .whereType<NestPastConversation>()
          .toList(growable: false);
    } on NestException {
      // A history that will not load is a home screen with no history on it, not
      // a chat that refuses to open.
      return const [];
    }
  }

  /// Make another of this customer's open conversations the one being written
  /// to — the order they tapped on the home screen.
  ///
  /// A channel with a conversation per order gives a customer several open at
  /// once, but a session writes to one. Tapping another used to show the
  /// session's own thread instead. This moves the session: the server checks
  /// the conversation is theirs and open, and hands back a token naming it,
  /// with its messages. Throws [NestException] when it isn't (closed meanwhile,
  /// or not theirs) — the session stays where it was.
  Future<void> switchTo(String conversationId) async {
    final token = _token;
    if (token == null) return;
    final raw = await _transport.postJson(
      '/conversations/${Uri.encodeComponent(conversationId)}/open',
      const <String, Object?>{},
      token: token,
    );
    final map = raw is Map ? raw : const <String, Object?>{};
    final next = map['token'] as String?;
    if (next == null || token != _token) return;
    _dropStream();
    _token = next;
    await _store.write(_tokenKey(), next);
    _setClosed(false);
    _setMessages(
      (map['messages'] as List? ?? const [])
          .map(NestMessage.tryParse)
          .whereType<NestMessage>()
          .toList(growable: false),
    );
    _listen();
    // "On screen" belongs to the conversation the token names, which is now
    // this one.
    if (_viewing) unawaited(_reportViewing());
  }

  /// One earlier conversation, read in full.
  ///
  /// Read-only on purpose, and separate from [messages] for that reason: this is
  /// not the thread being added to, so it is handed back rather than swapped into
  /// the live one. Sending into a finished conversation is not a thing the
  /// customer can do — [startNewChat] is.
  Future<List<NestMessage>> conversation(String conversationId) async {
    final token = _token;
    if (token == null) return const [];
    final raw = await _transport.getJson(
      '/conversations/${Uri.encodeComponent(conversationId)}/messages',
      token: token,
    );
    final map = raw is Map ? raw : const <String, Object?>{};
    return (map['messages'] as List? ?? const [])
        .map(NestMessage.tryParse)
        .whereType<NestMessage>()
        .toList(growable: false);
  }

  /// Tell the agent somebody is typing, and what they have written so far.
  Future<void> typing(String preview) async {
    final token = _token;
    if (token == null) return;
    try {
      await _transport.postJson('/typing', {'preview': preview}, token: token);
    } on NestException {
      // A dropped typing ping is not worth telling anybody about.
    }
  }

  /// The chat is on screen, or is not.
  ///
  /// Two jobs: it zeroes the badge, and it is what turns an agent's ticks from
  /// delivered to read — a different claim, and the only one worth showing them
  /// as read.
  ///
  /// And a third, which is the one notifications depend on: it tells the
  /// server, and only while this is true does an agent's reply go unpushed.
  /// The server used to infer it from the live stream — which this holds for
  /// as long as somebody is signed in, so a phone locked in a pocket counted
  /// as a customer reading and was never rung. `NestMessenger` calls this as
  /// the chat opens and closes and as the app goes to and from the background;
  /// a UI of your own should do the same.
  Future<void> setViewing(bool viewing) async {
    final changed = viewing != _viewing;
    _viewing = viewing;
    _viewingBeat?.cancel();
    _viewingBeat = viewing
        ? Timer.periodic(viewingBeat, (_) => unawaited(_reportViewing()))
        : null;
    if (changed || viewing) unawaited(_reportViewing());
    if (!viewing) return;
    _setUnread(0);
    await _markRead('read');
  }

  Future<void> _reportViewing() async {
    final token = _token;
    if (token == null) return;
    try {
      await _transport.postJson('/viewing', {'viewing': _viewing}, token: token);
    } on NestException {
      // The server forgets "on screen" within a minute on its own. The cost of
      // a lost "off" is one unrung reply; of a lost "on", one spare banner.
    }
  }

  /// Come back from the background, or from a notification being tapped.
  ///
  /// Reconnects the live stream, because a phone quietly kills a backgrounded
  /// app's socket without either end hearing about it, and fetches the thread
  /// again, because whatever arrived in the meantime — the very reply the
  /// notification was about — came while nothing was listening. Without the
  /// second half, tapping a notification opened a chat that did not have the
  /// message in it.
  Future<void> resume() async {
    if (_token == null) return;
    if (!_closed) {
      _reconnect?.cancel();
      _attempt = 0;
      _listen();
    }
    await refresh();
  }

  /// Fetch the thread again and fold it into what is on screen.
  ///
  /// The server's copy wins for every message it has; messages still on their
  /// way from here are kept after it, since the server has not seen them yet.
  Future<void> refresh() async {
    final token = _token;
    if (token == null) return;
    try {
      final raw = await _transport.getJson('/messages', token: token);
      final map = raw is Map ? raw : const <String, Object?>{};
      final fresh = (map['messages'] as List? ?? const [])
          .map(NestMessage.tryParse)
          .whereType<NestMessage>()
          .toList(growable: false);
      if (fresh.isEmpty || token != _token) return;
      final known = _messages.map((m) => m.id).toSet();
      final arrived = fresh.where((m) => !known.contains(m.id) && m.from == NestAuthor.agent).length;
      final ids = fresh.map((m) => m.id).toSet();
      _setMessages([
        ...fresh,
        ..._messages.where((m) => (m.pending || m.failed) && !ids.contains(m.id)),
      ]);
      if (arrived > 0) {
        if (_viewing) {
          unawaited(_markRead('read'));
        } else {
          _setUnread(_unread + arrived);
        }
      }
    } on NestException {
      // Nothing new is the same as nothing fetched, as far as the screen goes.
    }
  }

  /// Whether a push notification's data is one of ours.
  ///
  /// Every push this sends carries `source: nestconnect` and the conversation
  /// it is about, so an app that also receives its own notifications can tell
  /// which ones should open the chat.
  static bool isNotification(Map<String, Object?> data) => data['source'] == 'nestconnect';

  /// Begin a fresh conversation after an agent has closed this one.
  ///
  /// The thread on screen is cleared and a new session opened. Nothing has to
  /// be said to the server about starting over: a closed conversation is never
  /// resumed — `threadFor` only ever joins an open one — so the next message
  /// lands in a new thread by itself.
  ///
  /// Which is also why this is not `logout`. The customer is the same person
  /// and should stay so: their history, their contact record and their push
  /// registration all survive. Only the conversation is new.
  Future<NestIdentity> startNewChat({Map<String, String>? fields}) async {
    _setMessages(const []);
    _setUnread(0);
    _setClosed(false);
    // The same person, still signed in. Opened without these, this made them a
    // stranger: a new anonymous contact with no history, holding their phone.
    final who = _identity;
    return _session(
      externalId: who?.id,
      userHash: who?.hash,
      name: _visitorName,
      email: who?.email,
      phone: who?.phone,
      fields: fields,
    );
  }

  /* ---- notifications ---- */

  /// Where to reach this phone when an agent replies and the app is closed.
  ///
  /// The token comes from the host app rather than from here. This package has
  /// no plugins by design — an app that already uses Firebase has the token in
  /// hand, and one that does not should not acquire a Firebase dependency
  /// because it added a chat.
  ///
  /// Safe to call before anybody has opened a chat: it is remembered and sent
  /// with the next session. Safe to call again with the same token, which is
  /// what an app does on every launch, and necessary when Firebase rotates it.
  Future<void> registerPushToken(String token, {String? platform}) async {
    _pushToken = token;
    _pushPlatform = platform ?? defaultPushPlatform();
    await _registerPush();
  }

  /// Stop notifying this phone — notifications turned off in the host app's own
  /// settings, or a sign-out.
  ///
  /// Signing out calls this for you. It is separate as well because the two are
  /// different wishes: somebody who turns notifications off has not signed out,
  /// and somebody who signs out may well want them back on the next account.
  Future<void> unregisterPushToken() async {
    await _forgetPush(keepAddress: false);
  }

  /// Drop the server-side registration.
  ///
  /// [keepAddress] is the difference between the two callers, and it matters. A
  /// sign-out keeps it: the address belongs to the *phone*, the host app hands
  /// it over once at launch and will not hand it over again, so forgetting it
  /// here means the next person to sign in on this handset never gets a
  /// notification. Somebody turning notifications off means the address too —
  /// otherwise the next session would helpfully register it again.
  Future<void> _forgetPush({required bool keepAddress}) async {
    final push = _pushToken;
    final session = _token;
    if (!keepAddress) _pushToken = null;
    if (push == null || session == null) return;
    try {
      await _transport.postJson('/device/forget', {
        'token': push,
        'platform': _pushPlatform ?? defaultPushPlatform(),
      }, token: session);
    } on NestException {
      // The server forgets it on its own once FCM reports the address dead.
    }
  }

  Future<void> _registerPush() async {
    final push = _pushToken;
    final session = _token;
    if (push == null || session == null) return;
    try {
      await _transport.postJson('/device', {
        'token': push,
        'platform': _pushPlatform ?? defaultPushPlatform(),
      }, token: session);
    } on NestException {
      // Not fatal and not worth a retry loop: the next session registers it
      // again, and a chat that works without notifications beats one that
      // refuses to open because a notification could not be arranged.
    }
  }

  Future<void> _markRead(String status) async {
    final token = _token;
    final last = _messages.where((m) => m.from == NestAuthor.agent && !m.pending).lastOrNull;
    if (token == null || last == null) return;
    try {
      await _transport.postJson(
        '/read',
        {'throughMessageId': last.id, 'status': status},
        token: token,
      );
    } on NestException {
      // Ticks are worth trying for and never worth failing over.
    }
  }

  /* ---- the live stream ---- */

  void _listen() {
    final token = _token;
    if (token == null || _closed) return;
    final mine = ++_generation;
    unawaited(_streamSub?.cancel());
    _streamSub = _transport.stream(token).listen(
      (event) => _onEvent(mine, event),
      onError: (Object _) => _scheduleReconnect(mine),
      onDone: () => _scheduleReconnect(mine),
      cancelOnError: true,
    );
    // Back after a drop: the stream carries what happens from now on, not what
    // happened while it was down.
    if (_missed) {
      _missed = false;
      unawaited(refresh());
    }
  }

  void _onEvent(int generation, Map<String, Object?> event) {
    // A connection we have moved on from. Its events are about a session that
    // is over, or a duplicate of ones the current stream is already carrying.
    if (generation != _generation) return;
    // Connected: any earlier backoff is history.
    _attempt = 0;
    // `kind` and `payload`, because that is what the server sends — see
    // `VisitorEvent` in the API and the fixture both sides now assert against.
    // This read `type` and `message` for its whole life, which meant every
    // agent reply was parsed out of a key that was never there and silently
    // dropped. The test did not catch it because its fake server was written
    // from this switch rather than from the server, so the two agreed with each
    // other and neither agreed with production.
    switch (event['kind']) {
      case 'message':
        final message = NestMessage.tryParse(event['payload']);
        if (message == null) break;
        // The server echoes our own messages back. Ours are already in the
        // thread, and adding them again would double every line somebody sent.
        if (_messages.any((m) => m.id == message.id)) break;
        _setMessages([..._messages, message]);
        if (message.from == NestAuthor.agent) {
          // The sentence has arrived, so the ghost of it being written goes.
          // Waiting for the timeout leaves the same words on screen twice, one
          // of them apparently still being typed.
          _setAgentTyping(false);
          if (_viewing) {
            unawaited(_markRead('read'));
          } else {
            _setUnread(_unread + 1);
            // Delivered, not read: it reached the phone, which is a different
            // thing from somebody having looked at it.
            unawaited(_markRead('delivered'));
          }
        }
      case 'reaction':
        // The whole message, replacing the row rather than merging an emoji
        // into it. A set with one slot per person cannot be reconciled from a
        // delta without knowing what was already in it, and the two sides
        // disagree about exactly that during two taps in quick succession.
        final updated = NestMessage.tryParse(event['payload']);
        if (updated == null) break;
        final at = _messages.indexWhere((m) => m.id == updated.id);
        if (at == -1) break;
        final next = [..._messages];
        next[at] = updated;
        _setMessages(next);
      case 'typing':
        // Not under `payload`: typing is a flag, not a message. Reading it as
        // one is how this came to be ignored for its whole life — the switch
        // simply had no case, so the dots never appeared in an app however
        // long an agent typed.
        _setAgentTyping(event['typing'] == true);
      case 'closed':
        _setClosed(true);
        // Whatever they were half-way through saying, nobody is going to send
        // it now.
        _setAgentTyping(false);
      case 'reopened':
        // The other half of the pair. Without it `closed` is a one-way door:
        // an agent reopening a thread would leave the app refusing to send
        // into a conversation the business had deliberately opened again.
        _setClosed(false);
    }
  }

  /// Reconnect with a backoff that gives up on looking eager.
  ///
  /// A phone loses its network constantly — a lift, a tunnel, a train — so this
  /// has to be patient without being slow to come back. It caps at half a
  /// minute, because past that the customer has put the phone down.
  void _scheduleReconnect(int generation) {
    if (_closed || _token == null || generation != _generation) return;
    _missed = true;
    _reconnect?.cancel();
    final wait = Duration(milliseconds: (500 * (1 << _attempt)).clamp(500, 30000));
    _attempt = (_attempt + 1).clamp(0, 6);
    _reconnect = Timer(wait, _listen);
  }

  /// Let go of the live stream, and anything still waiting to reopen it.
  void _dropStream() {
    _reconnect?.cancel();
    _setAgentTyping(false);
    // Not awaited — see `_generation`. The stream is already disowned by the
    // bump, so whether the socket takes a moment or an age to go is nobody's
    // problem but the operating system's.
    _generation++;
    unawaited(_streamSub?.cancel());
    _streamSub = null;
  }

  Future<void> _endSession() async {
    _dropStream();
    _token = null;
    _attempt = 0;
    _missed = false;
    _viewingBeat?.cancel();
    _viewingBeat = null;
    // The next person to open this chat is not the last one.
    _visitorName = null;
    _identity = null;
    _lastIdentity = null;
    await _store.delete(_tokenKey());
  }

  void _setMessages(List<NestMessage> next) {
    _messages
      ..clear()
      ..addAll(next);
    if (!_messagesController.isClosed) _messagesController.add(messages);
  }

  void _setAgentTyping(bool next) {
    _typingFor?.cancel();
    if (next) _typingFor = Timer(typingLifetime, () => _setAgentTyping(false));
    if (next == _agentTyping) return;
    _agentTyping = next;
    if (!_typingController.isClosed) _typingController.add(next);
  }

  void _setClosed(bool next) {
    if (next == _closed) return;
    _closed = next;
    if (!_closedController.isClosed) _closedController.add(next);
  }

  void _setUnread(int next) {
    if (next == _unread) return;
    _unread = next;
    if (!_unreadController.isClosed) _unreadController.add(next);
  }

  /// A URL that loads one attachment, for an image widget.
  Uri? attachmentUrl(NestAttachment attachment) {
    final token = _token;
    return token == null ? null : _transport.mediaUrl(attachment.id, token);
  }

  /// Let go of the network. The session itself survives in storage.
  ///
  /// The socket is torn down before anything is awaited. Cancelling a
  /// subscription whose response the server is still holding open waits for the
  /// server, and closing a chat must never be able to hang the app that closed
  /// it — a customer tapping the X wants the sheet gone, not a spinner.
  Future<void> dispose() async {
    _reconnect?.cancel();
    _viewingBeat?.cancel();
    _typingFor?.cancel();
    _generation++;
    _transport.close();
    unawaited(_streamSub?.cancel());
    _streamSub = null;
    await _messagesController.close();
    await _unreadController.close();
    await _closedController.close();
    await _typingController.close();
  }
}
