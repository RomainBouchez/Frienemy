import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROSTER } from './players.js';

export const QUESTION_TYPES = Object.freeze([
  'single',
  'multiple',
  'ranking',
  'smartdumb',
  'tierlist',
  'anecdote',
  'guess',
  'which',
]);
export const POLARITIES = Object.freeze(['positive', 'negative']);
// Answer kinds of a which question (contract which): a copain of the group, or a free text.
export const WHICH_ANSWER_KINDS = Object.freeze(['player', 'text']);
// Variants of a which question: 3 to 5 questions, each 1..200 characters, unique (case-insensitive).
export const WHICH_VARIANTS_MIN = 3;
export const WHICH_VARIANTS_MAX = 5;
// Player count bound for players subjects when the roster is empty: the guest cap (guests.js MAX_GUESTS).
const PLAYER_CAP_WITHOUT_ROSTER = 30;

const SEED_FILE = fileURLToPath(new URL('../data/questions.seed.json', import.meta.url));
const DEFAULT_TIMER = 30;
// Types whose polarity is always positive (SPEC §5).
const ALWAYS_POSITIVE_TYPES = Object.freeze(['smartdumb', 'anecdote', 'guess', 'which']);
// Default timers of the types that differ from DEFAULT_TIMER: anecdote rounds (T9) have three stages, which
// rounds (contract which) a pick then a guess. Same 10..300 range.
const DEFAULT_TYPE_TIMER = Object.freeze({ anecdote: 180, which: 45 });
// Proposals from the lobby (SPEC §6, T12): per player, pending at the same time.
export const MAX_PENDING_PROPOSALS = 3;
const SMARTDUMB_PROPOSAL_ERROR = 'Les questions Intelligent / Débile ne peuvent pas être proposées';
const WHICH_PROPOSAL_ERROR = 'Les questions Quelle était la question ? ne peuvent pas être proposées';

/** Input rejected by the store rules (SPEC §5). Routes map it to HTTP 400. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function fail(message) {
  throw new ValidationError(message);
}

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function requireObject(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('Corps de requête invalide');
  }
  return input;
}

function normalizeQuestion(input, id) {
  const body = requireObject(input);

  if (!QUESTION_TYPES.includes(body.type)) fail('Type de question invalide');
  const type = body.type;

  if (typeof body.text !== 'string') fail('Texte de question requis');
  const text = body.text.trim();
  if (text.length < 1 || text.length > 200) {
    fail('Le texte de la question doit faire entre 1 et 200 caractères');
  }

  // smartdumb, anecdote and which always use players, whatever the input says.
  let subjects = body.subjects;
  if (type === 'smartdumb' || type === 'anecdote' || type === 'which') {
    subjects = 'players';
  } else if (subjects !== 'players' && subjects !== 'custom') {
    fail('Sujets invalides (players ou custom)');
  }

  let options = [];
  if (subjects === 'custom') {
    if (!Array.isArray(body.options)) fail('Les options sont requises pour des sujets personnalisés');
    if (body.options.length < 2 || body.options.length > 12) {
      fail('Il faut entre 2 et 12 options');
    }
    options = body.options.map((option) => {
      if (typeof option !== 'string') fail('Chaque option doit être une chaîne de caractères');
      const label = option.trim();
      if (label.length < 1 || label.length > 60) {
        fail('Chaque option doit faire entre 1 et 60 caractères');
      }
      return label;
    });
    if (new Set(options).size !== options.length) fail('Les options doivent être uniques');
  }

  let maxChoices = null;
  if (type === 'multiple' && body.maxChoices !== undefined && body.maxChoices !== null) {
    // Items are the custom options, or the roster for players subjects. Without a fixed roster (public
    // edition: guests only) the player count is only known at play time, so the guest cap bounds it.
    const itemCount = subjects === 'custom' ? options.length : (ROSTER.length > 0 ? ROSTER.length : PLAYER_CAP_WITHOUT_ROSTER);
    if (!isInt(body.maxChoices, 1, itemCount)) {
      fail(`Le nombre de choix maximum doit être un entier entre 1 et ${itemCount}`);
    }
    maxChoices = body.maxChoices;
  }

  const defaultTimer = DEFAULT_TYPE_TIMER[type] ?? DEFAULT_TIMER;
  const timer = body.timer === undefined ? defaultTimer : body.timer;
  if (!isInt(timer, 10, 300)) fail('Le timer doit être un entier entre 10 et 300 secondes');

  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== 'boolean') fail('Le champ enabled doit être un booléen');

  // Polarity (SPEC §5): missing = positive; smartdumb, anecdote and guess are always positive.
  if (body.polarity !== undefined && !POLARITIES.includes(body.polarity)) {
    fail('La polarité doit être positive ou négative');
  }
  const polarity = ALWAYS_POSITIVE_TYPES.includes(type) ? 'positive' : (body.polarity ?? 'positive');

  // Which question (contract which): answerKind and variants are required; other types store null.
  let answerKind = null;
  let variants = null;
  if (type === 'which') {
    if (!WHICH_ANSWER_KINDS.includes(body.answerKind)) {
      fail('Le type de réponse doit être un copain ou un texte libre');
    }
    answerKind = body.answerKind;
    variants = normalizeVariants(body.variants);
  }

  // Who a guess on players offers (SPEC §5, §6). Checked for every type, like polarity. Only a guess on
  // players (or a which question with a copain answer) keeps it: missing (or null, as sent back by a live
  // edit or a list toggle) reads as 'online'; any other question stores null.
  if (body.guessPlayers !== undefined && body.guessPlayers !== null && !GUESS_PLAYERS.includes(body.guessPlayers)) {
    fail('Choix des copains invalide');
  }
  const guessPlayers = offersPlayers(type, subjects, answerKind) ? (body.guessPlayers ?? 'online') : null;

  // pending / proposedBy are not settable from input: the store sets them (SPEC §5).
  return {
    id,
    type,
    text,
    subjects,
    options,
    maxChoices,
    timer,
    enabled,
    polarity,
    guessPlayers,
    variants,
    answerKind,
    pending: false,
    proposedBy: null,
  };
}

/** Variants of a which question: 3 to 5 texts, each trimmed to 1..200 characters, unique ignoring case. */
function normalizeVariants(input) {
  if (!Array.isArray(input) || input.length < WHICH_VARIANTS_MIN || input.length > WHICH_VARIANTS_MAX) {
    fail(`Il faut entre ${WHICH_VARIANTS_MIN} et ${WHICH_VARIANTS_MAX} variantes`);
  }
  const variants = input.map((variant) => {
    if (typeof variant !== 'string') fail('Chaque variante doit être une chaîne de caractères');
    const label = variant.trim();
    if (label.length < 1 || label.length > 200) {
      fail('Chaque variante doit faire entre 1 et 200 caractères');
    }
    return label;
  });
  if (new Set(variants.map((label) => label.toLowerCase())).size !== variants.length) {
    fail('Les variantes doivent être uniques');
  }
  return variants;
}

