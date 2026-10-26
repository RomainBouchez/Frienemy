// Player screens (SPEC §7, §8, §10). The server is authoritative: this module only renders the last
// `state` it received and sends intentions. Screens are chosen by `state.you` and `state.phase`.
import { loadSession, saveSession, clearSession } from './session.js';
import { el, avatar, TYPE_LABELS } from './ui.js';
import {
  createAnswerWidget,
  buildAnswer,
  draftFor,
  clearDrafts,
  partialAnswer,
  selectedStaticItems,
} from './widgets.js';
import { resultsBody, targetPortrait, whichAnswerNode } from './results-view.js';
import { createProposalWizard, hostProposals, proposeRow } from './proposal-view.js';
import { createGuestForm, guestTile } from './guest-view.js';
import { createWheelView } from './wheel-view.js';
import { createJoinQr } from './join-qr.js';
import {
  anecdoteAnswer,
  anecdoteDraft,
  anecdoteReadCard,
  clearAnecdoteDrafts,
  createMatchWidget,
  createWriteWidget,
} from './anecdote-view.js';

const appEl = document.getElementById('app');
const bannerEl = document.getElementById('banner');

const MSG_OFFLINE = 'Pas de connexion pour le moment, réessaie dans un instant.';
const MSG_GENERIC = 'Une erreur est survenue, réessaie.';
const MSG_KICKED = 'Tu as été exclu de la partie';
const MSG_RESET_CONFIRM = 'Arrêter la partie et revenir au salon ?';
const MSG_EDITED = "Question modifiée par l'hôte";
const TOAST_MS = 3000;

const socket = io({ reconnectionDelay: 1000, reconnectionDelayMax: 5000 });

/** Last `state` received from the server. */
let lastState = null;
/**
 * Host's in-progress edit of the current question (SPEC §8 `round:edit`): { index, questionId, text,
 * options, error, pending }. `options` is null when the question has no custom options. Module state,
 * so a `state` re-render keeps what the host typed. Dropped when the round changes or the host changes.
 */
let editDraft = null;
/** Field to focus after the next render: { field, start, end }, set when the edit form opens. */
let editFocus = null;
/** Brief non-blocking notice for the players (« Question modifiée par l'hôte »), 3 s. */
const toastEl = el('div', { class: 'toast', role: 'status', hidden: true });
let toastTimer = 0;
/** True from a `join` emit until its ack: the picker must not be rendered meanwhile. */
let joinPending = false;
/** Message shown on the name picker (kicked, join refused). */
let pickerMessage = null;
/** Inline error of the current screen (ack errors of host actions and answers). */
let actionError = null;
/** Identifies the screen being shown; a change resets the inline error and the submit state. */
let screenKey = null;
/**
 * What changed with the last `state` (new answers, new seats, a seat gone offline, the viewer's own answer).
 * Set by the `state` handler, read by the next render only, so each change pops once (no replay on an
 * unrelated re-render). `currentFresh` is the copy used by the render in progress.
 */
const NO_FRESH = Object.freeze({ answered: new Set(), seats: new Set(), away: new Set(), sent: false });
let fresh = null;
let currentFresh = NO_FRESH;
/** True between sending `round:answer` and its ack. */
let submitting = false;
/** « Valider » button of the question screen, refreshed without re-rendering. */
let submitButton = null;
/** Ids of the proposals whose « Ajouter » / « Refuser » is in flight (SPEC T12). */
const proposalBusy = new Set();
/** « Proposer une question » overlay (lobby, SPEC T12). Outside #app: survives every re-render. */
const proposalWizard = createProposalWizard(act);
/** « Ajouter un invité » form (SPEC T13). Outside #app: survives every re-render. */
const guestForm = createGuestForm(act, (playerId) => pickName(playerId));
/** « La roue qui balance » overlay (results, SPEC contract wheel). Outside #app: survives every re-render. */
const wheelView = createWheelView(act);
/** « Scanne pour rejoindre » (lobby, every player): the join QR code card. The address arrives later, then re-renders. */
const joinQr = createJoinQr(() => render());

// Timer bar: the deadline is computed locally from `remainingMs` at each state; only the bar is
// updated, per animation frame. Never re-render the screen for a tick.
let timerBar = null;
let timerDeadline = 0;
let timerDuration = 0;
let timerFrame = 0;

/**
 * Emits an intention and calls `onResult` with the ack (`{ ok, reason? }`). `payload` null means no
 * payload. Refuses to emit while disconnected, so no action is buffered for a later reconnection.
 */
function act(event, payload, onResult) {
  const finish = (res) => onResult(res ?? { ok: false, reason: MSG_GENERIC });
  if (!socket.connected) {
    finish({ ok: false, reason: MSG_OFFLINE });
    return;
  }
  if (payload === null) socket.emit(event, finish);
  else socket.emit(event, payload, finish);
}

function setActionError(message) {
  actionError = message;
  render();
}

function errorNode() {
  return actionError ? el('p', { class: 'error', role: 'alert' }, actionError) : null;
}

function showBanner(text, withResume) {
  const children = [el('span', null, text)];
  if (withResume) {
    children.push(
      el(
        'button',
        { type: 'button', class: 'banner__action', onclick: () => socket.connect() },
        'Reprendre ici',
      ),
    );
  }
  bannerEl.replaceChildren(...children);
  bannerEl.hidden = false;
}

