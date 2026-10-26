// Débrief de fin de partie (SPEC §6, T10). Fonctions pures : historique de la partie + roster -> titres.
//
// Historique : tableau de manches, une par round terminé (écrit par src/game.js) :
//   { question: { id, type, subjects, polarity }, participants: [playerId],
//     items: [...], answers: [{ playerId, stage, answer, answeredMs }], results,
//     anecdote: null | { matched, authors, anecdotes: [{ id, text, authorId }] } }
// `stage` vaut null hors anecdote ; `answer` est la réponse normalisée (SPEC §5).

export const DEBRIEF_MAX_TITLES = 5;

const EPSILON = 1e-9;
const TIER_RAW = { S: 2, A: 1, B: 0, C: -1, D: -2 };
// Kinds of judgement: 'vote' (QCU/QCM), 'rank' (classement), 'tier' (tierlist), 'smart' / 'dumb' (Intelligent / Débile).
const VOTE_KINDS = ['vote', 'smart', 'dumb'];
const CLASSEMENT_KINDS = ['rank', 'tier'];
const MIN_ANSWERS_FOR_AVERAGE = 2;

/**
 * Judgement of `voter` about `target` on a positive scale running from `bottom` to `top`.
 * In a negative question the value is inverted, and so are the best and worst roles (SPEC §6):
 * the first place, S or a vote is then bad, the last place or D is good.
 */
function judge({ voter, target, kind, raw, top, bottom, negative }) {
  return {
    voter,
    target,
    kind,
    value: negative ? -raw : raw,
    best: negative ? raw === bottom : raw === top,
    worst: negative ? raw === top : raw === bottom,
  };
}

/** Ids chosen in a QCU (one id) or QCM (several) answer. */
function choicesOf(question, answer) {
  return question.type === 'single' ? [answer.choice] : answer.choices;
}

/** Judgements given in one round. Only players-subject questions produce judgements. */
function judgementsOf(record) {
  const { question } = record;
  if (question.subjects !== 'players') return [];
  const negative = question.polarity === 'negative';
  const judgements = [];
  for (const { playerId: voter, answer } of record.answers) {
    switch (question.type) {
      case 'single':
      case 'multiple':
        for (const target of choicesOf(question, answer)) {
          judgements.push(judge({ voter, target, kind: 'vote', raw: 1, top: 1, bottom: 0, negative }));
        }
        break;
      case 'ranking': {
        const n = answer.order.length;
        if (n < 2) break;
        answer.order.forEach((target, p) => {
          if (target === null) return; // empty slot of a partial ranking (auto-saved draft): no judgement
          const raw = (n - 1 - 2 * p) / (n - 1);
          judgements.push(judge({ voter, target, kind: 'rank', raw, top: 1, bottom: -1, negative }));
        });
        break;
      }
      case 'tierlist':
        for (const [target, tier] of Object.entries(answer.tiers)) {
          judgements.push(judge({ voter, target, kind: 'tier', raw: TIER_RAW[tier], top: 2, bottom: -2, negative }));
        }
        break;
      case 'smartdumb':
        judgements.push(judge({ voter, target: answer.smart, kind: 'smart', raw: 1, top: 1, bottom: -1, negative }));
        judgements.push(judge({ voter, target: answer.dumb, kind: 'dumb', raw: -1, top: 1, bottom: -1, negative }));
        break;
      case 'guess':
      case 'which':
        // guess and which: the pick and the guesses are not judgements (no title for these types)
        break;
      default:
        // anecdote: texts and matches are not judgements
        break;
    }
  }
  return judgements;
}

/** Players eligible for titles: roster order, only those who took part in at least one round. */
function buildContext(history, roster) {
  const played = new Set(history.flatMap((record) => record.participants));
  return {
    history,
    pool: roster.map((entry) => entry.id).filter((id) => played.has(id)),
    judgements: history.flatMap(judgementsOf),
  };
}