/**
 * Questions whose round lets the target pick a copain (guess, or which with a copain answer): their
 * `guessPlayers` says who is offered. Players subjects only.
 */
function offersPlayers(type, subjects, answerKind) {
  return subjects === 'players' && (type === 'guess' || (type === 'which' && answerKind === 'player'));
}

/** Question read from the file: a question with copains written before the choice existed reads as 'online'. */
function storedGuessPlayers(question) {
  if (!offersPlayers(question.type, question.subjects, question.answerKind ?? null)) return null;
  return question.guessPlayers === 'all' ? 'all' : 'online';
}

const TYPE_LABELS = Object.freeze({
  single: 'QCU',
  multiple: 'QCM',
  ranking: 'Classement',
  smartdumb: 'Intelligent / Débile',
  tierlist: 'Tierlist',
  anecdote: 'Anecdote',
  guess: 'Devine sa réponse',
  which: 'Quelle était la question ?',
});

const SETTINGS_KEYS = Object.freeze(['questionLimit', 'timerByType', 'types', 'wheelChance']);

// Chance (0..100, per eligible question) that « La roue qui balance » follows the results (contract wheel §2).
// Absent or null in a PUT, and absent from a settings.json written before the wheel, both read as this default.
export const DEFAULT_WHEEL_CHANCE = 20;

/** Players of a guess round on players (SPEC §5, per question): the connected ones at the round start, or the whole game roster. */
const GUESS_PLAYERS = Object.freeze(['online', 'all']);

/** Per-type round timer (SPEC §5): exactly the 7 types, each null or an integer 10..300. */
function normalizeTimerByType(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('Les timers par type doivent être un objet');
  }
  for (const key of Object.keys(input)) {
    if (!QUESTION_TYPES.includes(key)) fail(`Type de question inconnu dans les timers : ${key}`);
  }
  const timerByType = {};
  for (const type of QUESTION_TYPES) {
    const label = TYPE_LABELS[type];
    if (!Object.hasOwn(input, type)) fail(`Le timer de ${label} est requis (vide ou entier)`);
    const value = input[type];
    if (value !== null && !isInt(value, 10, 300)) {
      fail(`Le timer ${label} doit être un entier entre 10 et 300 secondes, ou vide`);
    }
    timerByType[type] = value;
  }
  return timerByType;
}