function hideBanner() {
  bannerEl.hidden = true;
  bannerEl.replaceChildren();
}

function hostName(state) {
  return state.players.find((player) => player.id === state.hostId)?.name ?? null;
}

/* ---------- Join / reconnection (SPEC §7) ---------- */

function onJoinResult(res, { fromSaved }) {
  joinPending = false;
  if (res.ok) {
    saveSession({ playerId: res.playerId, sessionToken: res.sessionToken });
    pickerMessage = null;
    // A (re)join may have lost the server-side draft: send the current one again (SPEC §8 round:draft).
    resendDraft();
  } else if (lastState?.accessOpen === false) {
    // Closed access: the waiting screen says it all; a saved session is kept and sent again on opening.
    pickerMessage = null;
  } else {
    // A refused saved session is dropped; a refused name pick keeps any stored session untouched.
    if (fromSaved) clearSession();
    pickerMessage = res.reason;
  }
  render();
}

function rejoinSaved(saved) {
  joinPending = true;
  act('join', { playerId: saved.playerId, sessionToken: saved.sessionToken }, (res) =>
    onJoinResult(res, { fromSaved: true }),
  );
}

function pickName(playerId) {
  if (joinPending) return;
  joinPending = true;
  pickerMessage = null;
  act('join', { playerId }, (res) => onJoinResult(res, { fromSaved: false }));
}

/* ---------- Socket events ---------- */

socket.on('connect', () => {
  hideBanner();
  joinPending = false;
  const saved = loadSession();
  if (saved) rejoinSaved(saved);
  // Without a saved session, the `state` the server sends on connection renders the picker.
});

socket.on('disconnect', (reason) => {
  joinPending = false;
  if (reason === 'io server disconnect') {
    showBanner('Session ouverte ailleurs', true);
  } else {
    showBanner('Connexion perdue — reconnexion…', false);
  }
  // The current screen is kept; only a picker has to be refreshed so its tiles are enabled again.
  if (lastState && !lastState.you) render();
});

// Server unreachable (page opened while it is down, or during a reconnection attempt): same banner,
// so the page is never silently blank.
socket.on('connect_error', () => {
  if (socket.connected) return;
  showBanner('Connexion perdue — reconnexion…', false);
});

socket.on('kicked', () => {
  clearSession();
  joinPending = false;
  actionError = null;
  pickerMessage = MSG_KICKED;
  if (lastState) lastState = { ...lastState, you: null };
  render();
});

socket.on('state', (state) => {
  const previous = lastState;
  lastState = state;
  // The admin just opened the access: a saved session refused while it was closed is sent again.
  if (previous?.accessOpen === false && state.accessOpen && !state.you && !joinPending) {
    const saved = loadSession();
    if (saved) rejoinSaved(saved);
  }
  // While a reconnection join is pending, keep the last screen instead of flashing the picker.
  if (joinPending && state.you === null) return;
  if (state.you) pickerMessage = null;
  if (!state.round) {
    clearDrafts();
    clearAnecdoteDrafts();
  }
  notifyQuestionEdited(previous, state);
  fresh = freshFrom(previous, state);
  render();
});

/** The changes between two states, for the one-shot classes of the next render (see `fresh`). */
function freshFrom(previous, state) {
  const changes = { answered: new Set(), seats: new Set(), away: new Set(), sent: false };
  if (!previous) return changes;
  const before = previous.round;
  const now = state.round;
  // New answers only inside the same question: a new round starts with nobody answered.
  if (before && now && before.index === now.index && before.question.id === now.question.id) {
    const answeredBefore = new Set(before.answered);
    for (const id of now.answered) {
      if (!answeredBefore.has(id)) changes.answered.add(id);
    }
  }
  const statusBefore = new Map(previous.players.map((player) => [player.id, player.status]));
  for (const player of state.players) {
    const was = statusBefore.get(player.id);
    if (player.status !== 'free' && (was === undefined || was === 'free')) changes.seats.add(player.id);
    if (player.status === 'offline' && was === 'online') changes.away.add(player.id);
  }
  changes.sent = Boolean(previous.you && !previous.you.answer && state.you && state.you.answer);
  return changes;
}

/* ---------- Rendering ---------- */

function render() {
  if (!lastState) return;
  const state = lastState;
  currentFresh = fresh ?? NO_FRESH;
  fresh = null;
  proposalWizard.sync(state);
  guestForm.sync(state);
  wheelView.sync(state);
  joinQr.sync(state);
  syncEditDraft(state);
  // Keep the focus in the edit form across a re-render (a `state` may arrive while the host types).
  const focus = editFocus ?? focusedEditField();
  editFocus = null;
  // The anecdote stage is part of the key: each stage is a new screen (no stale error or submit state).
  // The read stage is also keyed by its anecdote, so each anecdote read is a new screen.
  const readKey = state.round?.stage === 'read' ? (state.round.reading?.index ?? '') : '';
  const roundKey = state.round ? `${state.round.index}:${state.round.stage ?? ''}:${readKey}` : '-';
  const key = `${state.you ? 'me' : 'out'}:${state.phase}:${roundKey}`;
  // A new screen key enters (is-entering, its CSS entry animations); a re-render of the same screen does not.
  const entering = key !== screenKey;
  if (entering) {
    screenKey = key;
    actionError = null;
    submitting = false;
  }
  timerBar = null;
  submitButton = null;

  let node;
  if (!state.you) node = state.accessOpen === false ? renderWaiting() : renderPicker(state);
  else if (state.phase === 'lobby') node = renderLobby(state);
  else if (state.phase === 'question') node = renderQuestion(state);
  else if (state.phase === 'results') node = renderResults(state);
  else node = renderEnd(state);
  if (entering) node.classList.add('is-entering');
  appEl.replaceChildren(node);
  restoreEditFocus(focus);
}