/** Counts, for every pool player, the items whose `keyOf` designates that player (0 included). */
function countOver(pool, items, keyOf) {
  const counts = new Map(pool.map((id) => [id, 0]));
  for (const item of items) {
    const key = keyOf(item);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }
  return counts;
}

function countJudgements(ctx, select, keyOf) {
  return countOver(ctx.pool, ctx.judgements.filter(select), keyOf);
}

/** Mean value per key, keeping keys with at least `minCount` entries. */
function meanOf(entries, minCount = 1) {
  const sums = new Map();
  for (const { key, value } of entries) {
    const acc = sums.get(key) ?? { sum: 0, count: 0 };
    acc.sum += value;
    acc.count += 1;
    sums.set(key, acc);
  }
  const means = new Map();
  for (const [key, { sum, count }] of sums) {
    if (count >= minCount) means.set(key, sum / count);
  }
  return means;
}

// --- Per-player measures: each returns a Map playerId -> value ---

const worstGiven = (ctx) => countJudgements(ctx, (j) => j.worst, (j) => j.voter);
const bestGiven = (ctx) => countJudgements(ctx, (j) => j.best, (j) => j.voter);
const selfBest = (ctx) => countJudgements(ctx, (j) => j.best && j.voter === j.target, (j) => j.voter);
const votesReceived = (ctx) => countJudgements(ctx, (j) => VOTE_KINDS.includes(j.kind), (j) => j.target);

function meanClassementReceived(ctx) {
  const entries = ctx.judgements
    .filter((j) => CLASSEMENT_KINDS.includes(j.kind) && ctx.pool.includes(j.target))
    .map((j) => ({ key: j.target, value: j.value }));
  return meanOf(entries);
}

/** Rounds where a QCU/QCM winning choice exists: the single top row, with at least one vote. */
function choiceRounds(ctx) {
  return ctx.history.filter((record) => record.question.type === 'single' || record.question.type === 'multiple');
}

function winningChoice(record) {
  const rows = record.results.rows;
  const top = Math.max(...rows.map((row) => row.count));
  const leaders = rows.filter((row) => row.count === top);
  return top > 0 && leaders.length === 1 ? leaders[0].itemId : null;
}

/** Times a player picked the winning choice of a QCU/QCM round (any subjects). */
function winnerChoices(ctx) {
  const counts = new Map(ctx.pool.map((id) => [id, 0]));
  for (const record of choiceRounds(ctx)) {
    const winner = winningChoice(record);
    if (winner === null) continue;
    for (const { playerId, answer } of record.answers) {
      if (choicesOf(record.question, answer).includes(winner) && counts.has(playerId)) {
        counts.set(playerId, counts.get(playerId) + 1);
      }
    }
  }
  return counts;
}

/** Times a player was alone on one of their choices in a QCU/QCM round with at least two voters. */
function soloChoices(ctx) {
  const counts = new Map(ctx.pool.map((id) => [id, 0]));
  for (const record of choiceRounds(ctx)) {
    if (record.results.voters < 2) continue;
    const votesFor = new Map(record.results.rows.map((row) => [row.itemId, row.count]));
    for (const { playerId, answer } of record.answers) {
      const alone = choicesOf(record.question, answer).some((id) => votesFor.get(id) === 1);
      if (alone && counts.has(playerId)) counts.set(playerId, counts.get(playerId) + 1);
    }
  }
  return counts;
}

/** Mean answer delay in ms, over every answer of the player (SPEC T10: needs at least 2 answers). */
function meanDelayMs(ctx) {
  const entries = ctx.history
    .flatMap((record) => record.answers)
    .filter((answer) => ctx.pool.includes(answer.playerId))
    .map((answer) => ({ key: answer.playerId, value: answer.answeredMs }));
  return meanOf(entries, MIN_ANSWERS_FOR_AVERAGE);
}

