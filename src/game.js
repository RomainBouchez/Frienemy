// Game engine (SPEC §6, §7): seats and reconnection, host, phases, rounds, timer, per-player state.
// No role checks here: socket handlers and admin routes check roles before calling these methods.
import { randomBytes, randomUUID } from 'node:crypto';
import { ROSTER, avatarUrl } from './players.js';
import {
  computeGuessResults,
  computeResults,
  computeWhichResults,
  validateAnswer,
  validatePartialAnswer,
  validateWhichText,
  whichAnswerOf,
} from './results.js';
import { computeAnecdoteResults, validateMatch, validatePartialMatch, validateWrite } from './anecdote.js';
import { computeDebrief } from './debrief.js';

/** Avatar URL of a roster or guest entry: guests carry their own (SPEC §4). */
function entryAvatarUrl(entry) {
  return entry.guest ? entry.avatar : avatarUrl(entry.id);
}

/** Roster entry of a visible (or seated) guest, from the guest store record (SPEC §4, T13). */
function guestEntry(guest) {
  return { id: guest.id, name: guest.name, color: guest.color, avatar: guest.avatar, guest: true };
}

/** Error carrying an HTTP-like status. The message is user-facing (French). */
export class GameError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GameError';
    this.status = status;
  }
}

/** Returns a shuffled copy of `array` (Fisher-Yates). `random` is injectable for tests. */
export function fisherYates(array, random = Math.random) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function seatStatus(seat) {
  if (!seat) return 'free';
  return seat.connected ? 'online' : 'offline';
}

// Types whose polarity is always positive (SPEC §5).
const ALWAYS_POSITIVE_ROUND_TYPES = Object.freeze(['smartdumb', 'anecdote', 'guess', 'which']);

/**
 * Polarity of a question (SPEC §5): a missing field reads as positive; smartdumb, anecdote, guess and
 * which are always positive.
 */
function effectivePolarity(question) {
  if (ALWAYS_POSITIVE_ROUND_TYPES.includes(question.type)) return 'positive';
  return question.polarity === 'negative' ? 'negative' : 'positive';
}

/**
 * Rounds with a target who answers a pick, then the others guess (contract guess and which): « Devine
 * sa réponse » and « Quelle était la question ? ».
 */
function isTargetRound(question) {
  return question.type === 'guess' || question.type === 'which';
}

/**
 * A which round whose pick is a copain: the target picks a player, offered as guess items (SPEC §6).
 * Such a question takes the guessPlayers rules, like a guess on players.
 */
function picksCopain(question) {
  return question.type === 'which' && question.answerKind === 'player';
}

/** Store question copied for one game, with the round timer and polarity applied and frozen. */
function frozenQuestion(question, timer) {
  return Object.freeze({
    ...question,
    options: Object.freeze([...(question.options ?? [])]),
    timer,
    polarity: effectivePolarity(question),
  });
}

/** Who a guess on players offers (SPEC §5): 'all' only when the question says so, 'online' otherwise. */
function guessPlayersOf(question) {
  return question.guessPlayers === 'all' ? 'all' : 'online';
}

function questionView(question) {
  return {
    id: question.id,
    type: question.type,
    text: question.text,
    maxChoices: question.maxChoices ?? null,
  };
}

const EDIT_TEXT_ERROR = 'Le texte de la question doit faire entre 1 et 200 caractères';
const EDIT_OPTION_ERROR = 'Chaque proposition doit faire entre 1 et 60 caractères';

/**
 * Validates a live edit of the current question (SPEC §6, T11): text 1..200, and for custom subjects
 * the same number of unique labels, each 1..60. Pure. Returns `{ text, options }` (options `[]` for
 * players subjects).
 */
export function validateRoundEdit(question, input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GameError(400, 'Corps de requête invalide');
  }
  if (typeof input.text !== 'string') throw new GameError(400, EDIT_TEXT_ERROR);
  const text = input.text.trim();
  if (text.length < 1 || text.length > 200) throw new GameError(400, EDIT_TEXT_ERROR);

  if (question.subjects !== 'custom') {
    const { options } = input;
    const absentOrEmpty =
      options === undefined || options === null || (Array.isArray(options) && options.length === 0);
    if (!absentOrEmpty) throw new GameError(400, "Cette question n'a pas de propositions à modifier");
    return { text, options: [] };
  }

  if (!Array.isArray(input.options)) {
    throw new GameError(400, 'Les propositions sont requises pour cette question');
  }
  if (input.options.length !== question.options.length) {
    throw new GameError(400, `Il faut exactement ${question.options.length} propositions`);
  }
  const options = input.options.map((option) => {
    if (typeof option !== 'string') throw new GameError(400, EDIT_OPTION_ERROR);
    const label = option.trim();
    if (label.length < 1 || label.length > 60) throw new GameError(400, EDIT_OPTION_ERROR);
    return label;
  });
  if (new Set(options).size !== options.length) {
    throw new GameError(400, 'Les propositions doivent être uniques');
  }
  return { text, options };
}

/** Custom items keep their ids (o0, o1...) and take the new labels; other items are returned as is. */
function relabelItems(items, options) {
  const labelById = new Map(options.map((label, i) => [`o${i}`, label]));
  return items.map((item) => (labelById.has(item.id) ? { ...item, label: labelById.get(item.id) } : item));
}

// A page refresh closes the socket; the host gets this long to come back before the role moves on.
export const HOST_GRACE_MS = 15_000;

// « La roue qui balance » (contract wheel §1). Same values on the client, which only animates them.
export const WHEEL_TYPES = Object.freeze(['single', 'multiple', 'ranking', 'smartdumb']);
export const WHEEL_DELAY_MS = 3000; // results shown -> the wheel appears
export const WHEEL_SPIN_MS = 5200; // main rotation
export const WHEEL_HOLD_MS = 1100; // suspense: stop at the edge, pointer folded
export const WHEEL_CREEP_MS = 750; // suspense: slide one notch
export const WHEEL_LANDED_MS = 1700; // stop, winner's slice highlighted, before the reveal
export const WHEEL_TURNS = 6; // full turns before the stop