/** Shown instead of « Qui es-tu ? » until the admin opens the session (SPEC §7, access gate). */
function renderWaiting() {
  return el('section', { class: 'screen' }, [
    el('h1', { class: 'screen__title' }, 'Patience…'),
    el('p', null, "La session n'est pas encore ouverte."),
    el('p', { class: 'muted' }, "Elle commence dès que l'admin la lance : cette page s'actualise toute seule."),
    el('p', { class: 'footer' }, el('a', { href: '/admin.html' }, 'Admin')),
  ]);
}

function renderPicker(state) {
  return el('section', { class: 'screen' }, [
    el('h1', { class: 'screen__title' }, 'Qui es-tu ?'),
    el('div', { class: 'grid-3 picker' }, [
      state.players.map((player) => {
        const online = player.status === 'online';
        const offline = player.status === 'offline';
        return el(
          'button',
          {
            type: 'button',
            class: 'tile' + (online ? ' is-disabled is-online' : '') + (offline ? ' is-offline' : ''),
            disabled: online,
            onclick: (event) => {
              // A free sticker sticks to the album at once; the join is sent right after, not delayed.
              if (!online && !offline && !joinPending) event.currentTarget.classList.add('is-sticking');
              pickName(player.id);
            },
          },
          [
            avatar(player, 72),
            el('span', { class: 'tile__name' }, player.name),
            online ? el('span', { class: 'tile__meta' }, 'en ligne') : null,
            offline ? el('span', { class: 'tile__meta' }, 'hors ligne') : null,
          ],
        );
      }),
      guestTile((origin) => guestForm.open(origin)),
    ]),
    pickerMessage ? el('p', { class: 'error', role: 'alert' }, pickerMessage) : null,
    el('p', { class: 'footer' }, el('a', { href: '/admin.html' }, 'Admin')),
  ]);
}

function renderLobby(state) {
  const isHost = state.you.isHost;
  const onlineCount = state.players.filter((player) => player.status === 'online').length;
  const count = state.questionCount;
  const seats = state.players.filter((player) => player.status !== 'free');
  const host = hostName(state);
  const proposals = Array.isArray(state.proposals) ? state.proposals : [];
  let help = null;
  if (onlineCount < 2) help = 'Il faut au moins 2 joueurs';
  else if (count === 0) help = 'Aucune question active';
  const countLabel = count === 1 ? '1 question' : `${count} questions`;

  return el('section', { class: 'screen' }, [
    el('h1', { class: 'screen__title' }, "Salle d'attente"),
    el(
      'div',
      { class: 'seats' },
      seats.map((player) => {
        const classes = ['seat'];
        if (player.status === 'offline') classes.push('is-offline');
        if (currentFresh.seats.has(player.id)) classes.push('is-new');
        if (currentFresh.away.has(player.id)) classes.push('is-away');
        return el('span', { class: classes.join(' ') }, [
          avatar(player, 56),
          player.status === 'online' ? el('span', { class: 'seat__dot', 'aria-label': 'en ligne' }) : null,
          el('span', { class: 'seat__name' }, player.name),
        ]);
      }),
    ),
    host ? el('p', { class: 'muted' }, `Hôte : ${host}`) : null,
    joinQr.card(),
    isHost && proposals.length > 0
      ? hostProposals(proposals, {
          busy: proposalBusy,
          onAccept: (proposal) => decideProposal('proposal:accept', proposal),
          onReject: (proposal) => decideProposal('proposal:reject', proposal),
        })
      : null,
    isHost
      ? el('div', { class: 'stack' }, [
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--primary btn--block',
              disabled: onlineCount < 2 || count === 0,
              onclick: startGame,
            },
            `Lancer la partie (${countLabel})`,
          ),
          help ? el('p', { class: 'muted' }, help) : null,
        ])
      : el('p', { class: 'muted' }, `En attente de l'host${host ? ` (${host})` : ''}…`),
    proposeRow(state.you.pendingProposals ?? 0, (origin) => proposalWizard.open(origin)),
    errorNode(),
    isHost
      ? null
      : el('button', { type: 'button', class: 'link-btn', onclick: leave }, "Ce n'est pas moi"),
  ]);
}

/** Host accepts or refuses a pending proposal (SPEC §8 proposal:accept / proposal:reject). */
function decideProposal(event, proposal) {
  if (proposalBusy.has(proposal.id)) return;
  proposalBusy.add(proposal.id);
  act(event, { id: proposal.id }, (res) => {
    proposalBusy.delete(proposal.id);
    if (res.ok) render();
    else setActionError(res.reason);
  });
}

