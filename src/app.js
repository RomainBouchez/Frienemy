import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { createStore, ValidationError } from './store.js';
import { createAdminAuth } from './admin-auth.js';
import { Game, GameError } from './game.js';
import { ROSTER } from './players.js';
import { createGuestStore } from './guests.js';
import { lanOrigin } from './lan.js';

// Messages of these errors are user-facing (French) and may reach a socket ack.
const USER_FACING_ERRORS = [GameError, ValidationError];

const HOST_ONLY_REASON = "Seul l'hôte peut faire ça";
const PROPOSAL_LOBBY_REASON = 'Les propositions se font dans le salon';
const PROPOSAL_VALIDATION_LOBBY_REASON = 'Les propositions se valident dans le salon';
const PROPOSAL_NOT_FOUND_REASON = 'Proposition introuvable';
const ACCESS_CLOSED_REASON = "La session n'est pas encore ouverte";

const PROJECT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const DEFAULT_DATA_DIR = path.join(PROJECT_DIR, 'data');
// QR code library (UMD, global `qrcode` in the browser), served as-is from node_modules for « Scanne pour rejoindre ».
const QR_LIBRARY_PATH = createRequire(import.meta.url).resolve('qrcode-generator');

/** Wraps a sync admin handler so that thrown errors reach the admin error handler. */
function adminRoute(handler) {
  return (req, res, next) => {
    try {
      handler(req, res);
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Maps errors of /api/admin to JSON `{ error }` responses: body-parsing errors, then any error with
 * a 4xx `status` (ValidationError, GameError). Anything else becomes a JSON 500, never an HTML trace.
 */
function adminErrorHandler(err, _req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON invalide' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Requête trop volumineuse' });
    return;
  }
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
}

/**
 * Host view of a pending proposal (SPEC §8): the question only, never its proposer.
 * Only the fields the host needs to validate it.
 */
function proposalView(question) {
  return {
    id: question.id,
    type: question.type,
    text: question.text,
    subjects: question.subjects,
    options: [...question.options],
    polarity: question.polarity,
  };
}

/** Error message for a socket ack: GameError / ValidationError messages are user-facing, anything else is logged. */
function reasonOf(err) {
  if (USER_FACING_ERRORS.some((type) => err instanceof type)) return err.message;
  console.error(err);
  return 'Erreur serveur';
}