export class Game {
  /**
   * @param {object} [options]
   * @param {{ id: string, name: string, color: string }[]} [options.roster] fixed list of players
   * @param {() => void} [options.onChange] called after every state mutation
   * @param {() => number} [options.now] clock in ms, injectable for tests
   * @param {(array: unknown[]) => unknown[]} [options.shuffle] returns a shuffled copy
   * @param {number} [options.hostGraceMs] how long a host who dropped (refresh, network) keeps the role
   * @param {() => number} [options.random] random in [0, 1), injectable for tests; only the wheel uses it
   */
  constructor({ roster = ROSTER, onChange = () => {}, now = Date.now, shuffle = fisherYates, hostGraceMs = HOST_GRACE_MS, random = Math.random } = {}) {
    // Fixed players; the guests are added by `roster` (getter below).
    this.baseRoster = roster;
    // Stored guests from the guest store: { id, name, color, avatar, visible } (SPEC §4, T13).
    this.guests = [];
    this.hostGraceMs = hostGraceMs;
    // Pending host transfer after an involuntary disconnect of the host (SPEC §6).
    this.hostGraceTimer = null;
    this.onChange = onChange;
    this.now = now;
    this.shuffle = shuffle;
    this.random = random;
    // « La roue qui balance »: chance per eligible question, copied at start (0 = never; contract wheel §3).
    this.wheelChance = 0;
    // Timer of the wheel only: separate from the round timer (contract wheel §3).
    this.wheelTimer = null;
    // playerId -> { playerId, sessionToken, socketId, connected }. Map order is join order.
    // Invariant: connected === (socketId !== null).
    this.seats = new Map();
    this.phase = 'lobby';
    this.hostId = null;
    // Unvalidated selections of the current stage (SPEC §6, brouillons): playerId -> { stage, answer,
    // incomplete, updatedAt }. Never part of a state. Taken as answers at the end of the stage.
    this.drafts = new Map();
    // Frozen copy of the questions of the running game (empty outside a game).
    this.questions = [];
    this.roundIndex = 0;
    this.round = null;
    this.timer = null;
    // Finished rounds of the running game (SPEC §6, débrief). Reset at start and reset.
    this.history = [];
    // Débrief of the running game, computed once when the phase becomes `end` (null before).
    this.debrief = null;
    // Roster of the running game, copied at start: the debrief keeps every player who played, even
    // one kicked and hidden since (null outside a game).
    this.gameRoster = null;
    // Target of the last guess round of the running game: the next draw avoids them when possible.
    this.lastGuessTargetId = null;
  }

  /**
   * Players of the game (SPEC §4): the fixed roster, then the guests that are visible or hold a seat.
   * Derived on each read, so a seat change or a hidden guest is reflected at once.
   */
  get roster() {
    const guests = this.guests.filter((guest) => guest.visible || this.seats.has(guest.id));
    return [...this.baseRoster, ...guests.map(guestEntry)];
  }

  get rosterById() {
    return new Map(this.roster.map((entry) => [entry.id, entry]));
  }

  /**
   * Replaces the stored guests (SPEC §4, T13). Called after every guest create, visibility change
   * or delete. `guests` are guest store records: `{ id, name, color, avatar, visible }`.
   */
  setGuests(guests) {
    this.guests = guests.map((guest) => ({ ...guest }));
  }

  /** Whether a player (guest or not) holds a seat. Admin guest delete refuses seated guests. */
  hasSeat(playerId) {
    return this.seats.has(playerId);
  }

  /** Whether `sessionToken` is the current token of the player's seat (a rebind, SPEC §7 rule 2). */
  isSessionOf(playerId, sessionToken) {
    const seat = this.seats.get(playerId);
    return Boolean(seat && typeof sessionToken === 'string' && seat.sessionToken === sessionToken);
  }

  /**
   * Creates or reclaims a seat (SPEC §7, rules 1-4).
   * @returns {{ playerId: string, sessionToken: string } | { error: string }}
   */
  join({ playerId, sessionToken } = {}) {
    if (!this.rosterById.has(playerId)) return { error: 'Joueur inconnu' };

    let seat = this.seats.get(playerId);
    if (!seat) {
      // Rule 1: no seat yet (also after a server restart) -> create it.
      seat = { playerId, sessionToken: randomUUID(), socketId: null, connected: false };
      this.seats.set(playerId, seat);
    } else if (seat.sessionToken !== sessionToken) {
      if (seat.connected) {
        // Rule 4: seat held by another device.
        return { error: 'Ce nom est déjà utilisé sur un autre appareil' };
      }
      // Rule 3: offline seat -> takeover with a new token (the old one is invalidated).
      seat.sessionToken = randomUUID();
    }
    // Rule 2 (token match) only needs the socket binding, done by bindSocket.

    // No onChange here: the caller binds the socket next (bindSocket notifies), and a state sent
    // before the socket carries its playerId would show `you: null` to the client.
    this.ensureHost();
    return { playerId, sessionToken: seat.sessionToken };
  }

  /**
   * Attaches a socket to a seat and marks it connected.
   * @returns {string | null} the socket id previously bound to this seat, if any
   */
  bindSocket(playerId, socketId) {
    const seat = this.seats.get(playerId);
    if (!seat) return null;
    const previous = seat.socketId;
    seat.socketId = socketId;
    seat.connected = true;
    if (playerId === this.hostId) this.#clearHostGrace();
    this.ensureHost();
    this.#checkCompletion();
    this.onChange();
    return previous;
  }

  /**
   * Marks the seat bound to `socketId` as offline. Keeps the seat and its answers.
   * A stale socket (already replaced by a newer one) matches no seat and is ignored.
   * @returns {string | null} the playerId that went offline, or null
   */
  handleDisconnect(socketId) {
    if (socketId === null || socketId === undefined) return null;
    for (const seat of this.seats.values()) {
      if (seat.socketId === socketId) {
        seat.socketId = null;
        seat.connected = false;
        // Involuntary drop (refresh, network): the host keeps the role during the grace period.
        if (seat.playerId === this.hostId && this.hostGraceMs > 0) this.#startHostGrace();
        this.ensureHost();
        this.#checkCompletion();
        this.onChange();
        return seat.playerId;
      }
    }
    return null;
  }