function normalizeSettings(input) {
  const body = requireObject(input);
  for (const key of Object.keys(body)) {
    if (!SETTINGS_KEYS.includes(key)) fail(`Paramètre inconnu : ${key}`);
  }

  let questionLimit;
  if (body.questionLimit === null) {
    questionLimit = null;
  } else if (isInt(body.questionLimit, 1, 100)) {
    questionLimit = body.questionLimit;
  } else {
    fail('La limite de questions doit être un entier entre 1 et 100, ou vide');
  }

  const timerByType = normalizeTimerByType(body.timerByType);

  if (!Array.isArray(body.types) || body.types.length === 0) {
    fail('Il faut au moins un type de question');
  }
  for (const type of body.types) {
    if (!QUESTION_TYPES.includes(type)) fail('Type de question inconnu');
  }
  if (new Set(body.types).size !== body.types.length) fail('Types de question en double');

  let wheelChance;
  if (body.wheelChance === undefined || body.wheelChance === null) {
    wheelChance = DEFAULT_WHEEL_CHANCE;
  } else if (isInt(body.wheelChance, 0, 100)) {
    wheelChance = body.wheelChance;
  } else {
    fail('La chance de la roue doit être un entier entre 0 et 100');
  }

  return { questionLimit, timerByType, types: [...body.types], wheelChance };
}

function defaultTimerByType() {
  return Object.fromEntries(QUESTION_TYPES.map((type) => [type, null]));
}

function defaultSettings() {
  return {
    questionLimit: null,
    timerByType: defaultTimerByType(),
    types: [...QUESTION_TYPES],
    wheelChance: DEFAULT_WHEEL_CHANCE,
  };
}

/**
 * Settings written before T14 hold `timerOverride` (one value or null). A non-null value becomes
 * the timer of the five non-anecdote types (anecdote already ignored it). Returns the settings
 * and whether they changed, so the caller can rewrite the file once.
 */
/**
 * Settings written before the guess type (no `timerByType.guess` key): the type is added to `types`
 * once, and its timer starts empty (null). Idempotent: once the key exists, nothing changes.
 */
function migrateAddedType(settings, type) {
  if (!settings.timerByType || Object.hasOwn(settings.timerByType, type)) {
    return { settings, migrated: false };
  }
  const types = Array.isArray(settings.types) ? settings.types : [];
  return {
    settings: {
      ...settings,
      types: types.includes(type) ? types : [...types, type],
      timerByType: { ...settings.timerByType, [type]: null },
    },
    migrated: true,
  };
}

/**
 * Settings written before the which type (no `timerByType.which` key): same migration as guess, applied
 * after migrateAddedType(settings, 'guess'). Idempotent.
 */
function migrateWhichType(settings) {
  return migrateAddedType(settings, 'which');
}

function migrateSettings(raw) {
  if (!Object.hasOwn(raw, 'timerOverride')) return { settings: raw, migrated: false };
  const { timerOverride, ...rest } = raw;
  // Pre-guess shape: no `guess` and `which` keys here; the added-type migrations add them (timer null,
  // type added to `types`).
  const timerByType =
    rest.timerByType ??
    Object.fromEntries(
      QUESTION_TYPES.filter((type) => type !== 'guess' && type !== 'which').map((type) => [type, null]),
    );
  if (timerOverride !== null && timerOverride !== undefined) {
    for (const type of Object.keys(timerByType)) {
      if (type !== 'anecdote') timerByType[type] = timerOverride;
    }
  }
  return { settings: { ...rest, timerByType }, migrated: true };
}

/** Writes `content` (string or Buffer) to `file` through `file.tmp` + rename (SPEC §9). */
export function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPlayable(question, settings) {
  return question.enabled && !question.pending && settings.types.includes(question.type);
}

/**
 * Question and settings store backed by `dataDir/questions.json` and `dataDir/settings.json`.
 * Keeps an in-memory cache; every mutation writes the file atomically before updating the cache.
 * All returned values are copies.
 * @param {string} dataDir
 */
