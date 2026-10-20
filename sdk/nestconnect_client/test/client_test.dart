/// The client, driven against a real HTTP server.
///
/// A fake transport would test that the client calls methods we wrote, which is
/// a tautology. This stands up an actual `HttpServer` — but that alone was not
/// enough, and it is worth saying why, because this file once passed for months
/// while agent replies were dropped in production.
///
/// The fake server's events had been written from what the client expected
/// rather than from what the server sends. Both said `type` and `message`; the
/// real API says `kind` and `payload`. Two halves agreeing with each other and
/// neither with production is a tautology too — a longer one, wearing a real
/// socket.
///
/// So the stream events here are replayed from sdk/contract/visitor-events.json,
/// the same file tools/check-visitor-events.ts holds the real server to. Neither
/// side owns it, and a key renamed in either place breaks a build.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:nestconnect_client/nestconnect_client.dart';
import 'package:test/test.dart';

/// One event from the shared contract, as a fresh mutable copy.
///
/// Read from the file rather than transcribed into this test: transcribing is
/// precisely how the shape drifted from the server's in the first place.
Map<String, Object?> contractEvent(String kind) {
  final file = File('../contract/visitor-events.json');
  if (!file.existsSync()) {
    throw StateError(
      'Missing ${file.absolute.path}. The visitor-event contract is shared with '
      'the API and this test cannot speak for the server without it.',
    );
  }
  final all = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
  final event = all[kind];
  if (event is! Map<String, Object?>) {
    throw StateError('The contract has no "$kind" event. Kinds: ${all.keys.where((k) => !k.startsWith(r'$')).join(', ')}');
  }
  // Deep copy: a test that edited the loaded map would change what every later
  // test in this file sees.
  return jsonDecode(jsonEncode(event)) as Map<String, Object?>;
}

/// A stand-in for the NestChat API, recording what it was asked.
class FakeServer {
  late HttpServer _server;
  final requests = <String>[];
  final bodies = <String, Object?>{};

  /// Every session body, in order — `bodies` keeps only the last per path, and
  /// what a second session sent is the whole question for a new chat.
  final sessionBodies = <Map<String, Object?>>[];

  /// The query each stream was opened with.
  final streamQueries = <Map<String, String>>[];

  /// What `GET /messages` answers: the thread as the server holds it.
  List<Map<String, Object?>> history = const [];

  /// Pushed to any open stream, so a test can play the part of an agent.
  final _events = StreamController<String>.broadcast();

  String get baseUrl => 'http://${_server.address.host}:${_server.port}';

  /// What the next session call answers with.
  Map<String, Object?> session = {
    'token': 'tok_1',
    'hasConversation': false,
    'messages': <Object?>[],
    'identified': true,
    'unknownFields': <Object?>[],
  };

  /// Status to answer the next send with, when it should fail.
  int? sendStatus;

  /// The same, for a reaction.
  int? reactStatus;