  /** "Ce n'est pas moi": deletes the seat in the lobby, marks it offline otherwise. */
  leave(playerId) {
    const seat = this.seats.get(playerId);
    if (!seat) return false;
    if (this.phase === 'lobby') {
      this.seats.delete(playerId);
    } else {
      seat.socketId = null;
      seat.connected = false;
    }
    // Leaving on purpose hands the role over at once.
    if (playerId === this.hostId) this.#clearHostGrace();
    this.ensureHost();
    this.#checkCompletion();
    this.onChange();
    return true;
  }

  /**
   * Admin "Exclure" (SPEC §6): removes the seat, its participation and its pending answer.
   * Items are kept, since others may have voted for this player.
   * Anecdote: a pending text (write stage) or match (match stage) is dropped; an anecdote already
   * shuffled in (read stage on) stays, and its author stays in `round.authors` (they cannot answer anymore).
   * @returns {{ socketId: string | null } | null} null when there is no seat
   */
  kick(playerId) {
    const seat = this.seats.get(playerId);
    if (!seat) return null;
    this.seats.delete(playerId);
    this.drafts.delete(playerId);
    if (this.round) {
      this.round.participants = this.round.participants.filter((id) => id !== playerId);
      // Read stage has no answers: #currentAnswers() is then a throwaway map, so nothing is deleted.
      this.#currentAnswers().delete(playerId);
      this.round.incompleteIds.delete(playerId);
      // Same for the answer log of the current stage (SPEC §6, débrief).
      this.round.answerLog = this.round.answerLog.filter(
        (entry) => !(entry.playerId === playerId && entry.stage === this.round.stage),
      );
    }
    if (playerId === this.hostId) this.#clearHostGrace();
    this.ensureHost();
    // Guess or which round: the target is removed during the pick stage, so no pick answer can come: the
    // stage ends now, with answer null (SPEC guess round).
    if (
      this.phase === 'question' &&
      this.round && isTargetRound(this.round.question) &&
      this.round.stage === 'pick' &&
      this.round.target?.id === playerId
    ) {
      this.#endStage();
    }
    this.#checkCompletion();
    this.onChange();
    return { socketId: seat.socketId };
  }

  /** Admin "Rendre hôte": only towards a connected seat. */
  setHost(playerId) {
    const seat = this.seats.get(playerId);
    if (!seat) throw new GameError(404, 'Joueur introuvable');
    if (!seat.connected) throw new GameError(400, 'Le joueur doit être connecté');
    this.#clearHostGrace();
    this.hostId = playerId;
    this.onChange();
  }

  /**
   * Keeps `hostId` on a connected seat (SPEC §6). Transfers to the first connected seat in join
   * order when the host is missing or offline — except during the host grace period, where an
   * offline host keeps the role. A host who comes back after a transfer does not get the role back.
   */
  ensureHost() {
    const current = this.seats.get(this.hostId);
    if (current?.connected) return;
    if (current && this.hostGraceTimer) return;
    const next = [...this.seats.values()].find((seat) => seat.connected);
    if (next) {
      this.hostId = next.playerId;
    } else if (!current) {
      this.hostId = null;
    }
  }

  /**
   * Starts the game from the lobby. `questions` are the playable store questions.
   * @param {{ questions: object[], settings: { questionLimit: number | null, timerByType: Record<string, number | null>, types: string[] } }} params
   */
  start({ questions = [], settings = {} } = {}) {
    if (this.phase !== 'lobby') throw new GameError(409, 'La partie a déjà commencé');
    const connectedCount = [...this.seats.values()].filter((seat) => seat.connected).length;
    if (connectedCount < 2) throw new GameError(409, 'Il faut au moins 2 joueurs connectés');

    // With exactly 2 players, an anecdote round has nothing to guess: each player links one anecdote
    // to one author (SPEC §6), so the type is left out of the draw.
    const allowed = (question) =>
      question.enabled !== false &&
      (!Array.isArray(settings.types) || settings.types.includes(question.type)) &&
      !(question.type === 'anecdote' && connectedCount === 2) &&
      // Same for a guess on players (or a which question with a copain answer) in 'online' mode: the target
      // would have a single choice, the other player. In 'all' mode the items are the whole game roster,
      // so there is always a choice.
      !(
        (question.type === 'guess' || picksCopain(question)) &&
        question.subjects === 'players' &&
        connectedCount === 2 &&
        guessPlayersOf(question) === 'online'
      );
    const picked = this.shuffle(questions.filter(allowed)).slice(0, settings.questionLimit ?? Infinity);
    if (picked.length === 0) throw new GameError(409, 'Aucune question ne correspond aux paramètres');

    // Round timer per type (T14): settings.timerByType[type], or the question's own timer when null.
    this.questions = picked.map((question) =>
      frozenQuestion(question, settings.timerByType?.[question.type] ?? question.timer),
    );
    this.roundIndex = 0;
    this.history = [];
    this.debrief = null;
    this.gameRoster = this.roster;
    this.lastGuessTargetId = null;
    // Absent from the settings (unit tests): no wheel at all.
    this.wheelChance = Number.isInteger(settings.wheelChance) ? settings.wheelChance : 0;
    this.#startRound();
    this.onChange();
  }

  /** Ends the current question now (admin or host). In an anecdote round, ends the current stage only. */
  reveal() {
    if (this.phase !== 'question') throw new GameError(409, 'Aucune question en cours');
    this.#endStage();
    this.onChange();
  }

  /**
   * Host spins the wheel (socket `round:spin`, contract wheel §3). All the outcome is drawn here, with
   * exactly 4 random() calls in this order: r1 (slice), r2 (stop), r3 (suspense), r4 (creep).
   */
  spin() {
    const round = this.round;
    if (this.phase !== 'results' || round?.wheel?.status !== 'ready') {
      throw new GameError(409, 'Aucune roue à lancer');
    }
    const wheel = round.wheel;
    const n = wheel.candidateIds.length;
    const seg = 360 / n;
    const r1 = this.random();
    const r2 = this.random();
    const r3 = this.random();
    const r4 = this.random();
    const x = Math.min(n - 1, Math.floor(r1 * n));
    const stop = r2 * seg;
    const edge = Math.min(10, Math.max(4, seg * 0.15));
    const suspense = stop < edge && r3 < 1 / 3;
    const creep = 4 + r4 * 3;
    const winnerIndex = suspense ? (x - 1 + n) % n : x;
    wheel.spin = { x, stop, suspense, creep, turns: WHEEL_TURNS, winnerId: wheel.candidateIds[winnerIndex] };
    wheel.status = 'spinning';
    wheel.spinStartedAt = this.now();
    const durationMs = WHEEL_SPIN_MS + (suspense ? WHEEL_HOLD_MS + WHEEL_CREEP_MS : 0) + WHEEL_LANDED_MS;
    this.#armWheelTimer(durationMs, () => this.#finishSpin(wheel));
    this.onChange();
  }

