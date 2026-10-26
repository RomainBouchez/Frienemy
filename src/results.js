// Fonctions pures : validation des réponses et agrégation des résultats (SPEC §5).
// Aucune dépendance, aucune I/O.

export const TIERS = ['S', 'A', 'B', 'C', 'D'];

const QUESTION_TYPES = ['single', 'multiple', 'ranking', 'smartdumb', 'tierlist', 'guess', 'which'];
const TIER_POINTS = { S: 5, A: 4, B: 3, C: 2, D: 1 };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertQuestion(question) {
  if (!isPlainObject(question) || !QUESTION_TYPES.includes(question.type)) {
    throw new Error('Type de question inconnu');
  }
}

function assertItems(items) {
  if (!Array.isArray(items)) throw new Error("Liste d'éléments invalide");
}

function assertItemId(id, itemIds) {
  if (typeof id !== 'string') throw new Error("Identifiant d'élément invalide");
  if (!itemIds.has(id)) throw new Error('Élément inconnu');
}

// Arrondi à 1 décimale (demi vers le haut) en arithmétique entière : sum et count sont des entiers.
function roundTenth(sum, count) {
  return Math.round((sum * 10) / count) / 10;
}

// Niveau attribué à partir de la moyenne arrondie (déjà à 1 décimale).
function tierFor(avg) {
  if (avg >= 4.5) return 'S';
  if (avg >= 3.5) return 'A';
  if (avg >= 2.5) return 'B';
  if (avg >= 1.5) return 'C';
  return 'D';
}