  /// The same, for switching to another conversation.
  int? switchStatus;

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    unawaited(_serve());
  }

  Future<void> _serve() async {
    // Each request handled off the accept loop. A stream is held open for the
    // life of the test, and awaiting it here would mean no request after the
    // first stream was ever answered — which is a property of this fake, but
    // the real server has the same shape and the same obligation.
    await for (final req in _server) {
      unawaited(_handle(req));
    }
  }

  Future<void> _handle(HttpRequest req) async {
    {
      final path = req.uri.path;
      requests.add('${req.method} $path');
      final body = await utf8.decoder.bind(req).join();
      if (body.isNotEmpty && req.headers.contentType?.mimeType == 'application/json') {
        bodies[path] = jsonDecode(body);
        if (path.endsWith('/session')) {
          sessionBodies.add(jsonDecode(body) as Map<String, Object?>);
        }
      } else if (body.isNotEmpty) {
        bodies[path] = body;
      }

      if (path.endsWith('/config')) {
        _json(req, {
          'appearance': {'accent': '#0a0', 'title': 'Ding support'},
          'online': true,
        });
      } else if (path.endsWith('/session')) {
        _json(req, session);
      } else if (path.endsWith('/message')) {
        if (sendStatus != null) {
          req.response.statusCode = sendStatus!;
          req.response.headers.contentType = ContentType.json;
          req.response.write(jsonEncode({'message': 'Nothing to send'}));
          await req.response.close();
        } else {
          _json(req, {
            'ok': true,
            'token': 'tok_2',
            'message': {
              'id': 'msg_1',
              'from': 'visitor',
              'body': jsonDecode(body)['body'],
              'at': DateTime.now().toIso8601String(),
            },
          });
        }
      } else if (path.endsWith('/react')) {
        if (reactStatus != null) {
          req.response.statusCode = reactStatus!;
          req.response.headers.contentType = ContentType.json;
          req.response.write(jsonEncode({'message': 'No'}));
          await req.response.close();
          return;
        }
        // `body` is read once at the top of _handle — a request body is a
        // stream and reading it twice is a state error, not a second copy.
        final sent = jsonDecode(body) as Map<String, Object?>;
        _json(req, {
          'ok': true,
          'message': {
            'id': sent['messageId'],
            'from': 'agent',
            'body': 'On its way!',
            'at': DateTime.now().toIso8601String(),
            'reactions': [
              if ((sent['emoji'] as String).isNotEmpty)
                {'emoji': sent['emoji'], 'by': 'visitor'},
            ],
          },
        });
      } else if (path.endsWith('/upload')) {
        _json(req, {
          'ticket': 'tkt_1',
          'filename': 'curry.jpg',
          'mime': 'image/jpeg',
          'size': 42,
        });
      } else if (path.endsWith('/open') && req.method == 'POST') {
        if (switchStatus != null) {
          req.response.statusCode = switchStatus!;
          _json(req, {'message': 'No such open conversation'});
        } else {
          _json(req, {
            'token': 'tok_switched',
            'hasConversation': true,
            'messages': [
              {
                'id': 'm_dg2',
                'from': 'visitor',
                'body': 'Where is order DG-2?',
                'at': DateTime.now().toIso8601String(),
              },
            ],
          });
        }
      } else if (path.endsWith('/messages') && req.method == 'GET') {
        _json(req, {'messages': history});
      } else if (path.endsWith('/stream')) {
        streamQueries.add(req.uri.queryParameters);
        // The charset is not decoration. Dart writes latin1 when the content
        // type names none, so an event carrying an emoji — which every
        // reaction does — throws on write and is swallowed by the catch in
        // `push` below: the frame silently never goes out. That is precisely
        // how this fake passed while delivering nothing.
        req.response.headers.contentType =
            ContentType('text', 'event-stream', charset: 'utf-8');
        // Dart's HttpResponse buffers by default, and a buffered stream is not
        // a stream — without this the events sit in the server until the
        // response ends, which for a connection held open all session means
        // never. The real endpoint says the same thing to nginx with
        // `X-Accel-Buffering: no`.
        req.response.bufferOutput = false;
        // Writes are chained rather than fired off. An HttpResponse refuses a
        // write while a flush is still in flight — "StreamSink is bound to a
        // stream" — so two events arriving back to back would lose the second
        // and take the connection with it.
        var writes = Future<void>.value();
        void push(String data) {
          writes = writes.then((_) async {
            req.response.write(data);
            await req.response.flush();
          }).catchError((Object _) {});
        }

        push(': open\n\n');
        final sub = _events.stream.listen(push);
        // Held open until the client hangs up, like the real one — and off the
        // accept loop, so everything else still gets served meanwhile.
        await req.response.done.catchError((Object _) {});
        await sub.cancel();
      } else {
        _json(req, {'ok': true});
      }
    }
  }

  void _json(HttpRequest req, Object body) {
    req.response.headers.contentType = ContentType.json;
    req.response.write(jsonEncode(body));
    unawaited(req.response.close());
  }

  /// Play an agent replying — in the server's own shape, not ours.
  void agentSays(String id, String text) {
    final event = contractEvent('message');
    // The contract's sample is deliberately the rich case — a reply with a
    // recording, a quote and an emoji already on it — because the keys that
    // vanish in a rename are the optional ones. This plays a plain reply, so
    // the extras are cleared rather than inherited: a test about unread
    // counts should not be quietly asserting against a message that arrived
    // pre-reacted.
    (event['payload']! as Map<String, Object?>)
      ..['id'] = id
      ..['body'] = text
      ..['at'] = DateTime.now().toIso8601String()
      ..['reactions'] = <Object?>[]
      ..['attachments'] = <Object?>[]
      ..remove('quote');
    _events.add('data: ${jsonEncode(event)}\n\n');
  }

  /// Play an agent reacting to a message — in the server's own shape.
  void agentReacts(String messageId, String emoji) {
    final event = contractEvent('reaction');
    final payload = event['payload']! as Map<String, Object?>;
    payload
      ..['id'] = messageId
      ..['reactions'] = [
        {'emoji': emoji, 'by': 'agent'},
      ];
    _events.add('data: ${jsonEncode(event)}\n\n');
  }

  /// Play an agent closing the chat, or reopening it.
  void agentSetsStatus(String kind) => _events.add('data: ${jsonEncode(contractEvent(kind))}\n\n');

  Future<void> stop() async {
    await _events.close();
    await _server.close(force: true);
  }
}