  /**
   * Anecdote read stage (host, `round:advance`): shows the next anecdote, or starts the match
   * stage after the last one.
   */
  advance() {
    const round = this.round;
    if (this.phase !== 'question' || round?.stage !== 'read') {
      throw new GameError(409, 'Aucune anecdote à lire en cours');
    }
    if (round.readIndex + 1 < round.anecdotes.length) {
      round.readIndex += 1;
    } else {
      this.#startMatch();
    }
    this.onChange();
  }

  /**
   * Goes to the next round, or to the end after the last one. A wheel still pending is shown now, and the
   * round does not advance (contract wheel §3); a ready or spinning wheel refuses the move.
   */
  next() {
    if (this.phase !== 'results') throw new GameError(409, 'Les résultats ne sont pas affichés');
    const wheel = this.round?.wheel ?? null;
    if (wheel?.status === 'pending') {
      this.#clearWheelTimer();
      wheel.status = 'ready';
      this.onChange();
      return;
    }
    if (wheel?.status === 'ready' || wheel?.status === 'spinning') {
      throw new GameError(409, "La roue n'a pas fini de tourner");
    }
    this.#clearWheelTimer();
    if (this.roundIndex + 1 < this.questions.length) {
      this.roundIndex += 1;
      this.#startRound();
    } else {
      this.#clearTimer();
      this.phase = 'end';
      this.round = null;
      this.debrief = computeDebrief(this.history, this.gameRoster ?? this.roster);
    }
    this.onChange();
  }

  /** Back to the lobby from any phase. Seats are kept, the timer is cancelled. */
  reset() {
    this.#clearTimer();
    this.#clearWheelTimer();
    this.phase = 'lobby';
    this.round = null;
    this.drafts.clear();
    this.questions = [];
    this.roundIndex = 0;
    this.history = [];
    this.debrief = null;
    this.gameRoster = null;
    this.lastGuessTargetId = null;
    this.ensureHost();
    this.onChange();
  }

  /**
   * Host live edit (SPEC §6, T11), phase question or results. Pure check: returns the questionId and
   * the normalized `{ text, options }`, or throws (409 wrong phase, 400 invalid input). Changes nothing.
   */
  checkRoundEdit(input) {
    if (this.phase !== 'question' && this.phase !== 'results') {
      throw new GameError(409, 'Aucune question à modifier');
    }
    const edit = validateRoundEdit(this.round.question, input);
    return { questionId: this.round.question.id, ...edit };
  }

  /**
   * Applies a checked edit to the running round: the frozen question copy, the item labels (ids
   * unchanged, so stored answers stay valid), `round.editedAt`, and the history entry when the round
   * is already finished. The bank is updated by the caller, before this method.
   */
  applyRoundEdit({ text, options }) {
    const round = this.round;
    const previous = round.question;
    const question = Object.freeze({ ...previous, text, options: Object.freeze([...options]) });
    round.question = question;
    this.questions[this.roundIndex] = question;
    if (previous.subjects === 'custom') {
      round.items = relabelItems(round.items, options);
    }
    round.editedAt = this.now();
    if (this.phase === 'results') {
      // The last history entry is the current round: it was pushed when the results came up.
      const entry = this.history.at(-1);
      if (entry) {
        entry.question.text = text;
        if (previous.subjects === 'custom') entry.items = relabelItems(entry.items, options);
      }
    }
    this.onChange();
  }

  /** Records a player's answer for the running round (for anecdote: the text or the matches, by stage). */
  answer(playerId, answer) {
    if (this.phase !== 'question') throw new GameError(409, 'Aucune question en cours');
    const round = this.round;
    if (!round.participants.includes(playerId)) throw new GameError(403, 'Tu joues au prochain round');
    if (round.stage === 'read') throw new GameError(409, 'Les anecdotes sont en cours de lecture');
    this.#assertGuessTurn(round, playerId);
    const answers = this.#currentAnswers();
    if (answers.has(playerId)) throw new GameError(409, 'Tu as déjà répondu');
    let normalized;
    try {
      normalized = this.#normalizeAnswer(round, playerId, answer);
    } catch (err) {
      throw new GameError(400, err.message);
    }
    answers.set(playerId, normalized);
    this.drafts.delete(playerId);
    round.answerLog.push({
      playerId,
      stage: round.stage,
      answer: structuredClone(normalized),
      answeredMs: this.now() - round.stageStartedAt,
    });
    this.#checkCompletion();
    this.onChange();
  }