export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const questionsFile = path.join(dataDir, 'questions.json');
  const settingsFile = path.join(dataDir, 'settings.json');

  if (!fs.existsSync(questionsFile)) {
    writeFileAtomic(questionsFile, fs.readFileSync(SEED_FILE, 'utf8'));
  }
  if (!fs.existsSync(settingsFile)) {
    writeFileAtomic(settingsFile, `${JSON.stringify(defaultSettings(), null, 2)}\n`);
  }

  // Questions written before the polarity field read as positive (SPEC §5).
  // Questions written before T12 read as validated (pending false, no proposer), SPEC §5.
  let questions = readJson(questionsFile).map((question) => ({
    ...question,
    polarity: question.polarity ?? 'positive',
    pending: question.pending ?? false,
    proposedBy: question.proposedBy ?? null,
    guessPlayers: storedGuessPlayers(question),
    variants: question.variants ?? null,
    answerKind: question.answerKind ?? null,
  }));
  // Legacy timerOverride is migrated once and the file rewritten right away (SPEC §5, T14).
  const migration = migrateSettings(readJson(settingsFile));
  const guessMigration = migrateAddedType(migration.settings, 'guess');
  const whichMigration = migrateWhichType(guessMigration.settings);
  // guessPlayers was a setting of the party and is now per question: an old key is ignored here, and it
  // leaves the file at the next write (updateSettings writes normalizeSettings output only).
  let { guessPlayers: _legacyGuessPlayers, ...loaded } = whichMigration.settings;
  // wheelChance was added with « La roue qui balance »: a settings.json without it reads as the default.
  let settings = { ...loaded, wheelChance: loaded.wheelChance ?? DEFAULT_WHEEL_CHANCE };
  if (migration.migrated || guessMigration.migrated || whichMigration.migrated) {
    writeFileAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }

  function persistQuestions(next) {
    writeFileAtomic(questionsFile, `${JSON.stringify(next, null, 2)}\n`);
    questions = next;
  }

  function countPending(playerId) {
    return questions.filter((q) => q.pending && q.proposedBy === playerId).length;
  }

  function newQuestionId() {
    let id;
    do {
      id = `q_${crypto.randomBytes(4).toString('hex')}`;
    } while (questions.some((question) => question.id === id));
    return id;
  }

  return {
    listQuestions() {
      return structuredClone(questions);
    },

    getQuestion(id) {
      const question = questions.find((q) => q.id === id);
      return question ? structuredClone(question) : null;
    },

    createQuestion(input) {
      const question = normalizeQuestion(input, newQuestionId());
      persistQuestions([...questions, question]);
      return structuredClone(question);
    },

    updateQuestion(id, input) {
      const index = questions.findIndex((q) => q.id === id);
      if (index === -1) return null;
      // Keeps the proposal state: an edit never validates or re-attributes a question (SPEC §5).
      const existing = questions[index];
      const question = {
        ...normalizeQuestion(input, id),
        pending: existing.pending,
        proposedBy: existing.proposedBy,
      };
      const next = questions.slice();
      next[index] = question;
      persistQuestions(next);
      return structuredClone(question);
    },

    removeQuestion(id) {
      if (!questions.some((q) => q.id === id)) return false;
      persistQuestions(questions.filter((q) => q.id !== id));
      return true;
    },

    /**
     * Player proposal (SPEC §6, T12): stored pending and disabled. Only the fields a player may
     * send are read; timer, maxChoices and enabled take their defaults.
     * Throws ValidationError (smartdumb, limit of pending proposals, invalid fields).
     */
    createProposal(input, proposedBy) {
      const body = requireObject(input);
      if (body.type === 'smartdumb') fail(SMARTDUMB_PROPOSAL_ERROR);
      if (body.type === 'which') fail(WHICH_PROPOSAL_ERROR);
      if (countPending(proposedBy) >= MAX_PENDING_PROPOSALS) {
        fail(`Tu as déjà ${MAX_PENDING_PROPOSALS} propositions en attente`);
      }
      const question = {
        ...normalizeQuestion(
          {
            type: body.type,
            text: body.text,
            subjects: body.subjects,
            options: body.options,
            polarity: body.polarity,
            // A proposal never picks: a guess on players offers the connected players ('online').
            guessPlayers: 'online',
          },
          newQuestionId(),
        ),
        maxChoices: null,
        enabled: false,
        pending: true,
        proposedBy,
      };
      persistQuestions([...questions, question]);
      return structuredClone(question);
    },

    /** Pending proposals, oldest first. Includes proposedBy: the caller decides who sees it. */
    listPendingProposals() {
      return questions.filter((q) => q.pending).map((q) => structuredClone(q));
    },

    countPendingProposals(playerId) {
      return countPending(playerId);
    },

    /** Validates a pending question: pending false, enabled true. Returns null if not found or not pending. */
    acceptProposal(id) {
      const index = questions.findIndex((q) => q.id === id && q.pending);
      if (index === -1) return null;
      const next = questions.slice();
      next[index] = { ...questions[index], pending: false, enabled: true };
      persistQuestions(next);
      return structuredClone(next[index]);
    },

    /** Refuses a pending question: it is deleted. Returns false if not found or not pending. */
    rejectProposal(id) {
      if (!questions.some((q) => q.id === id && q.pending)) return false;
      persistQuestions(questions.filter((q) => q.id !== id));
      return true;
    },

    getSettings() {
      return structuredClone(settings);
    },

    updateSettings(input) {
      const next = normalizeSettings(input);
      writeFileAtomic(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
      settings = next;
      return structuredClone(settings);
    },

    playableQuestions() {
      return questions
        .filter((question) => isPlayable(question, settings))
        .map((question) => structuredClone(question));
    },

    questionCount() {
      const playable = questions.filter((question) => isPlayable(question, settings)).length;
      return Math.min(settings.questionLimit ?? Infinity, playable);
    },
  };
}