/** Rounds where a participant gave no answer at all. */
function missedRounds(ctx) {
  const counts = new Map(ctx.pool.map((id) => [id, 0]));
  for (const record of ctx.history) {
    const answered = new Set(record.answers.map((answer) => answer.playerId));
    for (const playerId of record.participants) {
      if (!answered.has(playerId) && counts.has(playerId)) counts.set(playerId, counts.get(playerId) + 1);
    }
  }
  return counts;
}

function anecdoteRounds(ctx) {
  return ctx.history.filter((record) => record.anecdote?.matched);
}

/** Good associations (author found) over every matched anecdote round. */
function correctMatches(ctx) {
  const counts = new Map(ctx.pool.map((id) => [id, 0]));
  for (const record of anecdoteRounds(ctx)) {
    for (const score of record.results.scores) {
      if (counts.has(score.playerId)) counts.set(score.playerId, counts.get(score.playerId) + score.correct);
    }
  }
  return counts;
}

/** Mean number of players who found each author's anecdotes, over matched rounds. */
function foundPerAnecdote(ctx) {
  const entries = [];
  for (const record of anecdoteRounds(ctx)) {
    for (const anecdote of record.results.anecdotes) {
      entries.push({ key: anecdote.authorId, value: anecdote.foundBy.length });
    }
  }
  const means = meanOf(entries);
  return new Map([...means].filter(([playerId]) => ctx.pool.includes(playerId)));
}

// --- Pair measure (Les amoureux): candidates are ordered pairs' minimum, not single players ---

/**
 * One candidate per unordered pair of pool players: value = min(best judgements a gave b,
 * best judgements b gave a). A one-sided affection gives 0.
 */
function reciprocalPairs(ctx) {
  const given = new Map(ctx.pool.map((id) => [id, new Map()]));
  for (const judgement of ctx.judgements) {
    if (!judgement.best || judgement.voter === judgement.target) continue;
    const row = given.get(judgement.voter);
    if (!row) continue;
    row.set(judgement.target, (row.get(judgement.target) ?? 0) + 1);
  }
  const pairs = [];
  ctx.pool.forEach((a, i) => {
    for (const b of ctx.pool.slice(i + 1)) {
      const value = Math.min(given.get(a).get(b) ?? 0, given.get(b).get(a) ?? 0);
      pairs.push({ playerId: a, partnerId: b, value });
    }
  });
  return pairs;
}

// --- Measures attached to titles ---

/** Wraps a Map playerId -> value into candidates. */
const perPlayer = (values) => (ctx) => [...values(ctx)].map(([playerId, value]) => ({ playerId, value }));

// --- French formatting for `stat` ---

function countStat(n, singular, plural) {
  return `${n} ${n > 1 ? plural : singular}`;
}

function formatDecimal(x) {
  const rounded = Math.round(x * 10) / 10;
  return (rounded === 0 ? 0 : rounded).toFixed(1).replace('.', ',');
}

function formatSigned(x) {
  const rounded = Math.round(x * 10) / 10;
  if (rounded === 0) return '0,0';
  return `${rounded > 0 ? '+' : '-'}${formatDecimal(Math.abs(x))}`;
}

function formatSeconds(ms) {
  return `${formatDecimal(ms / 1000)} s en moyenne`;
}