// Ordre croissant, null en dernier.
function compareNullableAsc(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

// Ordre décroissant, null en dernier.
function compareNullableDesc(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Valide une réponse et renvoie sa forme normalisée (seuls les champs attendus).
 * Lève une Error au message français si la réponse est invalide.
 */
export function validateAnswer(question, items, answer) {
  assertQuestion(question);
  assertItems(items);
  if (!isPlainObject(answer)) throw new Error('Réponse invalide');
  const itemIds = new Set(items.map((item) => item.id));

  switch (question.type) {
    // guess and which: the target's pick and the guesses are single choices too (SPEC guess round).
    // A which pick of answerKind 'text' is not a choice: see validateWhichText.
    case 'single':
    case 'guess':
    case 'which': {
      assertItemId(answer.choice, itemIds);
      return { choice: answer.choice };
    }

    case 'multiple': {
      const { choices } = answer;
      if (!Array.isArray(choices)) throw new Error('Les choix doivent être une liste');
      if (choices.length === 0) throw new Error('Choisis au moins un élément');
      if (typeof question.maxChoices === 'number' && choices.length > question.maxChoices) {
        throw new Error(`Tu peux choisir au maximum ${question.maxChoices} élément(s)`);
      }
      const seen = new Set();
      for (const id of choices) {
        assertItemId(id, itemIds);
        if (seen.has(id)) throw new Error('Chaque élément ne peut apparaître qu\'une fois');
        seen.add(id);
      }
      return { choices: [...choices] };
    }

    case 'ranking': {
      const { order } = answer;
      if (!Array.isArray(order)) throw new Error('Le classement doit être une liste');
      if (order.length !== items.length) {
        throw new Error('Le classement doit contenir chaque élément exactement une fois');
      }
      const seen = new Set();
      for (const id of order) {
        assertItemId(id, itemIds);
        if (seen.has(id)) throw new Error('Chaque élément ne peut apparaître qu\'une fois');
        seen.add(id);
      }
      return { order: [...order] };
    }

    case 'smartdumb': {
      assertItemId(answer.smart, itemIds);
      assertItemId(answer.dumb, itemIds);
      if (answer.smart === answer.dumb) {
        throw new Error('Le plus intelligent et le plus débile doivent être deux personnes différentes');
      }
      return { smart: answer.smart, dumb: answer.dumb };
    }

    case 'tierlist': {
      const { tiers } = answer;
      if (!isPlainObject(tiers)) throw new Error('Les niveaux doivent être un objet');
      for (const [id, tier] of Object.entries(tiers)) {
        if (!itemIds.has(id)) throw new Error('Élément inconnu');
        if (!TIERS.includes(tier)) throw new Error(`Niveau invalide (attendu : ${TIERS.join(', ')})`);
      }
      const normalized = {};
      for (const item of items) {
        if (!Object.hasOwn(tiers, item.id)) {
          throw new Error('Chaque élément doit être classé exactement une fois');
        }
        normalized[item.id] = tiers[item.id];
      }
      return { tiers: normalized };
    }
  }
}

export const WHICH_TEXT_MAX_LENGTH = 80;

/**
 * Validates the target's pick of a which round with answerKind 'text': `{ text }`, trimmed, 1..80
 * characters. Returns the normalized answer, or throws an Error with a French message.
 */
export function validateWhichText(answer) {
  if (!isPlainObject(answer)) throw new Error('Réponse invalide');
  if (typeof answer.text !== 'string') throw new Error('La réponse est requise');
  const text = answer.text.trim();
  if (text.length === 0) throw new Error('La réponse ne peut pas être vide');
  if (text.length > WHICH_TEXT_MAX_LENGTH) {
    throw new Error(`La réponse doit faire au maximum ${WHICH_TEXT_MAX_LENGTH} caractères`);
  }
  return { text };
}

/**
 * Validates a PARTIAL answer, kept as a draft (SPEC §6, brouillons). Only ranking and tierlist accept
 * one: ranking `{ order: (id|null)[] }` with one slot per item, at least one placed item (a slot is
 * its rank); tierlist `{ tiers }` over a non-empty subset of known items. Returns the normalized
 * answer, or throws an Error with a French message. Complete answers go through validateAnswer.
 */
export function validatePartialAnswer(question, items, answer) {
  assertQuestion(question);
  assertItems(items);
  if (!isPlainObject(answer)) throw new Error('Réponse invalide');
  const itemIds = new Set(items.map((item) => item.id));

  switch (question.type) {
    case 'ranking': {
      const { order } = answer;
      if (!Array.isArray(order)) throw new Error('Le classement doit être une liste');
      if (order.length !== items.length) {
        throw new Error('Le classement doit contenir un emplacement par élément');
      }
      const seen = new Set();
      for (const id of order) {
        if (id === null) continue; // empty slot
        assertItemId(id, itemIds);
        if (seen.has(id)) throw new Error("Chaque élément ne peut apparaître qu'une fois");
        seen.add(id);
      }
      if (seen.size === 0) throw new Error('Place au moins un élément');
      return { order: [...order] };
    }

    case 'tierlist': {
      const { tiers } = answer;
      if (!isPlainObject(tiers)) throw new Error('Les niveaux doivent être un objet');
      const entries = Object.entries(tiers);
      if (entries.length === 0) throw new Error('Classe au moins un élément');
      for (const [id, tier] of entries) {
        if (!itemIds.has(id)) throw new Error('Élément inconnu');
        if (!TIERS.includes(tier)) throw new Error(`Niveau invalide (attendu : ${TIERS.join(', ')})`);
      }
      return { tiers: Object.fromEntries(entries) };
    }

    default:
      throw new Error("Cette question n'accepte pas de réponse partielle");
  }
}

// Compte les votes reçus par item ; votesPerAnswer = un tableau d'ids votés par réponse.
function countResults(items, votesPerAnswer) {
  const counts = new Map(items.map((item) => [item.id, 0]));
  for (const votedIds of votesPerAnswer) {
    for (const id of votedIds) counts.set(id, counts.get(id) + 1);
  }
  const rows = items.map((item) => ({ itemId: item.id, count: counts.get(item.id) }));
  rows.sort((a, b) => b.count - a.count); // sort stable : égalités = ordre des items
  return { kind: 'counts', voters: votesPerAnswer.length, rows };
}

// Partial rankings (drafts): a null slot is skipped. avgRank and the average tier are taken over the
// answers that placed the item, so a complete answer keeps the same numbers as before.
function rankingResults(items, answers) {
  const voters = answers.length;
  const n = items.length;
  const sumRanks = new Map(items.map((item) => [item.id, 0]));
  const placed = new Map(items.map((item) => [item.id, 0]));
  const points = new Map(items.map((item) => [item.id, 0]));
  for (const { order } of answers) {
    order.forEach((id, p) => {
      if (id === null) return;
      sumRanks.set(id, sumRanks.get(id) + (p + 1));
      placed.set(id, placed.get(id) + 1);
      points.set(id, points.get(id) + (n - 1 - p));
    });
  }
  const rows = items.map((item) => ({
    itemId: item.id,
    avgRank: placed.get(item.id) === 0 ? null : roundTenth(sumRanks.get(item.id), placed.get(item.id)),
    points: points.get(item.id),
  }));
  rows.sort((a, b) => compareNullableAsc(a.avgRank, b.avgRank) || b.points - a.points);
  return { kind: 'ranking', voters, rows };
}

function tierlistResults(items, answers) {
  const voters = answers.length;
  const sums = new Map(items.map((item) => [item.id, 0]));
  const rated = new Map(items.map((item) => [item.id, 0]));
  for (const { tiers } of answers) {
    for (const item of items) {
      if (!Object.hasOwn(tiers, item.id)) continue; // partial tier list (draft)
      sums.set(item.id, sums.get(item.id) + TIER_POINTS[tiers[item.id]]);
      rated.set(item.id, rated.get(item.id) + 1);
    }
  }
  const rows = items.map((item) => {
    const avg = rated.get(item.id) === 0 ? null : roundTenth(sums.get(item.id), rated.get(item.id));
    return { itemId: item.id, avg, tier: avg === null ? null : tierFor(avg) };
  });
  rows.sort((a, b) => compareNullableDesc(a.avg, b.avg));
  return { kind: 'tierlist', voters, rows };
}

/**
 * Agrège des réponses déjà validées par validateAnswer().
 * Tous les items apparaissent dans rows ; égalités = ordre des items.
 */
export function computeResults(question, items, answers) {
  assertQuestion(question);
  assertItems(items);
  if (!Array.isArray(answers)) throw new Error('Réponses invalides');

  switch (question.type) {
    case 'single':
      return countResults(items, answers.map((a) => [a.choice]));
    case 'multiple':
      return countResults(items, answers.map((a) => a.choices));
    case 'smartdumb':
      // Smart et dumb sont additionnés ; le détail du split n'est jamais exposé.
      return countResults(items, answers.map((a) => [a.smart, a.dumb]));
    case 'ranking':
      return rankingResults(items, answers);
    case 'tierlist':
      return tierlistResults(items, answers);
  }
}

/**
 * Results of a guess round (contract `guess-contract.md`). `pickAnswer` is the target's pick answer
 * `{ choice }` or null (no answer: `answer` is null and nobody is scored). `guesses` maps each guesser who
 * answered to `{ choice }`; `order` is the participant order, used for `foundBy`.
 * `rows` follow the item order (not sorted); `guessers` is the number of guesses given.
 */
export function computeGuessResults({ items, targetId, pickAnswer, guesses, order }) {
  const answer = pickAnswer?.choice ?? null;
  const counts = new Map(items.map((item) => [item.id, 0]));
  for (const { choice } of guesses.values()) {
    if (counts.has(choice)) counts.set(choice, counts.get(choice) + 1);
  }
  const rows = items.map((item) => ({ itemId: item.id, count: counts.get(item.id) }));
  const foundBy =
    answer === null ? [] : order.filter((playerId) => guesses.get(playerId)?.choice === answer);
  return { kind: 'guess', targetId, answer, rows, foundBy, guessers: guesses.size };
}

/**
 * Public answer of the target in a which round (contract which): `{ kind: 'player', playerId }` for
 * answerKind 'player', `{ kind: 'text', text }` for 'text', null when the target gave none.
 */
export function whichAnswerOf(answerKind, pick) {
  if (!pick) return null;
  if (answerKind === 'text') return { kind: 'text', text: pick.text };
  return { kind: 'player', playerId: pick.choice };
}

/**
 * Results of a which round (contract which). `variants` are the items `{ id, label }` in question
 * order; `answer` is the target's public answer or null (no answer: nobody is scored). `guesses` maps
 * each guesser who answered to `{ choice }`; `order` is the participant order, used for `foundBy`.
 * `rows` follow the variant order (not sorted); `guessers` is the number of guesses given.
 */
export function computeWhichResults({ variants, secretVariantId, targetId, answer, guesses, order }) {
  const counts = new Map(variants.map((variant) => [variant.id, 0]));
  for (const { choice } of guesses.values()) {
    if (counts.has(choice)) counts.set(choice, counts.get(choice) + 1);
  }
  const rows = variants.map((variant) => ({ itemId: variant.id, count: counts.get(variant.id) }));
  const foundBy =
    answer === null ? [] : order.filter((playerId) => guesses.get(playerId)?.choice === secretVariantId);
  return { kind: 'which', targetId, secretVariantId, answer, rows, foundBy, guessers: guesses.size };
}
