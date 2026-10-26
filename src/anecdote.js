// Question type « anecdote » (SPEC §5, §6; T9): pure functions, no I/O.
// Three stages: write (one text per participant), read (anonymous, shuffled), match (who wrote what).
// The game engine (src/game.js) owns the stages, the timers and the storage.

export const ANECDOTE_MAX_LENGTH = 280;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates a write answer `{ text }`. The text is trimmed; it must be 1..280 characters
 * (JS string length, the same count as a textarea's maxlength).
 * @returns {{ text: string }} the normalized answer
 * @throws {Error} with a French message
 */
export function validateWrite(answer) {
  if (!isPlainObject(answer)) throw new Error('Réponse invalide');
  if (typeof answer.text !== 'string') throw new Error("Le texte de l'anecdote est requis");
  const text = answer.text.trim();
  if (text.length === 0) throw new Error("L'anecdote ne peut pas être vide");
  if (text.length > ANECDOTE_MAX_LENGTH) {
    throw new Error(`L'anecdote doit faire au maximum ${ANECDOTE_MAX_LENGTH} caractères`);
  }
  return { text };
}

/**
 * Validates a match answer `{ matches: { [anecdoteId]: authorId } }` against what this player may
 * match: `anecdoteIds` = every anecdote except their own, `authorIds` = every author except themselves.
 * The keys must be exactly `anecdoteIds`, the values must be distinct `authorIds`, and every author
 * must be used once (a bijection, since each author wrote exactly one anecdote).
 * @param {unknown} answer
 * @param {{ anecdoteIds: string[], authorIds: string[] }} domain
 * @returns {{ matches: Record<string, string> }} the normalized answer
 * @throws {Error} with a French message
 */
export function validateMatch(answer, { anecdoteIds, authorIds }) {
  if (!isPlainObject(answer) || !isPlainObject(answer.matches)) throw new Error('Réponse invalide');
  const { matches } = answer;
  const anecdoteSet = new Set(anecdoteIds);
  const authorSet = new Set(authorIds);

  for (const key of Object.keys(matches)) {
    if (!anecdoteSet.has(key)) throw new Error('Anecdote inconnue');
  }
  for (const id of anecdoteIds) {
    if (!Object.hasOwn(matches, id)) throw new Error('Chaque anecdote doit être reliée à un auteur');
  }

  const used = new Set();
  const normalized = {};
  for (const id of anecdoteIds) {
    const authorId = matches[id];
    if (typeof authorId !== 'string' || !authorSet.has(authorId)) throw new Error('Auteur inconnu');
    if (used.has(authorId)) throw new Error("Chaque auteur ne peut être relié qu'à une seule anecdote");
    used.add(authorId);
    normalized[id] = authorId;
  }
  if (used.size !== authorSet.size) throw new Error('Chaque auteur doit être relié à une anecdote');

  return { matches: normalized };
}

/**
 * Validates a PARTIAL match answer, kept as a draft (SPEC §6, brouillons): a non-empty subset of the
 * anecdotes, each linked to a distinct author among `authorIds`. Same domain as validateMatch.
 * @returns {{ matches: Record<string, string> }} the normalized partial answer
 * @throws {Error} with a French message
 */
export function validatePartialMatch(answer, { anecdoteIds, authorIds }) {
  if (!isPlainObject(answer) || !isPlainObject(answer.matches)) throw new Error('Réponse invalide');
  const { matches } = answer;
  const anecdoteSet = new Set(anecdoteIds);
  const authorSet = new Set(authorIds);
  const keys = Object.keys(matches);
  if (keys.length === 0) throw new Error('Relie au moins une anecdote');

  const used = new Set();
  const normalized = {};
  for (const id of keys) {
    if (!anecdoteSet.has(id)) throw new Error('Anecdote inconnue');
    const authorId = matches[id];
    if (typeof authorId !== 'string' || !authorSet.has(authorId)) throw new Error('Auteur inconnu');
    if (used.has(authorId)) throw new Error("Chaque auteur ne peut être relié qu'à une seule anecdote");
    used.add(authorId);
    normalized[id] = authorId;
  }
  return { matches: normalized };
}

/**
 * Results of an anecdote round, revealed in phase results (SPEC §5).
 * @param {{ id: string, text: string, authorId: string }[]} anecdotes in reading order
 * @param {Map<string, { matches: Record<string, string> }>} matches playerId -> normalized match answer (validateMatch, or validatePartialMatch for a draft)
 * @param {string[]} playerIds scored players in participant order; [] when no match stage ran
 * @param {Set<string>} [incompleteIds] players whose match answer is partial (auto-saved draft)
 * @returns {{ kind: 'anecdote', anecdotes: { id, text, authorId, foundBy: string[] }[], scores: { playerId, correct, total, incomplete: boolean }[] }}
 *   `total` = anecdotes the player had to link (every anecdote except their own); only the given
 *   associations count as correct; `scores` sorted by `correct` desc, ties in `playerIds` order.
 */
export function computeAnecdoteResults(anecdotes, matches, playerIds, incompleteIds = new Set()) {
  const isCorrect = (playerId, anecdote) =>
    anecdote.authorId !== playerId && matches.get(playerId)?.matches?.[anecdote.id] === anecdote.authorId;

  const results = anecdotes.map((anecdote) => ({
    id: anecdote.id,
    text: anecdote.text,
    authorId: anecdote.authorId,
    foundBy: playerIds.filter((playerId) => isCorrect(playerId, anecdote)),
  }));

  const scores = playerIds.map((playerId) => {
    const expected = anecdotes.filter((anecdote) => anecdote.authorId !== playerId);
    return {
      playerId,
      correct: expected.filter((anecdote) => isCorrect(playerId, anecdote)).length,
      total: expected.length,
      incomplete: incompleteIds.has(playerId),
    };
  });
  scores.sort((a, b) => b.correct - a.correct); // Array.prototype.sort is stable

  return { kind: 'anecdote', anecdotes: results, scores };
}