// Table of titles, in attribution order (SPEC T10). `emoji` is shown on the débrief card.
// `direction` 'least' inverts the values; `counter` titles need a best value above 0 (direction 'most' only).
const TITLES = [
  {
    title: 'Le harceleur',
    emoji: '🔪',
    phrase: 'Chaque réponse était une trahison.',
    measures: [
      { candidates: perPlayer(worstGiven), direction: 'most', counter: true,
        stat: (n) => countStat(n, 'copain descendu', 'copains descendus') },
    ],
  },
  {
    title: 'Le lèche-bottes',
    emoji: '👢',
    phrase: 'Tout le monde est S à ses yeux. Même ceux qui ne le méritent pas.',
    measures: [
      { candidates: perPlayer(bestGiven), direction: 'most', counter: true,
        stat: (n) => countStat(n, 'copain encensé', 'copains encensés') },
    ],
  },
  {
    title: 'Le narcissique',
    emoji: '🪞',
    phrase: "Il s'est choisi lui-même. Sans trembler.",
    measures: [
      { candidates: perPlayer(selfBest), direction: 'most', counter: true,
        stat: (n) => countStat(n, 'bon jugement sur soi-même', 'bons jugements sur soi-même') },
    ],
  },
  {
    title: 'La star',
    emoji: '🌟',
    phrase: 'Toutes les questions menaient à lui.',
    measures: [
      { candidates: perPlayer(votesReceived), direction: 'most', counter: true,
        stat: (n) => countStat(n, 'vote reçu', 'votes reçus') },
    ],
  },
  {
    title: 'Le fantôme',
    emoji: '👻',
    phrase: 'Présent dans le groupe, absent dans les cœurs.',
    measures: [
      { candidates: perPlayer(votesReceived), direction: 'least', counter: true,
        stat: (n) => countStat(n, 'vote reçu', 'votes reçus') },
    ],
  },
  {
    title: 'Le chouchou',
    emoji: '🥰',
    phrase: "Le groupe l'a mis sur le podium partout.",
    measures: [
      { candidates: perPlayer(meanClassementReceived), direction: 'most', counter: false,
        stat: (n) => `Moyenne de ${formatSigned(n)} en classement` },
    ],
  },
  {
    title: 'Les amoureux',
    emoji: '💘',
    phrase: "Ils ne voient que l'un l'autre. Prenez une chambre.",
    pair: true,
    measures: [
      { candidates: reciprocalPairs, direction: 'most', counter: true,
        stat: (n) => countStat(n, 'coup de cœur réciproque', 'coups de cœur réciproques') },
    ],
  },
  {
    title: 'Le souffre-douleur',
    emoji: '🩹',
    phrase: 'Dernier de chaque classement. Courage.',
    measures: [
      { candidates: perPlayer(meanClassementReceived), direction: 'least', counter: false,
        stat: (n) => `Moyenne de ${formatSigned(n)} en classement` },
    ],
  },
  {
    title: 'Le mouton',
    emoji: '🐑',
    phrase: 'Toujours d\'accord avec la majorité.',
    measures: [
      { candidates: perPlayer(winnerChoices), direction: 'most', counter: true,
        stat: (n) => countStat(n, 'fois avec la majorité', 'fois avec la majorité') },
    ],
  },
  {
    title: 'Le rebelle',
    emoji: '🤘',
    phrase: 'Seul contre tous, et fier de l\'être.',
    measures: [
      { candidates: perPlayer(soloChoices), direction: 'most', counter: true,
        stat: (n) => countStat(n, 'fois seul sur son choix', 'fois seul sur son choix') },
    ],
  },
  {
    title: "L'éclair",
    emoji: '⚡',
    phrase: "Répond avant d'avoir lu la question.",
    measures: [
      { candidates: perPlayer(meanDelayMs), direction: 'least', counter: false, stat: formatSeconds },
    ],
  },
  {
    title: 'Le procrastinateur',
    emoji: '🐌',
    phrase: 'A attendu la dernière seconde. À chaque fois.',
    // Second measure is the fallback when the delay gives no significant winner.
    measures: [
      { candidates: perPlayer(meanDelayMs), direction: 'most', counter: false, stat: formatSeconds },
      { candidates: perPlayer(missedRounds), direction: 'most', counter: true,
        stat: (n) => countStat(n, 'manche sans réponse', 'manches sans réponse') },
    ],
  },
  {
    title: 'Le détective',
    emoji: '🔍',
    phrase: 'Il sait qui a écrit quoi. Inquiétant.',
    measures: [
      { candidates: perPlayer(correctMatches), direction: 'most', counter: true,
        stat: (n) => countStat(n, 'bonne association', 'bonnes associations') },
    ],
  },
  {
    title: "L'insoupçonnable",
    emoji: '🤫',
    phrase: "Personne n'a reconnu son anecdote.",
    measures: [
      { candidates: perPlayer(foundPerAnecdote), direction: 'least', counter: false,
        stat: (n) => `Trouvée en moyenne par ${formatDecimal(n)} ${n >= 2 ? 'joueurs' : 'joueur'}` },
    ],
  },
  {
    title: 'Le livre ouvert',
    emoji: '📖',
    phrase: "Son anecdote, tout le monde l'a devinée.",
    measures: [
      { candidates: perPlayer(foundPerAnecdote), direction: 'most', counter: false,
        stat: (n) => `Trouvée en moyenne par ${formatDecimal(n)} ${n >= 2 ? 'joueurs' : 'joueur'}` },
    ],
  },
];