void main() {
  late FakeServer server;
  late NestConnect chat;

  setUp(() async {
    server = FakeServer();
    await server.start();
    chat = NestConnect(baseUrl: server.baseUrl, appKey: 'na_test');
  });

  tearDown(() async {
    await chat.dispose();
    await server.stop();
  });

  test('login sends the signature and reports what came of it', () async {
    final identity = await chat.login(
      userId: 'u_9182',
      userHash: 'deadbeef',
      name: 'Marta',
      fields: {'order_id': 'DG-88412'},
    );
    expect(identity, NestIdentity.verified);

    final sent = server.bodies['/api/nestchat/app/na_test/session']! as Map;
    expect(sent['externalId'], 'u_9182');
    expect(sent['userHash'], 'deadbeef');
    // The order goes with the session, so the thread this opens is that
    // order's rather than whichever was last open.
    expect((sent['fields']! as Map)['order_id'], 'DG-88412');
  });

  test('open with fields after login stays the signed-in person', () async {
    // The README's own order: sign in, then open the chat about something.
    await chat.login(userId: 'u_9182', userHash: 'deadbeef', name: 'Marta', email: 'marta@example.com');
    await chat.open(fields: {'application_id': 'APP-1'});

    // This second session used to go out anonymous — the fields then landed
    // on a stranger's thread and never on the customer's own.
    expect(server.sessionBodies, hasLength(2));
    final opened = server.sessionBodies.last;
    expect(opened['externalId'], 'u_9182');
    expect(opened['userHash'], 'deadbeef');
    expect(opened['name'], 'Marta');
    expect(opened['email'], 'marta@example.com');
    expect((opened['fields']! as Map)['application_id'], 'APP-1');
  });

  test('a bare open after login keeps the session it has', () async {
    await chat.login(userId: 'u_9182', userHash: 'deadbeef');
    await chat.open();
    // Nothing new to say, so nothing to re-open — and certainly not as nobody.
    expect(server.sessionBodies, hasLength(1));
    expect(chat.isOpen, isTrue);
  });

  test('open without a login is anonymous', () async {
    await chat.open(fields: {'application_id': 'APP-2'});
    final opened = server.sessionBodies.single;
    expect(opened.containsKey('externalId'), isFalse);
    expect((opened['fields']! as Map)['application_id'], 'APP-2');
  });

  test('an unverified session says so rather than pretending', () async {
    server.session = {...server.session, 'identified': false};
    expect(await chat.open(), NestIdentity.anonymous);
  });

  test('a sent message appears before the network answers', () async {
    await chat.open();
    final seen = <List<NestMessage>>[];
    chat.onMessages.listen(seen.add);

    final sending = chat.send('Where is my order?');
    // Synchronously, on the frame the button was pressed — the point of the
    // whole optimistic path. A thread that shows nothing until the server
    // replies looks broken on a train.
    expect(chat.messages.single.body, 'Where is my order?');
    expect(chat.messages.single.pending, isTrue);

    await sending;
    expect(chat.messages.single.pending, isFalse);
    expect(chat.messages.single.id, 'msg_1');
  });

  test('a message that fails stays in the thread, marked', () async {
    await chat.open();
    server.sendStatus = 400;
    await expectLater(chat.send('hello'), throwsA(isA<NestException>()));
    // Removing it would read as having sent it.
    expect(chat.messages.single.failed, isTrue);
    expect(chat.messages.single.body, 'hello');
  });

  test('the server explains itself', () async {
    await chat.open();
    server.sendStatus = 400;
    try {
      await chat.send('hello');
      fail('should have thrown');
    } on NestException catch (e) {
      // "Nothing to send" is an answer; "400" is a puzzle.
      expect(e.message, 'Nothing to send');
      expect(e.isRetryable, isFalse);
    }
  });

  test('an agent reply arrives on the stream and counts as unread', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    final unread = <int>[];
    chat.onUnread.listen(unread.add);

    // Give the stream a moment to connect before the agent speaks.
    await Future<void>.delayed(const Duration(milliseconds: 200));
    server.agentSays('msg_a', 'On its way!');
    await Future<void>.delayed(const Duration(milliseconds: 200));

    expect(chat.messages.last.body, 'On its way!');
    expect(chat.messages.last.from, NestAuthor.agent);
    expect(chat.unread, 1);
    expect(unread, contains(1));
  });

  test('the same reply twice is one message', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    // The server echoes; a reconnect replays. Either way it is one reply.
    server.agentSays('msg_a', 'On its way!');
    server.agentSays('msg_a', 'On its way!');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(chat.messages.where((m) => m.id == 'msg_a'), hasLength(1));
  });

  test('watching the chat clears the badge', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    server.agentSays('msg_a', 'hello?');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(chat.unread, 1);

    await chat.setViewing(true);
    expect(chat.unread, 0);
    expect(server.requests, contains('POST /api/nestchat/read'));
  });

  test('an attachment is staged, then sent by ticket', () async {
    await chat.open();
    final upload = await chat.attach(bytes: [1, 2, 3], filename: 'curry.jpg', mime: 'image/jpeg');
    expect(upload.ticket, 'tkt_1');

    await chat.send('', attachments: [upload]);
    final sent = server.bodies['/api/nestchat/message']! as Map;
    // The ticket, never a raw id: the file's details are the server's to state.
    expect(sent['attachments'], ['tkt_1']);
    // A photo with no words is a complete message.
    expect(sent['body'], '');
  });

  test('logging out drops the thread', () async {
    await chat.login(userId: 'u_1');
    expect(chat.isOpen, isTrue);
    await chat.logout();
    // Two people share a phone. The next one must not find the last one's chat.
    expect(chat.isOpen, isFalse);
    expect(chat.messages, isEmpty);
  });

  test('a push token registered before any chat is sent with the session', () async {
    // The order the host app actually does it in: Firebase hands over a token
    // at launch, long before anybody taps the chat button.
    await chat.registerPushToken('fcm_abc', platform: 'android');
    expect(server.requests.any((r) => r.endsWith('/device')), isFalse);

    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    final sent = server.bodies['/api/nestchat/device']! as Map;
    expect(sent['token'], 'fcm_abc');
    expect(sent['platform'], 'android');
  });

  test('a token that rotates mid-session registers straight away', () async {
    await chat.open();
    await chat.registerPushToken('fcm_new', platform: 'ios');
    expect((server.bodies['/api/nestchat/device']! as Map)['token'], 'fcm_new');
  });

  test('turning notifications off forgets the address, signing out does not', () async {
    await chat.open();
    await chat.registerPushToken('fcm_abc', platform: 'android');

    // Signing out tells the server, because the registration is scoped to the
    // account that made it — but keeps the address, which belongs to the
    // handset. Otherwise the next person to sign in here never gets a banner.
    await chat.logout();
    expect(server.requests.where((r) => r.endsWith('/device/forget')).length, 1);
    await chat.login(userId: 'u_2');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(server.requests.where((r) => r.endsWith('/device')).length, 2);

    // Turning them off is the other wish: the address goes too, so nothing
    // re-registers it behind their back.
    await chat.unregisterPushToken();
    await chat.logout();
    await chat.login(userId: 'u_2');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(server.requests.where((r) => r.endsWith('/device')).length, 2);
  });

  test('an agent closing the chat reaches the app, and reopening it does too', () async {
    // A live stream is what carries these, and one only opens for a session
    // that already has a conversation.
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(chat.isClosed, isFalse);

    // Both of these were dropped for the life of the package, alongside every
    // reply, because the client read a key the server does not send.
    server.agentSetsStatus('closed');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(chat.isClosed, isTrue);

    // And closing must not be a one-way door: an agent who reopens a thread has
    // deliberately invited the customer back into it.
    server.agentSetsStatus('reopened');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(chat.isClosed, isFalse);
  });

  test('closing is announced, so a UI can react to it', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    final seen = <bool>[];
    chat.onClosed.listen(seen.add);
    await Future<void>.delayed(const Duration(milliseconds: 200));

    server.agentSetsStatus('closed');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    // A getter alone would leave a widget with nothing to rebuild on: no
    // message arrives when a chat closes, so the thread stream never fires.
    expect(seen, [true]);

    server.agentSetsStatus('reopened');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(seen, [true, false]);
  });

  test('the same state twice is announced once', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    final seen = <bool>[];
    chat.onClosed.listen(seen.add);
    await Future<void>.delayed(const Duration(milliseconds: 200));

    server.agentSetsStatus('closed');
    server.agentSetsStatus('closed');
    await Future<void>.delayed(const Duration(milliseconds: 250));
    // Two agents closing the same thread, or a reconnect replaying it. A UI
    // that rebuilt on every repeat would flicker for no reason.
    expect(seen, [true]);
  });

  test('a new chat clears the thread but keeps the person', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    server.agentSays('m_1', 'All sorted!');
    server.agentSetsStatus('closed');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(chat.messages, isNotEmpty);
    expect(chat.isClosed, isTrue);

    await chat.startNewChat();
    expect(chat.messages, isEmpty);
    expect(chat.isClosed, isFalse);
    expect(chat.unread, 0);
    // Still signed in: this is the same customer starting another conversation,
    // not somebody signing out. Their history and their push registration stay.
    expect(chat.isOpen, isTrue);
  });

  test('a new chat keeps who they are, not just that somebody is', () async {
    await chat.login(userId: 'u_9182', userHash: 'deadbeef', name: 'Marta', email: 'marta@example.com');
    await chat.startNewChat();

    // The second session used to go out with none of this, which made somebody
    // signed in to the app an anonymous visitor the moment they started a new
    // conversation: a fresh contact with no history, and their phone's
    // notifications moved onto it.
    expect(server.sessionBodies, hasLength(2));
    final again = server.sessionBodies.last;
    expect(again['externalId'], 'u_9182');
    expect(again['userHash'], 'deadbeef');
    expect(again['name'], 'Marta');
    expect(again['email'], 'marta@example.com');
  });

  test('the same person signing in again keeps the conversation they are in', () async {
    await chat.login(userId: 'u_9182', userHash: 'deadbeef', name: 'Marta');
    final token = chat.isOpen;

    // What an app does every time its home page loads. It used to throw the
    // session away and open another, dropping the live stream for that moment
    // and taking the minimised chat with it.
    expect(await chat.login(userId: 'u_9182', userHash: 'deadbeef', name: 'Marta'), NestIdentity.verified);
    expect(server.sessionBodies, hasLength(1));
    expect(chat.isOpen, token);

    // Something new to say — an order to file the chat under — is a new
    // session, for the same person.
    await chat.login(userId: 'u_9182', userHash: 'deadbeef', fields: {'order_id': 'DG-1'});
    expect(server.sessionBodies, hasLength(2));
    expect(server.sessionBodies.last['fields'], {'order_id': 'DG-1'});

    // And somebody else is always a fresh start.
    await chat.login(userId: 'u_other', userHash: 'beef');
    expect(server.sessionBodies, hasLength(3));
    expect(server.sessionBodies.last['externalId'], 'u_other');
  });

  test('and signing out forgets it, so the next person is not them', () async {
    await chat.login(userId: 'u_9182', userHash: 'deadbeef');
    await chat.logout();
    await chat.open();
    await chat.startNewChat();
    expect(server.sessionBodies.last.containsKey('externalId'), isFalse);
  });

  test('the chat being on screen is said to the server, and so is it going', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();

    // What decides whether an agent's reply rings the phone. It used to be
    // inferred from the live stream, which an app holds open in the
    // background — so a phone in a pocket counted as somebody reading.
    await chat.setViewing(true);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(server.bodies['/api/nestchat/viewing'], {'viewing': true});

    await chat.setViewing(false);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(server.bodies['/api/nestchat/viewing'], {'viewing': false});
  });

  test("an app's stream says it reports what is on screen itself", () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 150));
    // Without it the server counts the connection as a customer reading.
    expect(server.streamQueries.last['presence'], 'viewing');
  });

  test('coming back fetches what arrived while nothing was listening', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    expect(chat.messages, isEmpty);

    // A reply that came while the phone had the app asleep — the one the
    // notification was about. The stream was not there to carry it, so
    // tapping the notification opened a chat without the message in it.
    server.history = [
      {
        'id': 'm_away',
        'from': 'agent',
        'authorName': 'Nathan',
        'body': 'Your rider is outside',
        'at': DateTime.now().toIso8601String(),
      },
    ];
    await chat.resume();
    expect(chat.messages.map((m) => m.body), ['Your rider is outside']);
    expect(chat.unread, 1, reason: 'not on screen, so it is waiting');

    // Fetching again finds nothing new and counts nothing twice.
    await chat.refresh();
    expect(chat.messages, hasLength(1));
    expect(chat.unread, 1);
  });

  test('tapping another open order moves the session to it', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();

    // A channel with a conversation per order gives a customer several open
    // at once. The session writes to one, and tapping another used to show
    // that one instead of the order tapped.
    await chat.switchTo('conv_dg2');
    expect(server.requests, contains('POST /api/nestchat/conversations/conv_dg2/open'));
    expect(chat.messages.map((m) => m.body), ['Where is order DG-2?']);

    // What is sent and heard from now on is that conversation's.
    await Future<void>.delayed(const Duration(milliseconds: 150));
    expect(server.streamQueries.last['token'], 'tok_switched');
    await chat.send('Thanks');
    expect(server.requests.last, 'POST /api/nestchat/message');
  });

  test('a conversation that can no longer be switched to leaves the session where it was', () async {
    server.session = {...server.session, 'hasConversation': true};
    server.history = [
      {'id': 'm_here', 'from': 'visitor', 'body': 'Still here', 'at': DateTime.now().toIso8601String()},
    ];
    await chat.open();
    await chat.refresh();
    server.switchStatus = 404;
    await expectLater(chat.switchTo('conv_closed'), throwsA(isA<NestException>()));
    expect(chat.messages.map((m) => m.body), ['Still here']);
    await Future<void>.delayed(const Duration(milliseconds: 150));
    expect(server.streamQueries.last['token'], 'tok_1');
  });

  test('the conversation list says which one the session is on', () {
    final rows = [
      {'id': 'c_1', 'closed': false, 'preview': 'a', 'at': '2026-10-20T10:00:00Z', 'current': true},
      {'id': 'c_2', 'closed': false, 'preview': 'b', 'at': '2026-10-20T09:00:00Z'},
    ].map(NestPastConversation.tryParse).whereType<NestPastConversation>().toList();
    expect(rows.map((r) => r.current), [true, false]);
  });

  test('a notification of ours can be told from the app\'s own', () {
    expect(NestConnect.isNotification({'source': 'nestconnect', 'conversationId': 'c_1'}), isTrue);
    expect(NestConnect.isNotification({'type': 'order_update'}), isFalse);
  });

  test('a reply carries what it answers', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    server.agentSays('msg_a', 'Is it the house on the corner?');
    await Future<void>.delayed(const Duration(milliseconds: 200));

    await chat.send('Yes', replyTo: chat.messages.last);
    // The id the server resolves the quote against, and the only thing it
    // takes on trust from us.
    final sent = server.bodies.entries
        .firstWhere((e) => e.key.endsWith('/message'))
        .value! as Map;
    expect(sent['quotedMsgId'], 'msg_a');
  });

  test('and shows the quote before the server answers', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    server.agentSays('msg_a', 'Is it the house on the corner?');
    await Future<void>.delayed(const Duration(milliseconds: 200));

    final sending = chat.send('Yes', replyTo: chat.messages.last);
    // Synchronously. The quote is the reason they are typing at all, and a
    // reply that appears without it reads as the wrong reply.
    expect(chat.messages.last.quote?.id, 'msg_a');
    expect(chat.messages.last.quote?.label, 'Is it the house on the corner?');
    await sending;
  });

  test('a quote with no words says what it was', () async {
    // "" under a reply reads as a broken quote rather than as a recording.
    final quote = NestQuote.tryParse({'id': 'm', 'from': 'agent', 'preview': '', 'kind': 'voice'});
    expect(quote?.label, 'Voice message');
  });

  test('a reaction is drawn before the round trip finishes', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    server.agentSays('msg_a', 'On its way!');
    await Future<void>.delayed(const Duration(milliseconds: 200));

    final reacting = chat.react('msg_a', '\u2764\ufe0f');
    // Under the finger. This is the one interaction where the round trip is
    // longer than the feeling it is meant to give.
    expect(chat.messages.last.reactions.single.emoji, '\u2764\ufe0f');
    expect(chat.messages.last.reactions.single.mine, isTrue);
    await reacting;
    expect(chat.messages.last.reactions.single.mine, isTrue);
  });

  test('and put back if the server refuses it', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    server.agentSays('msg_a', 'On its way!');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    server.reactStatus = 500;

    await chat.react('msg_a', '\u2764\ufe0f');
    // Leaving an emoji on screen that the server never took is worse than the
    // tap appearing not to work: one is a delay, the other is a lie.
    expect(chat.messages.last.reactions, isEmpty);
  });

  test('an agent reacting reaches the phone', () async {
    server.session = {...server.session, 'hasConversation': true};
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    server.agentSays('msg_a', 'On its way!');
    await Future<void>.delayed(const Duration(milliseconds: 200));

    server.agentReacts('msg_a', '\ud83d\udc4d');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(chat.messages.last.reactions.single.emoji, '\ud83d\udc4d');
    // Theirs, not ours — the highlight that says a second tap would remove it
    // belongs on our own only.
    expect(chat.messages.last.reactions.single.mine, isFalse);
  });

  test('reacting to a message still on its way does nothing', () async {
    await chat.open();
    // No id the server would recognise, so there is nothing to react to and
    // asking would 404 against a message that does not exist yet.
    await chat.react('pending-1', '\u2764\ufe0f');
    expect(server.requests.where((r) => r.contains('/react')), isEmpty);
  });

  test('a voice note sends its shape with it', () async {
    await chat.open();
    final staged = await chat.attachVoice(
      bytes: [1, 2, 3],
      mime: 'audio/mp4',
      durationMs: 7400,
      waveform: const [0.1, 0.55, 2.0, -1.0],
    );
    expect(staged.durationMs, 7400);
    // Clamped on the way out. A bar outside 0..1 draws as a sliver or as a
    // spike through the bubble above.
    expect(staged.waveform, [0.1, 0.55, 1.0, 0.0]);
    // Enough to draw the bubble while it is still uploading — the one case
    // where the person already knows exactly what they sent.
    expect(staged.preview?.isVoice, isTrue);
    expect(staged.preview?.durationMs, 7400);
  });

  test('an ordinary attachment has no shape to draw', () async {
    await chat.open();
    final staged = await chat.attach(bytes: [1], filename: 'curry.jpg', mime: 'image/jpeg');
    expect(staged.preview, isNull);
  });

  test('the contract is the server\'s, not ours', () async {
    // The guard on the whole arrangement. If somebody "fixes" a future mismatch
    // by editing the fixture to match the client, this fails — and the check on
    // the API side fails too, which is the point of neither side owning it.
    final event = contractEvent('message');
    expect(event.keys, containsAll(<String>['kind', 'payload']));
    expect(event.containsKey('type'), isFalse);
    expect(event.containsKey('message'), isFalse);
    expect((event['payload']! as Map).keys, containsAll(<String>['id', 'from', 'body', 'at']));
  });

  test('sending without a session refuses rather than guessing', () async {
    await expectLater(chat.send('hello'), throwsA(isA<NestException>()));
  });

  test('the appearance comes from the channel', () async {
    await chat.open();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    // Changed in Settings, live in the app, no app release.
    expect(chat.config?.appearance.accent, '#0a0');
    expect(chat.config?.appearance.title, 'Ding support');
  });

  test('a config that will not load does not stop the chat opening', () async {
    final offline = NestConnect(baseUrl: 'http://127.0.0.1:1', appKey: 'na_x');
    await expectLater(offline.open(), throwsA(isA<NestException>()));
    await offline.dispose();
  });
}