  /**
   * Keeps a participant's unvalidated selection of the current stage (SPEC §6, brouillons). Sent by the
   * client on each change. Never broadcast: no onChange, nothing in any state. A complete answer is
   * kept as such; for ranking, tierlist and the anecdote match stage, a partial one is kept as
   * incomplete; anything else is refused and clears the previous draft. `null` clears the draft.
   * At the end of the stage the draft is taken as the answer (#finalizeDrafts).
   */
  saveDraft(playerId, draft) {
    if (this.phase !== 'question') throw new GameError(409, 'Aucune question en cours');
    const round = this.round;
    if (!round.participants.includes(playerId)) throw new GameError(403, 'Tu joues au prochain round');
    if (round.stage === 'read') throw new GameError(409, 'Les anecdotes sont en cours de lecture');
    this.#assertGuessTurn(round, playerId);
    if (this.#currentAnswers().has(playerId)) throw new GameError(409, 'Tu as déjà répondu');
    if (draft === null || draft === undefined) {
      this.drafts.delete(playerId);
      return;
    }
    let normalized;
    try {
      normalized = this.#normalizeDraft(round, playerId, draft);
    } catch (err) {
      this.drafts.delete(playerId);
      throw new GameError(400, err.message);
    }
    this.drafts.set(playerId, {
      stage: round.stage,
      answer: normalized.answer,
      incomplete: normalized.incomplete,
      updatedAt: this.now(),
    });
  }

  /** Cancels the pending timers. Call before dropping the engine. */
  dispose() {
    this.#clearTimer();
    this.#clearWheelTimer();
    this.#clearHostGrace();
  }

  /**
   * Public state for one player (SPEC §8, without questionCount). Other players' answers are never
   * included. `you.answer` is only the answer of `playerId`.
   */
  stateFor(playerId) {
    const round = this.round;
    const seat = this.seats.get(playerId);
    const answers = this.#currentAnswers();
    return {
      phase: this.phase,
      players: this.roster.map((entry) => this.#playerView(entry)),
      hostId: this.hostId,
      round: round ? this.#roundView(round, answers, playerId) : null,
      you: seat
        ? {
            playerId,
            isHost: this.hostId === playerId,
            isParticipant: round ? round.participants.includes(playerId) : false,
            answer: answers.has(playerId) ? structuredClone(answers.get(playerId)) : null,
            ownAnecdoteId: this.#ownAnecdoteId(playerId),
            // Guess round (contract): whether this player is the target, and the target's own pick answer.
            // Null for everyone else: the pick answer never leaves the target's view before results.
            isTarget: Boolean(round?.target && round.target.id === playerId),
            pickAnswer: round?.target?.id === playerId ? structuredClone(this.#pickAnswerOf(round)) : null,
            // Which round (contract which): the secret variant, to the target only, while the round runs.
            secretQuestion:
              this.phase === 'question' && round?.secretVariant && round.target?.id === playerId
                ? round.secretVariant.text
                : null,
          }
        : null,
      // Débrief (SPEC §6, §8): phase end only, same for every viewer.
      debrief: this.phase === 'end' ? structuredClone(this.debrief) : null,
    };
  }

  /** Admin view (SPEC §9 GET /api/admin/players). Never contains answer content. */
  adminPlayers() {
    const round = this.round;
    const answers = this.#currentAnswers();
    return {
      phase: this.phase,
      hostId: this.hostId,
      round: round ? { index: round.index, total: round.total } : null,
      players: this.roster.map((entry) => ({
        id: entry.id,
        name: entry.name,
        avatar: entryAvatarUrl(entry),
        status: seatStatus(this.seats.get(entry.id)),
        isHost: this.hostId === entry.id,
        isParticipant: round ? round.participants.includes(entry.id) : false,
        hasAnswered: round ? answers.has(entry.id) : false,
      })),
    };
  }

  #playerView(entry) {
    return {
      id: entry.id,
      name: entry.name,
      color: entry.color,
      avatar: entryAvatarUrl(entry),
      status: seatStatus(this.seats.get(entry.id)),
      // Guests only (SPEC §8): roster players have no `guest` key.
      ...(entry.guest ? { guest: true } : {}),
    };
  }

  #roundView(round, answers, viewerId) {
    const stage = round.stage;
    // Which round (contract which): during pick, only the target sees the items (the copains to pick from).
    const hiddenItems = round.question.type === 'which' && stage === 'pick' && viewerId !== round.target?.id;
    const items = hiddenItems ? [] : round.items;
    return {
      index: round.index,
      total: round.total,
      // Read stage has no timer (SPEC T9): no duration either.
      durationMs: stage === 'read' ? null : round.durationMs,
      // Set when the host edited the question live (SPEC §8): clients show « Question modifiée par l'hôte ».
      editedAt: round.editedAt,
      question: questionView(round.question),
      items: items.map(({ id, label, avatar, color }) => ({ id, label, avatar, color })),
      participants: [...round.participants],
      answered: round.participants.filter((id) => answers.has(id)),
      remainingMs:
        this.phase === 'question' && round.endsAt !== null ? Math.max(0, round.endsAt - this.now()) : null,
      results: this.phase === 'results' ? structuredClone(round.results) : null,
      // Anecdote stages: 'write' | 'read' | 'match' | 'results'. null for the other types.
      stage,
      // Guess round (contract): the target, public from the start; null for the other types.
      target: round.target ? { ...round.target } : null,
      // Which round (contract which): the target's answer, public from the guess stage; null before.
      whichAnswer: round.whichAnswer ? structuredClone(round.whichAnswer) : null,
      reading:
        stage === 'read'
          ? {
              index: round.readIndex,
              total: round.anecdotes.length,
              text: round.anecdotes[round.readIndex].text,
            }
          : null,
      // Anonymous: ids and texts only, never the author link (that stays server-side until results).
      anecdotes: stage === 'match' ? round.anecdotes.map(({ id, text }) => ({ id, text })) : null,
      authors: stage === 'match' ? round.authors.map((author) => ({ ...author })) : null,
      // « La roue qui balance » (contract wheel §3): the same for every viewer.
      wheel: this.#wheelView(round),
    };
  }

  /**
   * Wheel view (contract wheel §3): only in phase results, never while pending (a surprise), and the
   * winner's answer only once done. Same for every viewer.
   */
  #wheelView(round) {
    const wheel = round.wheel;
    if (this.phase !== 'results' || !wheel || wheel.status === 'pending') return null;
    return {
      status: wheel.status,
      candidates: [...wheel.candidateIds],
      spin: wheel.spin ? { ...wheel.spin } : null,
      elapsedMs: wheel.spinStartedAt === null ? null : this.now() - wheel.spinStartedAt,
      reveal: wheel.status === 'done' ? structuredClone(wheel.reveal) : null,
    };
  }