/**
 * Winner of one measure, or null. Significance = (best - second) / (max - min) over the signed
 * values; 0 (tie at the top, or all values equal) drops the title. Needs at least 2 candidates.
 */
function significantWinner(candidates, { direction, counter }) {
  const sign = direction === 'most' ? 1 : -1;
  const ranked = candidates
    .filter((candidate) => Number.isFinite(candidate.value))
    .map((candidate) => ({ ...candidate, score: sign * candidate.value }))
    .sort((a, b) => b.score - a.score); // stable: ties keep roster order
  if (ranked.length < 2) return null;

  const [best, second] = ranked;
  const scores = ranked.map((candidate) => candidate.score);
  const range = Math.max(...scores) - Math.min(...scores);
  if (range <= EPSILON) return null;
  const significance = (best.score - second.score) / range;
  if (significance <= EPSILON) return null;
  if (counter && direction === 'most' && best.value <= 0) return null;
  return { winner: best, significance };
}

/** Title candidate for one table entry: the first measure with a significant winner, or null. */
function evaluateTitle(entry, ctx) {
  for (const measure of entry.measures) {
    const found = significantWinner(measure.candidates(ctx), measure);
    if (found) {
      const { winner, significance } = found;
      return {
        playerId: winner.playerId,
        partnerId: entry.pair ? winner.partnerId : undefined,
        stat: measure.stat(winner.value),
        significance,
      };
    }
  }
  return null;
}

/**
 * Every title with a significant winner, before the cap, sorted by significance (ties: table order).
 * A player may hold several titles. Used by computeDebrief and by the tests.
 * @returns {{ playerId: string, partnerId?: string, title: string, emoji: string, phrase: string, stat: string, significance: number }[]}
 */
export function titleCandidates(history, roster) {
  const ctx = buildContext(history, roster);
  const found = [];
  TITLES.forEach((entry, tableIndex) => {
    const candidate = evaluateTitle(entry, ctx);
    if (candidate) {
      found.push({ ...candidate, title: entry.title, emoji: entry.emoji, phrase: entry.phrase, tableIndex });
    }
  });
  return found.sort((a, b) => b.significance - a.significance || a.tableIndex - b.tableIndex);
}

/**
 * Débrief (SPEC §6): at most DEBRIEF_MAX_TITLES titles, by decreasing significance, never more than
 * the number of players. `partnerId` is only present for « Les amoureux ».
 * @returns {{ playerId: string, partnerId?: string, title: string, emoji: string, phrase: string, stat: string }[]}
 */
export function computeDebrief(history, roster) {
  const ctx = buildContext(history, roster);
  const limit = Math.min(DEBRIEF_MAX_TITLES, ctx.pool.length);
  return titleCandidates(history, roster)
    .slice(0, limit)
    .map(({ playerId, partnerId, title, emoji, phrase, stat }) =>
      partnerId === undefined
        ? { playerId, title, emoji, phrase, stat }
        : { playerId, partnerId, title, emoji, phrase, stat },
    );
}