/**
 * « Question i/n · type », then the rounds left and one dash per round: done rounds in accent, the
 * current one outlined while it is being asked, the others grey. Built per render, never per tick.
 * Done = index during the question (not yet played), index + 1 during the results.
 */
function roundHead(round, phase) {
  const done = phase === 'results' ? round.index + 1 : round.index;
  const remaining = round.total - done;
  const afterThis = round.total - round.index - 1;
  let label;
  if (afterThis === 0) label = 'Dernière manche';
  else if (remaining === 1) label = '1 manche restante';
  else label = `${remaining} manches restantes`;

  const dashes = [];
  for (let index = 0; index < round.total; index += 1) {
    const current = phase === 'question' && index === round.index;
    dashes.push(
      el('span', {
        class: 'rounds__dash' + (index < done ? ' is-done' : '') + (current ? ' is-current' : ''),
      }),
    );
  }
  return el('div', { class: 'round-head' }, [
    el('p', { class: 'eyebrow' }, `Question ${round.index + 1}/${round.total} · ${TYPE_LABELS[round.question.type]}`),
    el('p', { class: 'muted' }, label),
    el('div', { class: 'rounds', role: 'img', 'aria-label': `${done} sur ${round.total} manches jouées` }, dashes),
  ]);
}

/** Question types played in two stages, the target answering first (« Devine sa réponse », « Quelle était la question ? »). */
function isGuessLike(type) {
  return type === 'guess' || type === 'which';
}

function renderQuestion(state) {
  if (state.round.question.type === 'anecdote') return renderAnecdoteQuestion(state);
  if (isGuessLike(state.round.question.type)) return renderGuessQuestion(state);
  const round = state.round;
  const you = state.you;
  const answered = you.answer !== null;
  const participant = you.isParticipant;

  const bar = el('div', { class: 'timer__bar' });
  timerBar = bar;
  timerDeadline = performance.now() + round.remainingMs;
  timerDuration = round.durationMs;
  ensureTimerLoop();

  let answerArea;
  if (!participant) {
    answerArea = [
      createAnswerWidget(round, { readOnly: true }).node,
      el('p', { class: 'muted' }, 'Tu joues au prochain round'),
    ];
  } else if (answered) {
    answerArea = [el('p', { class: sentClass() }, 'Réponse envoyée ✓ — en attente des autres')];
  } else {
    answerArea = [createAnswerWidget(round, { onChange: onDraftChange }).node];
  }

  const bottom = [];
  if (participant && !answered) {
    submitButton = el(
      'button',
      { type: 'button', class: 'btn btn--primary btn--block', onclick: submitAnswer },
      'Valider',
    );
    bottom.push(submitButton);
  }
  if (you.isHost) {
    bottom.push(
      el(
        'button',
        { type: 'button', class: 'btn btn--ghost btn--block', onclick: reveal },
        'Révéler maintenant',
      ),
      el('button', { type: 'button', class: 'link-btn', onclick: resetGame }, 'Arrêter la partie'),
    );
  }
  refreshSubmit();

  return el('section', { class: 'screen' }, [
    el('div', { class: 'timer' }, bar),
    roundHead(round, 'question'),
    questionTitle(state),
    answerArea,
    answeredRow(state, round),
    errorNode(),
    bottom.length > 0 ? el('div', { class: 'sticky-bottom' }, bottom) : null,
  ]);
}

/**
 * Anecdote question (SPEC §6, T9): write (textarea), read (anonymous card, host « Suivante », no timer),
 * match (cards, author chips). The theme is the question text. Spectators see the stage read-only.
 */