  /** Anecdote match stage: the id of the player's own anecdote (null for non-writers or other stages). */
  #ownAnecdoteId(playerId) {
    const round = this.round;
    if (!round || round.stage !== 'match') return null;
    return round.anecdotes.find((anecdote) => anecdote.authorId === playerId)?.id ?? null;
  }

  /**
   * Answers of the current stage, keyed by playerId: the round answers for the other types, the
   * texts (write), the matches (match, results). The read stage has none: a throwaway empty map.
   */
  #currentAnswers() {
    const round = this.round;
    if (!round) return new Map();
    if (round.question.type !== 'anecdote') return round.answers;
    if (round.stage === 'write') return round.texts;
    if (round.stage === 'match' || round.stage === 'results') return round.matches;
    return new Map();
  }

  #normalizeAnswer(round, playerId, answer) {
    if (round.stage === 'write') return validateWrite(answer);
    if (round.stage === 'match') return validateMatch(answer, this.#matchDomain(round, playerId));
    // Which round, pick stage with a free text: not a choice among items.
    if (round.question.type === 'which' && round.stage === 'pick' && round.question.answerKind === 'text') {
      return validateWhichText(answer);
    }
    return validateAnswer(round.question, round.items, answer);
  }

  /**
   * Draft validation: a complete answer, or else a partial one where the type allows it. Returns
   * `{ answer, incomplete }`; throws with the message of the reason it is refused.
   */
  #normalizeDraft(round, playerId, draft) {
    try {
      return { answer: this.#normalizeAnswer(round, playerId, draft), incomplete: false };
    } catch (err) {
      if (!this.#acceptsPartial(round)) throw err;
      return { answer: this.#normalizePartial(round, playerId, draft), incomplete: true };
    }
  }

  /** Types and stages where a partial answer is meaningful: placements (ranking, tierlist, match). */
  #acceptsPartial(round) {
    const { type } = round.question;
    return type === 'ranking' || type === 'tierlist' || (type === 'anecdote' && round.stage === 'match');
  }

  #normalizePartial(round, playerId, draft) {
    if (round.question.type === 'anecdote') return validatePartialMatch(draft, this.#matchDomain(round, playerId));
    return validatePartialAnswer(round.question, round.items, draft);
  }

  /** What `playerId` may match: every anecdote but their own, every author but themselves. */
  #matchDomain(round, playerId) {
    return {
      anecdoteIds: round.anecdotes.filter((anecdote) => anecdote.authorId !== playerId).map((a) => a.id),
      authorIds: round.authors.filter((author) => author.id !== playerId).map((author) => author.id),
    };
  }

  /** Guess round: the target's pick answer in the pick stage, or the pick kept once the guess stage runs. */
  #pickAnswerOf(round) {
    if (round.stage === 'pick') return round.answers.get(round.target?.id) ?? null;
    return round.pickAnswer;
  }

  /** Guess and which rounds: only the target answers the pick stage, and only the others guess. */
  #assertGuessTurn(round, playerId) {
    if (!isTargetRound(round.question)) return;
    const isTarget = round.target?.id === playerId;
    if (round.stage === 'pick' && !isTarget) throw new GameError(403, `C'est ${round.target?.name} qui répond`);
    if (round.stage === 'guess' && isTarget) throw new GameError(403, 'Tu ne devines pas ta propre réponse');
  }

  /**
   * Guess round: the pick stage ends with the target's answer. It moves to the guess stage (answers
   * reset, the pick kept, timer re-armed), or to results with answer null when the target gave none.
   */
  #startGuessStage() {
    const round = this.round;
    const pick = round.answers.get(round.target?.id) ?? null;
    if (pick === null) {
      this.#endRound();
      return;
    }
    round.pickAnswer = pick;
    if (round.question.type === 'which') {
      // Which round: the guess items are the variants (ids v0..vN), and the pick is shown to everyone.
      round.whichAnswer = this.#whichAnswerView(round, pick);
      round.items = round.variantItems;
    }
    round.stage = 'guess';
    round.answers = new Map();
    this.#armTimer(round, round.durationMs);
  }

  /**
   * Which round: the target's pick as shown from the guess stage on. A copain is named with the label
   * and look of its item (the pick items, before the switch to the variants); a text is shown as typed.
   */
  #whichAnswerView(round, pick) {
    if (round.question.answerKind === 'text') return { kind: 'text', text: pick.text };
    const item = round.items.find((candidate) => candidate.id === pick.choice);
    return {
      kind: 'player',
      playerId: pick.choice,
      name: item?.label ?? null,
      avatar: item?.avatar ?? null,
      color: item?.color ?? null,
    };
  }

  /** Which round: one variant per question, in question order (ids v0..vN), no avatar and no colour. */
  #variantItemsOf(question) {
    return question.variants.map((label, i) => ({ id: `v${i}`, label, avatar: null, color: null }));
  }

  /**
   * Guess round: the target is drawn among the connected seats (every seat when none is connected),
   * avoiding the previous guess target of the game when possible. Uses the injected shuffle.
   * Returns `{ id, name, avatar, color }`, or null when there is nobody to draw.
   */
  #drawGuessTarget(participants) {
    const connected = participants.filter((id) => this.seats.get(id)?.connected);
    const pool = connected.length > 0 ? connected : participants;
    if (pool.length === 0) return null;
    const fresh = pool.filter((id) => id !== this.lastGuessTargetId);
    const [playerId] = this.shuffle(fresh.length > 0 ? fresh : pool);
    this.lastGuessTargetId = playerId;
    const entry = this.rosterById.get(playerId);
    return { id: playerId, name: entry.name, avatar: entryAvatarUrl(entry), color: entry.color };
  }

  #startRound() {
    const question = this.questions[this.roundIndex];
    const participants = [...this.seats.keys()];
    // Guess and which rounds: the target is drawn now; the items are the other participants.
    const target = isTargetRound(question) ? this.#drawGuessTarget(participants) : null;
    // Which round: the variants are fixed now, and the secret one (the question the target answers) is
    // drawn among them (shuffle injectable). Known to the server and the target until results.
    const variantItems = question.type === 'which' ? this.#variantItemsOf(question) : [];
    const drawn = question.type === 'which' ? this.shuffle(variantItems)[0] : undefined;
    const secretVariant = drawn ? { id: drawn.id, text: drawn.label } : null;

    const round = {
      index: this.roundIndex,
      total: this.questions.length,
      question,
      items: this.#itemsFor(question, participants, target),
      participants,
      target, // guess and which: { id, name, avatar, color } (public); null for the other types
      pickAnswer: null, // guess and which: the target's pick answer, once the guess stage starts
      whichAnswer: null, // which: the public view of the pick, once the guess stage starts
      variantItems, // which: the variants as items v0..vN (guess items from the guess stage on)
      secretVariant, // which: { id, text } of the variant the target answers; null for the other types
      answers: new Map(), // every type but anecdote
      texts: new Map(), // anecdote write stage: playerId -> { text }
      matches: new Map(), // anecdote match stage: playerId -> { matches }
      stage: question.type === 'anecdote' ? 'write' : isTargetRound(question) ? 'pick' : null,
      durationMs: question.timer * 1000,
      editedAt: null, // ms, set by applyRoundEdit when the host edits the question live (T11)
      endsAt: null,
      results: null,
      anecdotes: [], // anecdote, filled when the write stage closes: [{ id, text, authorId }], shuffled
      authors: [], // anecdote, filled when the write stage closes: [{ id, label, avatar, color }], roster order
      readIndex: 0,
      matchStarted: false,
      answerLog: [], // { playerId, stage, answer, answeredMs } for the débrief, in acceptance order
      stageStartedAt: null, // ms, set by #armTimer when the stage starts
      incompleteIds: new Set(), // players whose answer of the stage was auto-saved from a partial draft
      wheel: null, // « La roue qui balance » { status, candidateIds, spin, reveal, spinStartedAt }, see #rollWheel
    };
    this.drafts.clear();
    this.round = round;
    this.phase = 'question';
    this.#armTimer(round, round.durationMs);
  }

  /** Starts the timer of the current stage. Only that stage's timer may end it (see #armTimer). */
  #armTimer(round, timerMs) {
    this.#clearTimer();
    round.stageStartedAt = this.now();
    round.endsAt = round.stageStartedAt + timerMs;
    const stage = round.stage;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.round === round && this.phase === 'question' && round.stage === stage) {
        this.#endStage();
        this.onChange();
      }
    }, timerMs);
    this.timer.unref?.();
  }

  /**
   * Round items (SPEC §5). Ranking of players uses the whole roster, other player subjects the participants.
   * Guess on players (SPEC §6): never the target; 'online' the participants connected at the round start,
   * 'all' the whole game roster (gameRoster, frozen at start).
   */
  #itemsFor(question, participants, target = null) {
    if (question.type === 'anecdote') return [];
    // Which round with a free text: the pick is not a choice, so there are no items (variants come later).
    if (question.type === 'which' && question.answerKind === 'text') return [];
    if (question.subjects !== 'players') {
      return question.options.map((label, i) => ({ id: `o${i}`, label, avatar: null, color: null }));
    }
    const roster = this.roster;
    const byId = new Map(roster.map((entry) => [entry.id, entry]));
    if (question.type === 'guess' || picksCopain(question)) {
      const entries =
        guessPlayersOf(question) === 'all'
          ? this.gameRoster ?? roster
          : participants.filter((id) => this.seats.get(id)?.connected).map((id) => byId.get(id));
      return entries
        .filter((entry) => entry.id !== target?.id)
        .map((entry) => ({ id: entry.id, label: entry.name, avatar: entryAvatarUrl(entry), color: entry.color }));
    }
    const ids = question.type === 'ranking' ? roster.map((entry) => entry.id) : participants;
    return ids.map((id) => {
      const entry = byId.get(id);
      return { id, label: entry.name, avatar: entryAvatarUrl(entry), color: entry.color };
    });
  }

  /**
   * Ends the current stage. Other types go straight to results. Anecdote: write -> read (or results
   * when fewer than 2 anecdotes), read -> match, match -> results.
   */
  #endStage() {
    this.#clearTimer();
    // Drafts become answers before anything is computed or closed, whatever ended the stage.
    this.#finalizeDrafts();
    const round = this.round;
    if (isTargetRound(round.question)) {
      if (round.stage === 'pick') this.#startGuessStage();
      else this.#endRound();
      return;
    }
    if (round.question.type !== 'anecdote') {
      this.#endRound();
      return;
    }
    if (round.stage === 'write') {
      this.#closeWriting();
      if (round.anecdotes.length < 2) {
        this.#endRound();
        return;
      }
      round.stage = 'read';
      round.readIndex = 0;
      round.endsAt = null;
      return;
    }
    if (round.stage === 'read') {
      this.#startMatch();
      return;
    }
    this.#endRound();
  }

  /**
   * End of a stage (SPEC §6, brouillons): each participant with no answer for this stage but a draft of
   * it gets that draft registered as their answer, connected or not. Answer time = last draft update
   * minus the start of the stage. Automatic entries are flagged `auto: true`.
   */
  #finalizeDrafts() {
    const round = this.round;
    const answers = this.#currentAnswers();
    for (const [playerId, draft] of this.drafts) {
      if (draft.stage !== round.stage || !round.participants.includes(playerId) || answers.has(playerId)) continue;
      answers.set(playerId, structuredClone(draft.answer));
      if (draft.incomplete) round.incompleteIds.add(playerId);
      round.answerLog.push({
        playerId,
        stage: round.stage,
        answer: structuredClone(draft.answer),
        answeredMs: draft.updatedAt - round.stageStartedAt,
        auto: true,
        incomplete: draft.incomplete,
      });
    }
    this.drafts.clear();
  }

  /** Anecdote: texts are shuffled once here. Each anecdote gets a random opaque id; authors are frozen. */
  #closeWriting() {
    const round = this.round;
    const entries = [...round.texts].map(([authorId, { text }]) => ({ authorId, text }));
    const taken = new Set();
    round.anecdotes = this.shuffle(entries).map(({ authorId, text }) => ({
      id: this.#newAnecdoteId(taken),
      text,
      authorId,
    }));
    round.authors = this.roster
      .filter((entry) => round.texts.has(entry.id))
      .map((entry) => ({ id: entry.id, label: entry.name, avatar: entryAvatarUrl(entry), color: entry.color }));
  }

  #newAnecdoteId(taken) {
    let id;
    do {
      id = `a_${randomBytes(4).toString('hex')}`;
    } while (taken.has(id));
    taken.add(id);
    return id;
  }

  #startMatch() {
    const round = this.round;
    round.stage = 'match';
    round.matchStarted = true;
    this.#armTimer(round, round.durationMs);
  }

  #endRound() {
    this.#clearTimer();
    const round = this.round;
    if (round.question.type === 'anecdote') {
      // Results reveal the authors and the associations (SPEC §8 privacy exception). With no match
      // stage (fewer than 2 anecdotes), nobody is scored.
      round.stage = 'results';
      round.endsAt = null;
      round.results = computeAnecdoteResults(
        round.anecdotes,
        round.matches,
        round.matchStarted ? round.participants : [],
        round.incompleteIds,
      );
    } else if (round.question.type === 'guess') {
      // No pick answer: no guess stage ran, so nobody is scored (answer null). Otherwise the guesses
      // are the answers of the guess stage.
      round.results = {
        ...computeGuessResults({
          items: round.items,
          pickAnswer: round.pickAnswer,
          guesses: round.pickAnswer ? round.answers : new Map(),
          order: round.participants,
        }),
        targetId: round.target?.id ?? null,
      };
    } else if (round.question.type === 'which') {
      // Same rule as guess: no pick answer means answer null and nobody scored. The rows are the variants.
      round.results = computeWhichResults({
        variants: round.variantItems,
        secretVariantId: round.secretVariant?.id ?? null,
        targetId: round.target?.id ?? null,
        answer: whichAnswerOf(round.question.answerKind, round.pickAnswer),
        guesses: round.pickAnswer ? round.answers : new Map(),
        order: round.participants,
      });
    } else {
      round.results = computeResults(round.question, round.items, [...round.answers.values()]);
      if (round.question.type === 'ranking') {
        // Partial rankings (auto-saved drafts): a count only, never names (SPEC §8).
        round.results.incompleteCount = round.incompleteIds.size;
      }
      if (round.question.type === 'tierlist') {
        // Exception to the answer privacy rule (SPEC §8): tier lists are shown per player in phase results.
        round.results.perPlayer = round.participants
          .filter((id) => round.answers.has(id))
          .map((playerId) => ({
            playerId,
            tiers: { ...round.answers.get(playerId).tiers },
            incomplete: round.incompleteIds.has(playerId),
          }));
      }
    }
    this.history.push(this.#recordRound(round));
    this.phase = 'results';
    this.#rollWheel(round);
  }

  /**
   * « La roue qui balance » (contract wheel §3): at the end of an eligible round with at least 2 connected
   * players who answered, one random() draw against wheelChance. A hit makes a pending wheel, ready after
   * WHEEL_DELAY_MS; otherwise there is no wheel (and no more draw).
   */
  #rollWheel(round) {
    if (!WHEEL_TYPES.includes(round.question.type)) return;
    const candidateIds = round.participants.filter((id) => round.answers.has(id) && this.seats.get(id)?.connected);
    if (candidateIds.length < 2) return;
    if (!(this.random() * 100 < this.wheelChance)) return;
    const wheel = { status: 'pending', candidateIds, spin: null, reveal: null, spinStartedAt: null };
    round.wheel = wheel;
    this.#armWheelTimer(WHEEL_DELAY_MS, () => {
      wheel.status = 'ready';
    });
  }

  /** Spin over (contract wheel §3): the winner's answer is revealed, and only that answer. */
  #finishSpin(wheel) {
    const winnerId = wheel.spin.winnerId;
    const answer = this.round.answers.get(winnerId);
    wheel.status = 'done';
    wheel.reveal = {
      playerId: winnerId,
      answer: answer === undefined ? null : structuredClone(answer),
      incomplete: this.round.incompleteIds.has(winnerId),
    };
  }

  /** Starts the wheel timer. It is separate from the round timer; `step` changes the wheel, then onChange runs. */
  #armWheelTimer(delayMs, step) {
    this.#clearWheelTimer();
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
      step();
      this.onChange();
    }, delayMs);
    this.wheelTimer.unref?.();
  }

  #clearWheelTimer() {
    if (this.wheelTimer) {
      clearTimeout(this.wheelTimer);
      this.wheelTimer = null;
    }
  }

  /** Snapshot of a finished round for the débrief (SPEC §6). Copies, so later mutations do not reach it. */
  #recordRound(round) {
    const { question } = round;
    return {
      question: {
        id: question.id,
        type: question.type,
        text: question.text, // kept current by live edits (T11)
        subjects: question.subjects,
        polarity: effectivePolarity(question),
      },
      participants: [...round.participants],
      items: structuredClone(round.items),
      answers: round.answerLog.map(({ playerId, stage, answer, answeredMs }) => ({
        playerId,
        stage,
        answer: structuredClone(answer),
        answeredMs,
      })),
      results: structuredClone(round.results),
      anecdote:
        question.type === 'anecdote'
          ? {
              matched: round.matchStarted,
              authors: structuredClone(round.authors),
              anecdotes: round.anecdotes.map(({ id, text, authorId }) => ({ id, text, authorId })),
            }
          : null,
    };
  }

  /**
   * Ends the current stage when at least one participant is connected and all connected ones
   * answered. The read stage has no such rule: the host advances (or the admin reveals).
   */
  #checkCompletion() {
    const round = this.round;
    if (this.phase !== 'question' || !round) return;
    if (round.stage === 'read') return;
    if (isTargetRound(round.question)) {
      this.#checkGuessCompletion(round);
      return;
    }
    const answers = this.#currentAnswers();
    const connected = round.participants.filter((id) => this.seats.get(id)?.connected);
    if (connected.length > 0 && connected.every((id) => answers.has(id))) {
      this.#endStage();
    }
  }

  /**
   * Guess round: pick ends once the target (when connected) answered; guess ends once every connected
   * guesser answered. With no connected guesser, the guess stage waits for the timer or the reveal.
   */
  #checkGuessCompletion(round) {
    if (round.stage === 'pick') {
      const target = round.target;
      if (target && this.seats.get(target.id)?.connected && round.answers.has(target.id)) this.#endStage();
      return;
    }
    const guessers = round.participants.filter((id) => id !== round.target?.id && this.seats.get(id)?.connected);
    if (guessers.length > 0 && guessers.every((id) => round.answers.has(id))) this.#endStage();
  }

  #clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  #startHostGrace() {
    if (this.hostGraceTimer) return;
    this.hostGraceTimer = setTimeout(() => {
      this.hostGraceTimer = null;
      this.ensureHost();
      this.onChange();
    }, this.hostGraceMs);
    this.hostGraceTimer.unref?.();
  }

  #clearHostGrace() {
    if (this.hostGraceTimer) {
      clearTimeout(this.hostGraceTimer);
      this.hostGraceTimer = null;
    }
  }
}