function ackOf(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

/** Socket handler arguments (payload, ack). An event sent without payload may carry only the ack. */
function payloadAndAck(payload, ack) {
  return typeof payload === 'function' ? [undefined, payload] : [payload, ack];
}

/**
 * Starts the HTTP + Socket.IO server.
 * @param {{ port?: number, dataDir?: string, adminPin?: string, accessOpen?: boolean }} [options]
 *   `adminPin` empty or missing: a random 6-digit PIN is generated (see `adminPinGenerated`).
 *   `accessOpen`: initial state of the access gate (SPEC §7), closed unless `true`.
 * @returns {Promise<{ url: string, port: number, adminPin: string, adminPinGenerated: boolean, close: () => Promise<void> }>}
 *   `port` is the actual bound port (useful with port 0).
 */
export async function startServer({ port = 3000, dataDir = DEFAULT_DATA_DIR, adminPin, accessOpen: initialAccess } = {}) {
  const store = createStore(dataDir);
  const guests = createGuestStore(dataDir);
  const adminAuth = createAdminAuth({ pin: adminPin });
  // Access gate (SPEC §7, §9): in memory, closed at start until the admin opens it. While closed, nobody
  // can take a name or create a guest; seats already taken still rejoin with their own token.
  let accessOpen = initialAccess === true;

  // The `state` of one viewer (SPEC §8): the game view, plus the store-backed fields.
  // `proposals` (pending proposals) goes to the host only; `you.pendingProposals` counts the viewer's own.
  // While the access is closed, a viewer without a seat only gets the waiting screen: no names, no round.
  function stateFor(playerId) {
    const base = game.stateFor(playerId);
    if (!accessOpen && playerId === null) {
      return { ...base, players: [], hostId: null, round: null, debrief: null, questionCount: 0, proposals: null, accessOpen };
    }
    const viewerIsHost = playerId !== null && base.hostId === playerId;
    return {
      ...base,
      questionCount: store.questionCount(),
      proposals: viewerIsHost ? store.listPendingProposals().map(proposalView) : null,
      you: base.you ? { ...base.you, pendingProposals: store.countPendingProposals(playerId) } : null,
      accessOpen,
    };
  }

  // Pushes the `state` to every connected socket, each with its own view (`you`, `isHost`...).
  // Called by the game on every mutation (timer end included) and after each admin mutation.
  function broadcast() {
    for (const socket of io.sockets.sockets.values()) {
      socket.emit('state', stateFor(socket.data.playerId ?? null));
    }
  }

  const game = new Game({ onChange: broadcast });
  game.setGuests(guests.list());

  function onAdminChange() {
    broadcast();
  }

  // Guest create / visibility / delete (SPEC §4, T13): the game roster follows the store, then every viewer is refreshed.
  function onGuestChange() {
    game.setGuests(guests.list());
    broadcast();
  }

  // Names already taken for a guest: the roster names and every stored guest (case-insensitive check in the store).
  function takenGuestNames() {
    return [...ROSTER.map((entry) => entry.name), ...guests.list().map((guest) => guest.name)];
  }

  const app = express();
  app.use(express.static(PUBLIC_DIR));
  app.use('/guest-avatars', express.static(path.join(dataDir, 'guest-avatars')));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // LAN address of this machine on the server's port, for the join QR code (lobby). `url` is null when
  // the machine has no LAN address: the client then shows « Adresse réseau introuvable ».
  app.get('/api/lan-url', (_req, res) => {
    res.json({ url: lanOrigin(httpServer.address().port) });
  });

  app.get('/vendor/qrcode-generator.js', (_req, res) => {
    res.type('application/javascript').sendFile(QR_LIBRARY_PATH);
  });

  // --- API admin (SPEC §9): auth first, so unauthenticated requests are never parsed ---
  app.use('/api/admin', adminAuth.middleware);
  app.use('/api/admin', express.json({ limit: '50kb' }));

  app.get('/api/admin/check', (_req, res) => {
    res.status(204).end();
  });

  app.get('/api/admin/questions', adminRoute((_req, res) => {
    res.json(store.listQuestions());
  }));

  app.post('/api/admin/questions', adminRoute((req, res) => {
    const question = store.createQuestion(req.body);
    onAdminChange();
    res.status(201).json(question);
  }));

  app.put('/api/admin/questions/:id', adminRoute((req, res) => {
    const question = store.updateQuestion(req.params.id, req.body);
    if (!question) {
      res.status(404).json({ error: 'Question introuvable' });
      return;
    }
    onAdminChange();
    res.json(question);
  }));

  // Validates a pending proposal (SPEC §9): 404 when the question is unknown or not pending.
  app.post('/api/admin/questions/:id/accept', adminRoute((req, res) => {
    if (!store.acceptProposal(req.params.id)) {
      res.status(404).json({ error: 'Proposition introuvable' });
      return;
    }
    onAdminChange();
    res.status(204).end();
  }));

  app.delete('/api/admin/questions/:id', adminRoute((req, res) => {
    if (!store.removeQuestion(req.params.id)) {
      res.status(404).json({ error: 'Question introuvable' });
      return;
    }
    onAdminChange();
    res.status(204).end();
  }));

  app.get('/api/admin/settings', adminRoute((_req, res) => {
    res.json(store.getSettings());
  }));

  app.put('/api/admin/settings', adminRoute((req, res) => {
    const settings = store.updateSettings(req.body);
    onAdminChange();
    res.json(settings);
  }));

  app.get('/api/admin/players', adminRoute((_req, res) => {
    res.json({ ...game.adminPlayers(), accessOpen });
  }));

  // Access gate (SPEC §9): opens or closes the « Qui es-tu ? » screen for newcomers.
  app.post('/api/admin/access', adminRoute((req, res) => {
    const open = req.body?.open;
    if (typeof open !== 'boolean') {
      res.status(400).json({ error: 'Le champ open doit être un booléen' });
      return;
    }
    accessOpen = open;
    onAdminChange();
    res.status(204).end();
  }));

  app.post('/api/admin/players/:id/kick', adminRoute((req, res) => {
    const result = game.kick(req.params.id);
    if (!result) {
      res.status(404).json({ error: 'Joueur introuvable' });
      return;
    }
    // The socket stays open (no disconnect) so the client can show the name picker again.
    const kicked = result.socketId ? io.sockets.sockets.get(result.socketId) : undefined;
    if (kicked) {
      kicked.data.playerId = null;
      kicked.emit('kicked');
    }
    res.status(204).end();
  }));

  app.post('/api/admin/players/:id/host', adminRoute((req, res) => {
    game.setHost(req.params.id);
    res.status(204).end();
  }));

  // Guests (SPEC §9, T13): list, show/hide, delete. Delete refuses a seated guest (409).
  app.get('/api/admin/guests', adminRoute((_req, res) => {
    res.json(guests.list().map(({ id, name, avatar, visible, createdAt }) => ({ id, name, avatar, visible, createdAt })));
  }));

  app.post('/api/admin/guests/:id/visible', adminRoute((req, res) => {
    const visible = req.body?.visible;
    if (typeof visible !== 'boolean') {
      res.status(400).json({ error: 'Le champ visible doit être un booléen' });
      return;
    }
    if (!guests.setVisible(req.params.id, visible)) {
      res.status(404).json({ error: 'Invité introuvable' });
      return;
    }
    onGuestChange();
    res.status(204).end();
  }));

  app.delete('/api/admin/guests/:id', adminRoute((req, res) => {
    if (!guests.get(req.params.id)) {
      res.status(404).json({ error: 'Invité introuvable' });
      return;
    }
    if (game.hasSeat(req.params.id)) {
      res.status(409).json({ error: 'Invité en jeu' });
      return;
    }
    guests.remove(req.params.id);
    onGuestChange();
    res.status(204).end();
  }));

  app.post('/api/admin/game/reveal', adminRoute((_req, res) => {
    game.reveal();
    res.status(204).end();
  }));

  app.post('/api/admin/game/next', adminRoute((_req, res) => {
    game.next();
    res.status(204).end();
  }));

  app.post('/api/admin/game/reset', adminRoute((_req, res) => {
    game.reset();
    res.status(204).end();
  }));

  app.use('/api/admin', (_req, res) => res.status(404).json({ error: 'Route introuvable' }));
  app.use('/api/admin', adminErrorHandler);

  const httpServer = http.createServer(app);
  // maxHttpBufferSize: a guest photo (≤ 300 KB decoded, ~410 KB as base64) fits in one `guest:create` event.
  const io = new Server(httpServer, { pingInterval: 10000, pingTimeout: 5000, maxHttpBufferSize: 1e6 });

  // --- Socket.IO (SPEC §8). Identity comes only from socket.data.playerId, never from the payload. ---
  function isHost(socket) {
    const playerId = socket.data.playerId ?? null;
    return playerId !== null && game.hostId === playerId;
  }

  // Host-only action: checks the role, runs `run`, then acks.
  function hostAction(socket, event, run) {
    socket.on(event, (ack) => {
      const reply = ackOf(ack);
      if (!isHost(socket)) {
        reply({ ok: false, reason: HOST_ONLY_REASON });
        return;
      }
      try {
        run();
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, reason: reasonOf(err) });
      }
    });
  }

  io.on('connection', (socket) => {
    socket.data.playerId = null;
    socket.emit('state', stateFor(null));

    socket.on('join', (payload, ack) => {
      const reply = ackOf(ack);
      const { playerId: requested, sessionToken } = payload ?? {};
      // Closed access: only a rebind of an existing seat (same token, SPEC §7 rule 2) gets through.
      if (!accessOpen && !game.isSessionOf(requested, sessionToken)) {
        reply({ ok: false, reason: ACCESS_CLOSED_REASON });
        return;
      }
      const result = game.join({ playerId: requested, sessionToken });
      if ('error' in result) {
        reply({ ok: false, reason: result.error });
        return;
      }
      const previous = socket.data.playerId;
      // Set before any broadcast, so every state sent from now on carries this socket's `you`.
      socket.data.playerId = result.playerId;
      // A socket bound to another seat leaves that seat (it goes offline, answers kept).
      if (previous && previous !== result.playerId) game.handleDisconnect(socket.id);
      // bindSocket notifies (broadcast), which is the state the client receives after the join.
      const replaced = game.bindSocket(result.playerId, socket.id);
      // A previous socket of the same seat is closed; its late disconnect is ignored by the engine.
      if (replaced && replaced !== socket.id) io.sockets.sockets.get(replaced)?.disconnect(true);
      reply({ ok: true, playerId: result.playerId, sessionToken: result.sessionToken });
    });

    // Guest creation from the « Qui es-tu ? » screen (SPEC §8, T13): any connected socket, linked or not.
    // The guest is visible at once; the client then joins it like a roster player.
    socket.on('guest:create', (...args) => {
      const [payload, ack] = payloadAndAck(...args);
      const reply = ackOf(ack);
      if (!accessOpen) {
        reply({ ok: false, reason: ACCESS_CLOSED_REASON });
        return;
      }
      try {
        const guest = guests.create(payload, takenGuestNames());
        onGuestChange();
        reply({ ok: true, playerId: guest.id });
      } catch (err) {
        reply({ ok: false, reason: reasonOf(err) });
      }
    });

    socket.on('leave', (ack) => {
      const reply = ackOf(ack);
      const playerId = socket.data.playerId;
      if (!playerId) {
        reply({ ok: false, reason: "Tu n'es pas connecté" });
        return;
      }
      socket.data.playerId = null;
      game.leave(playerId);
      reply({ ok: true });
    });

    // Player proposal from the lobby (SPEC §6, T12). Identity comes from socket.data.playerId only.
    socket.on('proposal:create', (...args) => {
      const [payload, ack] = payloadAndAck(...args);
      const reply = ackOf(ack);
      const playerId = socket.data.playerId;
      if (!playerId) {
        reply({ ok: false, reason: "Tu n'as pas rejoint la partie" });
        return;
      }
      if (game.phase !== 'lobby') {
        reply({ ok: false, reason: PROPOSAL_LOBBY_REASON });
        return;
      }
      try {
        const question = store.createProposal(payload, playerId);
        broadcast();
        reply({ ok: true, id: question.id });
      } catch (err) {
        reply({ ok: false, reason: reasonOf(err) });
      }
    });

    // Host validates or refuses a pending proposal, in the lobby only (SPEC §8).
    function proposalDecision(event, decide) {
      socket.on(event, (...args) => {
        const [payload, ack] = payloadAndAck(...args);
        const reply = ackOf(ack);
        if (!isHost(socket)) {
          reply({ ok: false, reason: HOST_ONLY_REASON });
          return;
        }
        if (game.phase !== 'lobby') {
          reply({ ok: false, reason: PROPOSAL_VALIDATION_LOBBY_REASON });
          return;
        }
        const id = payload?.id;
        if (!decide(id)) {
          reply({ ok: false, reason: PROPOSAL_NOT_FOUND_REASON });
          return;
        }
        broadcast();
        reply({ ok: true });
      });
    }
    proposalDecision('proposal:accept', (id) => store.acceptProposal(id) !== null);
    proposalDecision('proposal:reject', (id) => store.rejectProposal(id));

    hostAction(socket, 'game:start', () => {
      game.start({ questions: store.playableQuestions(), settings: store.getSettings() });
    });
    hostAction(socket, 'round:reveal', () => game.reveal());
    hostAction(socket, 'round:advance', () => game.advance());
    hostAction(socket, 'round:next', () => game.next());
    // « La roue qui balance » (contract wheel §4): the host spins the wheel shown after the results.
    hostAction(socket, 'round:spin', () => game.spin());
    hostAction(socket, 'game:reset', () => game.reset());

    // Host edits the current question live (SPEC §6, T11). Bank first: a store validation error
    // leaves both the bank and the round untouched; the round is then edited without failing.
    socket.on('round:edit', (payload, ack) => {
      const reply = ackOf(ack);
      if (!isHost(socket)) {
        reply({ ok: false, reason: HOST_ONLY_REASON });
        return;
      }
      try {
        const edit = game.checkRoundEdit(payload);
        const existing = store.getQuestion(edit.questionId);
        if (existing) {
          store.updateQuestion(edit.questionId, { ...existing, text: edit.text, options: edit.options });
        }
        game.applyRoundEdit(edit);
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, reason: reasonOf(err) });
      }
    });

    socket.on('round:answer', (answer, ack) => {
      const reply = ackOf(ack);
      const playerId = socket.data.playerId;
      if (!playerId) {
        reply({ ok: false, reason: "Tu n'as pas rejoint la partie" });
        return;
      }
      try {
        game.answer(playerId, answer);
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, reason: reasonOf(err) });
      }
    });

    // Unvalidated selection (SPEC §6, brouillons): the engine keeps it and broadcasts nothing.
    socket.on('round:draft', (...args) => {
      const [draft, ack] = payloadAndAck(...args);
      const reply = ackOf(ack);
      const playerId = socket.data.playerId;
      if (!playerId) {
        reply({ ok: false, reason: "Tu n'as pas rejoint la partie" });
        return;
      }
      try {
        game.saveDraft(playerId, draft ?? null);
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, reason: reasonOf(err) });
      }
    });

    socket.on('disconnect', () => {
      game.handleDisconnect(socket.id);
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, '0.0.0.0', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  const boundPort = httpServer.address().port;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    adminPin: adminAuth.pin,
    adminPinGenerated: adminAuth.generated,
    close: () =>
      new Promise((resolve, reject) => {
        // Cancel the pending round timer first, then io.close() disconnects all sockets,
        // closes the engine, and closes httpServer.
        game.dispose();
        io.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