function renderAnecdoteQuestion(state) {
  const round = state.round;
  const you = state.you;
  const stage = round.stage;
  const participant = you.isParticipant;
  const answered = you.answer !== null;

  let timer = null;
  if (stage !== 'read') {
    const bar = el('div', { class: 'timer__bar' });
    timerBar = bar;
    timerDeadline = performance.now() + round.remainingMs;
    timerDuration = round.durationMs;
    ensureTimerLoop();
    timer = el('div', { class: 'timer' }, bar);
  }

  let body;
  if (stage === 'write') {
    if (!participant) {
      body = el('p', { class: 'muted' }, 'Tu joues au prochain round');
    } else if (answered) {
      body = el('p', { class: sentClass() }, 'Anecdote envoyée ✓ — en attente des autres');
    } else {
      body = createWriteWidget(round, { onChange: onDraftChange }).node;
    }
  } else if (stage === 'read') {
    body = anecdoteReadCard(round.reading);
  } else if (!participant) {
    body = [
      createMatchWidget(round, you, { readOnly: true }).node,
      el('p', { class: 'muted' }, 'Tu joues au prochain round'),
    ];
  } else if (answered) {
    body = el('p', { class: sentClass() }, 'Réponses envoyées ✓ — en attente des autres');
  } else {
    body = createMatchWidget(round, you, { onChange: onDraftChange }).node;
  }

  const bottom = [];
  if (stage !== 'read' && participant && !answered) {
    submitButton = el(
      'button',
      { type: 'button', class: 'btn btn--primary btn--block', onclick: submitAnswer },
      'Valider',
    );
    bottom.push(submitButton);
  }
  if (stage === 'read' && you.isHost) {
    bottom.push(el('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: advance }, 'Suivante'));
  }
  if (you.isHost) {
    bottom.push(
      el(
        'button',
        { type: 'button', class: 'btn btn--ghost btn--block', onclick: reveal },
        'Révéler maintenant',
      ),
      el('button', { type: 'button', class: 'link-btn', onclick: resetGame }, 'Arrêter la partie'),
    );
  }
  refreshSubmit();

  return el('section', { class: 'screen' }, [
    timer,
    roundHead(round, 'question'),
    questionTitle(state),
    body,
    stage === 'read' ? null : answeredRow(state, round),
    stage === 'read' && !you.isHost
      ? el('p', { class: 'muted' }, `En attente de l'host${hostName(state) ? ` (${hostName(state)})` : ''}…`)
      : null,
    errorNode(),
    bottom.length > 0 ? el('div', { class: 'sticky-bottom' }, bottom) : null,
  ]);
}

/** Who answers the current guess stage: the target in `pick`, the other participants in `guess`. */
function guessCanAnswer(state) {
  const you = state.you;
  return state.round.stage === 'pick' ? you.isTarget : !you.isTarget && you.isParticipant;
}

/**
 * « Devine sa réponse » (contract guess) and « Quelle était la question ? » (contract which, same stages).
 * Stage `pick`: the target answers in secret; the others see only her portrait and who is answering.
 * Stage `guess`: the others guess; the target sees her own pick, read-only. The timer, « Valider » and the
 * host controls are those of the other question screens.
 * The which differences: the target sees her secret question (not the theme) and her answer is shown
 * to all; the guessers see her answer on top and the variants below. Pick by a copain or a text.
 */
function renderGuessQuestion(state) {
  const round = state.round;
  const you = state.you;
  const which = round.question.type === 'which';
  const target = round.target ?? { id: null, name: '?', avatar: null, color: null };
  const pickStage = round.stage === 'pick';
  const answered = you.answer !== null;
  const canAnswer = guessCanAnswer(state);

  const bar = el('div', { class: 'timer__bar' });
  timerBar = bar;
  timerDeadline = performance.now() + round.remainingMs;
  timerDuration = round.durationMs;
  ensureTimerLoop();

  const sentLine = () => el('p', { class: sentClass() }, 'Réponse envoyée ✓ — en attente des autres');
  let intro = null;
  // The theme (questionTitle) is hidden from the others in pick; the target sees her secret question instead.
  let title = pickStage && !you.isTarget ? null : questionTitle(state);
  if (which && you.isTarget) title = el('h2', { class: 'question-text' }, you.secretQuestion ?? '');
  let body;
  if (pickStage && you.isTarget) {
    intro = el(
      'p',
      { class: 'guess-banner' },
      which
        ? "C'est toi qui réponds ! Les autres vont deviner à quelle question."
        : "C'est toi qui réponds ! Les autres vont deviner ta réponse.",
    );
    body = answered ? sentLine() : createAnswerWidget(round, { onChange: onDraftChange }).node;
  } else if (pickStage) {
    // Not the target: only who is answering. The question and the choices stay hidden.
    intro = [targetPortrait(target, false), el('p', { class: 'guess-status' }, `${target.name} répond en secret…`)];
    body = null;
  } else if (you.isTarget) {
    body = which
      ? [
          el('p', { class: 'guess-status' }, 'Les autres devinent ta question…'),
          whichAnswerNode(round.whichAnswer, state.players),
        ]
      : [
          el('p', { class: 'guess-status' }, 'Les autres devinent ta réponse…'),
          selectedStaticItems(round, you.pickAnswer?.choice ?? null),
        ];
  } else {
    intro = which
      ? [
          whichAnswerNode(round.whichAnswer, state.players),
          el('p', { class: 'guess-status' }, `${target.name} a répondu ça. À quelle question ?`),
        ]
      : [targetPortrait(target, true), el('p', { class: 'guess-status' }, `Qu'a répondu ${target.name} ?`)];
    if (!canAnswer) {
      body = [
        createAnswerWidget(round, { readOnly: true }).node,
        el('p', { class: 'muted' }, 'Tu joues au prochain round'),
      ];
    } else if (answered) {
      body = sentLine();
    } else {
      body = createAnswerWidget(round, { onChange: onDraftChange }).node;
    }
  }

  // Who the « x ont répondu » line counts: the target in pick, the guessers in guess.
  const concerned = pickStage ? [target.id] : round.participants.filter((id) => id !== target.id);

  const bottom = [];
  if (canAnswer && !answered) {
    submitButton = el(
      'button',
      { type: 'button', class: 'btn btn--primary btn--block', onclick: submitAnswer },
      'Valider',
    );
    bottom.push(submitButton);
  }
  if (you.isHost) {
    bottom.push(
      el(
        'button',
        { type: 'button', class: 'btn btn--ghost btn--block', onclick: reveal },
        'Révéler maintenant',
      ),
      el('button', { type: 'button', class: 'link-btn', onclick: resetGame }, 'Arrêter la partie'),
    );
  }
  refreshSubmit();

  return el('section', { class: 'screen' }, [
    el('div', { class: 'timer' }, bar),
    roundHead(round, 'question'),
    intro,
    title,
    body,
    answeredRow(state, round, concerned),
    errorNode(),
    bottom.length > 0 ? el('div', { class: 'sticky-bottom' }, bottom) : null,
  ]);
}

/** Class of the « envoyée » line: it pops only on the render right after the viewer's own answer. */
function sentClass() {
  return currentFresh.sent ? 'answer-sent is-new' : 'answer-sent';
}

/**
 * « x ont répondu » row with the avatars of `ids` (default: the round participants). The count is the
 * answered ones among `ids` when given, else `round.answered.length` as before.
 */
function answeredRow(state, round, ids = null) {
  const answeredIds = new Set(round.answered);
  const scope = ids ?? round.participants;
  const participants = scope.map((id) => state.players.find((player) => player.id === id)).filter(Boolean);
  const answeredCount = ids === null ? round.answered.length : ids.filter((id) => answeredIds.has(id)).length;
  return el('div', { class: 'answered' }, [
    el('p', { class: 'muted' }, `${answeredCount}/${scope.length} ont répondu`),
    el(
      'div',
      { class: 'answered__avatars' },
      participants.map((player) => {
        const done = answeredIds.has(player.id);
        const classes = ['answered__item'];
        if (done) classes.push('is-done');
        if (currentFresh.answered.has(player.id)) classes.push('is-new');
        return el('span', { class: classes.join(' ') }, [
          avatar(player, 32),
          done ? el('span', { class: 'answered__check', 'aria-hidden': 'true' }, '✓') : null,
        ]);
      }),
    ),
  ]);
}

/** « 0 votant », « 1 votant », « 2 votants ». */
function votantsLabel(count) {
  return `${count} ${count > 1 ? 'votants' : 'votant'}`;
}

function renderResults(state) {
  const round = state.round;
  const isLast = round.index + 1 >= round.total;
  const host = hostName(state);
  // Anecdote, guess and which results have no voter count: their bodies show who answered and who guessed.
  const voters = round.question.type === 'anecdote' || isGuessLike(round.question.type) ? null : round.results.voters;
  // While the wheel is on (round.wheel, its overlay on top), the wheel holds the host's controls: no bottom bar here.
  let footer = null;
  if (!round.wheel) {
    footer = state.you.isHost
      ? el(
          'div',
          { class: 'sticky-bottom' },
          el(
            'button',
            { type: 'button', class: 'btn btn--primary btn--block', onclick: nextRound },
            isLast ? 'Voir la fin' : 'Question suivante',
          ),
        )
      : el('p', { class: 'muted' }, `En attente de l'host${host ? ` (${host})` : ''}…`);
  }
  return el('section', { class: 'screen' }, [
    roundHead(round, 'results'),
    questionTitle(state),
    voters === null ? null : el('p', { class: 'muted' }, votantsLabel(voters)),
    resultsBody(round, state.players),
    errorNode(),
    footer,
  ]);
}

/**
 * One debrief card (SPEC §5 débrief): avatar(s) and name(s), the title's emoji as a sticker on the
 * photo(s), title big, phrase, stat small. With a `partnerId`, both avatars sit side by side
 * (« A & B »). The stagger is a CSS delay from `--i`.
 */
function debriefCard(entry, players, index) {
  const player = players.find((item) => item.id === entry.playerId) ?? { name: '?', avatar: null, color: null };
  const partner = entry.partnerId ? players.find((item) => item.id === entry.partnerId) : null;
  const names = partner ? `${player.name} & ${partner.name ?? '?'}` : player.name;
  const emoji = entry.emoji ? el('span', { class: 'debrief-card__emoji', 'aria-hidden': 'true' }, entry.emoji) : null;
  return el('article', { class: 'debrief-card', style: { '--i': index } }, [
    partner
      ? el('div', { class: 'debrief-card__faces' }, [avatar(player, 112), avatar(partner, 112), emoji])
      : el('div', { class: 'debrief-card__faces' }, [avatar(player, 112), emoji]),
    el('p', { class: 'debrief-card__names' }, names),
    el('p', { class: 'debrief-card__title' }, entry.title),
    el('p', { class: 'debrief-card__phrase' }, entry.phrase),
    el('p', { class: 'debrief-card__stat' }, entry.stat),
  ]);
}

/** End screen: the debrief cards when `state.debrief` is an array, the plain end screen otherwise. */
function renderEnd(state) {
  const debrief = state.debrief;
  let body = null;
  if (Array.isArray(debrief)) {
    body =
      debrief.length === 0
        ? el('p', { class: 'muted' }, 'Partie trop calme pour décerner des titres')
        : el('section', { class: 'stack' }, [
            el('h2', { class: 'debrief__heading' }, 'Le débrief'),
            debrief.map((entry, index) => debriefCard(entry, state.players, index)),
          ]);
  }
  return el('section', { class: 'screen' }, [
    el('h1', { class: 'screen__title' }, 'Partie terminée !'),
    body,
    errorNode(),
    state.you.isHost
      ? el(
          'button',
          { type: 'button', class: 'btn btn--primary btn--block', onclick: backToLobby },
          'Retour au salon',
        )
      : null,
  ]);
}

/* ---------- Question timer (rAF, width only) ---------- */

function ensureTimerLoop() {
  if (!timerFrame) timerFrame = requestAnimationFrame(tickTimer);
}

function tickTimer() {
  timerFrame = 0;
  if (!timerBar) return;
  const remaining = Math.max(0, timerDeadline - performance.now());
  const ratio = timerDuration > 0 ? Math.min(1, remaining / timerDuration) : 0;
  timerBar.style.width = `${(ratio * 100).toFixed(2)}%`;
  timerBar.classList.toggle('is-urgent', remaining < 5000);
  if (remaining > 0) timerFrame = requestAnimationFrame(tickTimer);
}

/* ---------- Answers ---------- */

/** Answer to send for the current screen (anecdote stages included), or null. */
function currentAnswer(state) {
  const round = state.round;
  if (round.question.type === 'anecdote') return anecdoteAnswer(round, state.you);
  return buildAnswer(round, draftFor(round));
}

function refreshSubmit() {
  if (!submitButton || !lastState?.round) return;
  submitButton.disabled = submitting || currentAnswer(lastState) === null;
}

/* ---------- Draft sync (round:draft, SPEC §8) ---------- */

/** Minimum gap between two draft sends; a change inside the gap is sent when the gap ends. */
const DRAFT_THROTTLE_MS = 300;
/** Timer of the pending draft send, 0 when none is scheduled. */
let draftTimer = 0;
/** Round, stage and payload last sent as a draft (JSON key), null when unknown (must be sent again). */
let lastDraftKey = null;

/** A local change of the selection: refresh « Valider » and schedule the draft send. */
function onDraftChange() {
  refreshSubmit();
  scheduleDraft();
}

function scheduleDraft() {
  if (!draftTimer) draftTimer = setTimeout(flushDraft, DRAFT_THROTTLE_MS);
}

/** Forgets what the server holds for this viewer, so the current draft is sent again on the next flush. */
function resendDraft() {
  lastDraftKey = null;
  scheduleDraft();
}

/**
 * Draft to send for the viewer (SPEC §8 round:draft payload): the complete answer when the draft is one,
 * else the partial one (ranking, tierlist, anecdote match), else null (clears the server's draft).
 */
function draftPayload(round, you) {
  if (round.question.type === 'anecdote') return anecdoteDraft(round, you);
  const draft = draftFor(round);
  return buildAnswer(round, draft) ?? partialAnswer(round, draft);
}

/**
 * Sends the draft as it is at send time, so the last change is never lost. Only in phase question, for a
 * participant who has not answered yet; unchanged drafts are not sent twice. The ack is ignored: a draft
 * error is not shown to the player.
 */
function flushDraft() {
  draftTimer = 0;
  const state = lastState;
  if (!state?.round || state.phase !== 'question' || !state.you) return;
  if (!state.you.isParticipant || state.you.answer !== null) return;
  // Anecdote read stage: no answer is expected, so nothing is sent.
  if (state.round.stage === 'read') return;
  // Guess-like question: only the target drafts in pick, only the guessers in guess.
  if (isGuessLike(state.round.question.type) && !guessCanAnswer(state)) return;
  // Not connected: nothing is sent, and the next join sends the draft again (resendDraft).
  if (!socket.connected) return;
  const round = state.round;
  const payload = draftPayload(round, state.you);
  const key = `${round.index}:${round.stage ?? ''}:${JSON.stringify(payload)}`;
  if (key === lastDraftKey) return;
  lastDraftKey = key;
  socket.emit('round:draft', payload, () => {});
}

function submitAnswer() {
  const round = lastState?.round;
  if (!round || !lastState.you || lastState.you.answer !== null || submitting) return;
  const answer = currentAnswer(lastState);
  if (!answer) return;
  submitting = true;
  actionError = null;
  refreshSubmit();
  act('round:answer', answer, (res) => {
    submitting = false;
    // On success the server has already sent a `state` with `you.answer`, which re-renders the screen.
    if (!res.ok) setActionError(res.reason);
    else refreshSubmit();
  });
}

/* ---------- Host controls (SPEC §10) ---------- */

function startGame() {
  act('game:start', null, (res) => {
    if (!res.ok) setActionError(res.reason);
  });
}

function reveal() {
  act('round:reveal', null, (res) => {
    if (!res.ok) setActionError(res.reason);
  });
}

/** Anecdote read stage: the host shows the next anecdote (SPEC §8 `round:advance`). */
function advance() {
  act('round:advance', null, (res) => {
    if (!res.ok) setActionError(res.reason);
  });
}

function nextRound() {
  act('round:next', null, (res) => {
    if (!res.ok) setActionError(res.reason);
  });
}

function resetGame() {
  if (!window.confirm(MSG_RESET_CONFIRM)) return;
  act('game:reset', null, (res) => {
    if (!res.ok) setActionError(res.reason);
  });
}

function backToLobby() {
  act('game:reset', null, (res) => {
    if (!res.ok) setActionError(res.reason);
  });
}

/* ---------- Host live edit of the question (SPEC §8 round:edit, T11) ---------- */

/**
 * Custom-option items of the round (their labels are editable), or null. Players subjects, anecdotes and
 * which questions (their items are the copains or the variants, not options) have none.
 */
function editableOptions(round) {
  const items = round.items;
  if (round.question.type === 'anecdote' || round.question.type === 'which' || items.length === 0) return null;
  return items.every((item) => typeof item.avatar !== 'string') ? items : null;
}

/** Drops the edit draft when its round is over or the viewer is no longer the host. */
function syncEditDraft(state) {
  if (!editDraft) return;
  const round = state.round;
  const valid =
    round !== null &&
    state.you !== null &&
    state.you.isHost &&
    round.index === editDraft.index &&
    round.question.id === editDraft.questionId;
  if (!valid) editDraft = null;
}

/** Field of the edit form that holds the focus, with its caret, so a re-render can restore it. */
function focusedEditField() {
  const active = document.activeElement;
  if (!active || !appEl.contains(active) || !active.dataset.editField) return null;
  return { field: active.dataset.editField, start: active.selectionStart, end: active.selectionEnd };
}

function restoreEditFocus(focus) {
  if (!focus) return;
  const input = appEl.querySelector(`[data-edit-field="${focus.field}"]`);
  if (!input) return;
  input.focus();
  if (focus.start != null && focus.end != null) input.setSelectionRange(focus.start, focus.end);
}

/**
 * Question title. The host gets a pencil next to it (« Modifier la question »); while the edit form is
 * open it replaces the title. Used by the question screens (every type and anecdote stage) and results.
 */
function questionTitle(state) {
  const round = state.round;
  if (editDraft) return editForm(editDraft);
  const title = el('h2', { class: 'question-text' }, round.question.text);
  if (!state.you.isHost) return title;
  return el('div', { class: 'question-head' }, [
    title,
    el(
      'button',
      { type: 'button', class: 'edit-btn', 'aria-label': 'Modifier la question', onclick: openEdit },
      '✎',
    ),
  ]);
}

function openEdit() {
  const round = lastState.round;
  const items = editableOptions(round);
  editDraft = {
    index: round.index,
    questionId: round.question.id,
    text: round.question.text,
    options: items ? items.map((item) => item.label) : null,
    error: null,
    pending: false,
  };
  editFocus = { field: 'text', start: editDraft.text.length, end: editDraft.text.length };
  render();
}

function closeEdit() {
  editDraft = null;
  render();
}

/** Text field of the edit form. The value lives in the draft, so a re-render never wipes it. */
function editInput(field, label, value, maxLength, onInput) {
  const input = el('input', {
    type: 'text',
    class: 'edit-form__input',
    maxlength: maxLength,
    'data-edit-field': field,
    'aria-label': label,
    oninput: (event) => onInput(event.target.value),
  });
  input.value = value;
  return input;
}

/** Edit form: question text, then one field per custom option (labels only). Ack errors go under it. */
function editForm(draft) {
  const fields = [
    el('label', { class: 'edit-form__field' }, [
      el('span', { class: 'edit-form__label' }, 'Question'),
      editInput('text', 'Intitulé de la question', draft.text, 200, (value) => {
        draft.text = value;
      }),
    ]),
  ];
  if (draft.options) {
    draft.options.forEach((label, index) => {
      fields.push(
        el('label', { class: 'edit-form__field' }, [
          el('span', { class: 'edit-form__label' }, `Proposition ${index + 1}`),
          editInput(`option:${index}`, `Proposition ${index + 1}`, label, 60, (value) => {
            draft.options[index] = value;
          }),
        ]),
      );
    });
  }
  return el(
    'form',
    {
      class: 'edit-form',
      onsubmit: (event) => {
        event.preventDefault();
        saveEdit();
      },
    },
    [
      ...fields,
      draft.error ? el('p', { class: 'error', role: 'alert' }, draft.error) : null,
      el('div', { class: 'edit-form__actions' }, [
        el(
          'button',
          { type: 'button', class: 'btn btn--ghost', disabled: draft.pending, onclick: closeEdit },
          'Annuler',
        ),
        el(
          'button',
          { type: 'submit', class: 'btn btn--primary', disabled: draft.pending },
          'Enregistrer',
        ),
      ]),
    ],
  );
}

/** Sends `round:edit` (text, and options only for custom questions). Closes the form on success. */
function saveEdit() {
  const draft = editDraft;
  if (!draft || draft.pending) return;
  const payload = { text: draft.text.trim() };
  if (draft.options) payload.options = draft.options.map((label) => label.trim());
  draft.pending = true;
  draft.error = null;
  render();
  act('round:edit', payload, (res) => {
    // The draft may have been dropped (round over) or replaced while the ack was in flight.
    if (editDraft !== draft) return;
    draft.pending = false;
    if (res.ok) editDraft = null;
    else draft.error = res.reason;
    render();
  });
}

/* ---------- Question-edited notice (players, T11) ---------- */

/**
 * Shows the notice to the non-host players when the host changed the question during the same round
 * (`round.editedAt` changed). The first state received has no previous round, so it stays silent.
 */
function notifyQuestionEdited(previous, state) {
  const round = state.round;
  if (!round || !state.you || state.you.isHost || !previous?.round) return;
  const sameRound =
    previous.round.index === round.index && previous.round.question.id === round.question.id;
  if (sameRound && round.editedAt !== null && round.editedAt !== previous.round.editedAt) {
    showToast(MSG_EDITED);
  }
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, TOAST_MS);
}

document.body.appendChild(toastEl);

/* ---------- Leaving ---------- */

function leave() {
  act('leave', null, (res) => {
    if (res.ok) {
      clearSession();
      pickerMessage = null;
      render();
    } else {
      setActionError(res.reason);
    }
  });
}
