// Results rendering (SPEC §10 item 5). Input: a round in the `results` phase (`round.results`,
// `round.items`, `round.question`) and the roster as `state.players` (names of the tierlist pages).
// Only what the server sends is used: no individual answers, except `results.perPlayer` for tierlist.
import { el, avatar } from './ui.js';
import { anecdoteResultsBody } from './anecdote-view.js';

const TIERS = ['S', 'A', 'B', 'C', 'D'];

/** Tierlist pager position per round: round.index -> { questionId, page }. Kept across re-renders. */
const pagerState = new Map();

/** French decimal comma: 2.3 -> "2,3". */
export function formatDecimal(value) {
  return value.toFixed(1).replace('.', ',');
}

function itemAvatar(item) {
  return typeof item.avatar === 'string' ? avatar(item, 40) : null;
}

/**
 * Vote-count rows. For QCU and QCM only, a winner block comes first when the top row has votes.
 * The caller wraps the returned nodes in a <div>, so the block is a <div> too.
 */
function countsRows(round, results, itemsById) {
  const max = Math.max(1, ...results.rows.map((row) => row.count));
  const rows = results.rows.map((row, index) => {
    const item = itemsById.get(row.itemId);
    const top = index === 0 && row.count > 0;
    const pct = (row.count / max) * 100;
    return el('div', { class: 'result-row' }, [
      itemAvatar(item),
      el('div', { class: 'result-row__body' }, [
        el('div', { class: 'result-row__head' }, [
          el('span', { class: 'result-row__label' }, item.label),
          top ? el('span', { class: 'badge' }, '1er') : null,
        ]),
        el('div', { class: 'bar' }, [
          el('div', {
            class: 'bar__fill' + (top ? ' is-top' : ''),
            style: { width: `${pct.toFixed(2)}%` },
          }),
        ]),
      ]),
      el('span', { class: 'result-row__count' }, String(row.count)),
    ]);
  });

  const leader = results.rows[0];
  const isChoice = round.question.type === 'single' || round.question.type === 'multiple';
  if (!isChoice || !leader || leader.count <= 0) return rows;

  const winner = itemsById.get(leader.itemId);
  const winnerBlock = el('div', { class: 'result-winner' }, [
    typeof winner.avatar === 'string' ? avatar(winner, 160) : null,
    el('span', { class: 'result-winner__name' }, winner.label),
    el('span', { class: 'result-winner__count' }, leader.count === 1 ? '1 vote' : `${leader.count} votes`),
  ]);
  return [winnerBlock, ...rows];
}

/**
 * Ranking results: the three first places on a podium (2e left, 1er centre, 3e right, each a vignette on its
 * step), then the other places as compact lines. No average is shown.
 */
function rankingBody(results, itemsById) {
  const order = [...itemsById.keys()];
  const entries = results.rows.map((row, index) => ({
    item: itemsById.get(row.itemId),
    rank: index + 1,
    colorIndex: order.indexOf(row.itemId) % 6,
  }));
  const podium = entries.slice(0, 3);
  const rest = entries.slice(3);
  return el('div', { class: 'rank-board' }, [
    podium.length > 0 ? el('ol', { class: 'rank-podium' }, podium.map(podiumPlace)) : null,
    rest.length > 0 ? el('ol', { class: 'rank-list' }, rest.map(rankingLine)) : null,
  ]);
}

/**
 * One podium place: a vignette (photo with the name on a red strip, or a coloured face with the text for a
 * proposal without photo) standing on its step, which carries the rank.
 */
function podiumPlace({ item, rank, colorIndex }) {
  const card =
    typeof item.avatar === 'string'
      ? el('div', { class: 'tile rank-podium__card' }, [
          avatar(item, 72),
          el('span', { class: 'tile__name' }, item.label),
        ])
      : el('div', { class: 'tile rank-podium__card' }, [
          el(
            'div',
            { class: 'rank-podium__face', style: { background: `var(--pill-${colorIndex + 1})` } },
            el('span', { class: 'rank-podium__face-label' }, item.label),
          ),
        ]);
  return el('li', { class: `rank-podium__place rank-podium__place--${rank}` }, [
    card,
    el('div', { class: 'rank-podium__step' }, [el('span', { class: 'rank-podium__num' }, String(rank))]),
  ]);
}

/** Places from the fourth on: rank, a small round photo (none for a proposal), the name. */
function rankingLine({ item, rank }) {
  return el('li', { class: 'rank-result' }, [
    el('span', { class: 'rank-result__num' }, String(rank)),
    typeof item.avatar === 'string' ? avatar(item, 32) : null,
    el('span', { class: 'rank-result__label' }, item.label),
  ]);
}

/** Tier rows of one player's own tierlist (`tiers: { [itemId]: tier }`), in round item order. */
function playerTierRows(tiers, itemsById) {
  return TIERS.map((tier) => {
    const members = [...itemsById.values()].filter((item) => tiers[item.id] === tier);
    return el('div', { class: 'tier-row' }, [
      el('div', { class: 'tier-row__label', 'data-tier': tier }, tier),
      el(
        'div',
        { class: 'tier-row__zone' },
        members.map((item) =>
          el('span', { class: 'chip chip--static' }, [
            typeof item.avatar === 'string' ? avatar(item, 32) : null,
            el('span', { class: 'chip__label' }, item.label),
          ]),
        ),
      ),
    ]);
  });
}

/**
 * Tierlist results: one page per player (`results.perPlayer`) with a pager, starting on the first one.
 * Without perPlayer (missing or empty), « Personne n'a répondu ».
 */
function tierlistBody(round, results, itemsById, players) {
  const perPlayer = Array.isArray(results.perPlayer) ? results.perPlayer : [];
  if (perPlayer.length === 0) {
    return el('p', { class: 'muted' }, "Personne n'a répondu");
  }

  const pages = [
    ...perPlayer.map((entry) => {
      const name = players.find((player) => player.id === entry.playerId)?.name ?? entry.playerId;
      return {
        title: `Tier list de ${name}`,
        incomplete: entry.incomplete === true,
        build: () => el('div', { class: 'results__tiers' }, playerTierRows(entry.tiers, itemsById)),
      };
    }),
  ];

  const memo = pagerState.get(round.index);
  let page = memo && memo.questionId === round.question.id ? memo.page : 0;
  if (page < 0 || page >= pages.length) page = 0;

  const title = el('p', { class: 'pager__title' });
  const indicator = el('span', { class: 'pager__indicator', 'aria-live': 'polite' });
  const content = el('div', { class: 'pager__page' });
  const prev = el('button', { type: 'button', class: 'pager__btn', 'aria-label': 'Page précédente' }, '←');
  const next = el('button', { type: 'button', class: 'pager__btn', 'aria-label': 'Page suivante' }, '→');

  const show = () => {
    pagerState.set(round.index, { questionId: round.question.id, page });
    title.textContent = pages[page].title;
    // « Réponse incomplète » next to the player's name: the tier list was not validated (SPEC §5).
    if (pages[page].incomplete) title.append(' ', el('span', { class: 'muted' }, 'Réponse incomplète'));
    indicator.textContent = `${page + 1} / ${pages.length}`;
    content.replaceChildren(pages[page].build());
    prev.disabled = page === 0;
    next.disabled = page === pages.length - 1;
  };
  const go = (delta) => {
    page = Math.min(Math.max(page + delta, 0), pages.length - 1);
    show();
  };
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  show();

  return el('div', { class: 'pager' }, [
    el('div', { class: 'pager__nav' }, [prev, indicator, next]),
    title,
    content,
  ]);
}

/** Target of a guess question: photo on a red name strip, centred (120 px, or the 72 px thumbnail). */
export function targetPortrait(target, small) {
  return el('div', { class: 'guess-target' + (small ? ' guess-target--small' : '') }, [
    avatar(target, small ? 72 : 120),
    el('span', { class: 'guess-target__name' }, target.name),
  ]);
}

/** Who the « Devine sa réponse » and « Quelle était la question ? » results name: the roster entry, or null. */
function playerFinder(players) {
  return (id) => players.find((player) => player.id === id) ?? null;
}

/**
 * Answer of a which question (contract which): the copain's photo on a sticker, or the text on a white
 * card. `answer` is `{ kind: 'player', playerId, … }` or `{ kind: 'text', text }`; null gives null.
 * The guess stage passes `round.whichAnswer` (name and photo included), the results pass the bare id.
 */
export function whichAnswerNode(answer, players = []) {
  if (!answer) return null;
  if (answer.kind === 'text') {
    return el('div', { class: 'which-answer' }, el('p', { class: 'which-answer__text' }, answer.text));
  }
  const player = playerFinder(players)(answer.playerId) ?? answer;
  return el('div', { class: 'result-winner result-winner--player' }, [
    avatar(player, 160),
    el('span', { class: 'result-winner__name' }, player.name ?? '?'),
  ]);
}

/** « Trouvé par » with the finders' heads, or « Personne n'a trouvé ». Shared by guess and which results. */
function foundBlock(finders) {
  return el('div', { class: 'guess-found' }, [
    el('p', { class: 'eyebrow' }, 'Trouvé par'),
    finders.length === 0
      ? el('p', { class: 'muted' }, "Personne n'a trouvé")
      : el('div', { class: 'guess-found__heads' }, finders.map((player) => avatar(player, 40))),
  ]);
}

/**
 * Distribution of the guesses (`results.rows`): the right answer leads (its bar is the top one), then the
 * other choices in item order. Shared by guess and which results.
 */
function guessRows(results, itemsById, correctId) {
  const max = Math.max(1, ...results.rows.map((row) => row.count));
  const ordered = [
    ...results.rows.filter((row) => row.itemId === correctId),
    ...results.rows.filter((row) => row.itemId !== correctId),
  ];
  return ordered.map((row) => {
    const item = itemsById.get(row.itemId);
    const top = row.itemId === correctId;
    return el('div', { class: 'result-row' }, [
      itemAvatar(item),
      el('div', { class: 'result-row__body' }, [
        el('div', { class: 'result-row__head' }, [el('span', { class: 'result-row__label' }, item.label)]),
        el('div', { class: 'bar' }, [
          el('div', {
            class: 'bar__fill' + (top ? ' is-top' : ''),
            style: { width: `${((row.count / max) * 100).toFixed(2)}%` },
          }),
        ]),
      ]),
      el('span', { class: 'result-row__count' }, String(row.count)),
    ]);
  });
}

/** « 1 devineur » / « N devineurs ». */
function guessersLabel(count) {
  return count > 1 ? `${count} devineurs` : `${count} devineur`;
}

/**
 * « Devine sa réponse » results (contract guess): « {nom} a répondu », the answer as the winner sticker,
 * « Trouvé par » with the finders' heads, then the guesses (the right answer first), then the guesser count.
 * No answer: the target and « n'a pas répondu à temps ».
 */
function guessResultsBody(round, results, players) {
  const itemsById = new Map(round.items.map((item) => [item.id, item]));
  const findPlayer = playerFinder(players);
  const target = findPlayer(results.targetId) ?? round.target ?? { name: '?', avatar: null, color: null };

  if (results.answer === null) {
    return el('div', { class: 'results' }, [
      targetPortrait(target, false),
      el('p', { class: 'muted' }, `${target.name} n'a pas répondu à temps.`),
    ]);
  }

  const answer = itemsById.get(results.answer);
  const finders = (results.foundBy ?? []).map(findPlayer).filter(Boolean);
  const guessers = results.guessers ?? 0;

  return el('div', { class: 'results' }, [
    el('p', { class: 'guess-status' }, `${target.name} a répondu`),
    el('div', { class: 'result-winner' }, [
      typeof answer.avatar === 'string' ? avatar(answer, 160) : null,
      el('span', { class: 'result-winner__name' }, answer.label),
    ]),
    foundBlock(finders),
    el('div', { class: 'results__rows' }, guessRows(results, itemsById, results.answer)),
    el('p', { class: 'muted' }, guessersLabel(guessers)),
  ]);
}

/**
 * « Quelle était la question ? » results (contract which): « La question de {nom} était : » with the secret
 * variant as the winner sticker, then her answer (photo or text), « Trouvé par », the guesses (the right
 * variant marked), the guesser count. No answer: the target and « n'a pas répondu à temps ».
 */
function whichResultsBody(round, results, players) {
  const itemsById = new Map(round.items.map((item) => [item.id, item]));
  const findPlayer = playerFinder(players);
  const target = findPlayer(results.targetId) ?? round.target ?? { name: '?', avatar: null, color: null };

  if (results.answer === null) {
    return el('div', { class: 'results' }, [
      targetPortrait(target, false),
      el('p', { class: 'muted' }, `${target.name} n'a pas répondu à temps.`),
    ]);
  }

  const secret = itemsById.get(results.secretVariantId);
  const finders = (results.foundBy ?? []).map(findPlayer).filter(Boolean);
  const guessers = results.guessers ?? 0;

  return el('div', { class: 'results' }, [
    el('p', { class: 'guess-status' }, `La question de ${target.name} était :`),
    el('div', { class: 'result-winner result-winner--text' }, [
      el('span', { class: 'result-winner__name' }, secret?.label ?? ''),
    ]),
    whichAnswerNode(results.answer, players),
    foundBlock(finders),
    el('div', { class: 'results__rows' }, guessRows(results, itemsById, results.secretVariantId)),
    el('p', { class: 'muted' }, guessersLabel(guessers)),
  ]);
}

/** « 1 classement incomplet » / « N classements incomplets », or null when none (SPEC §5). */
function incompleteRankingLine(count) {
  if (typeof count !== 'number' || count <= 0) return null;
  return el('p', { class: 'muted' }, count === 1 ? '1 classement incomplet' : `${count} classements incomplets`);
}

/**
 * Body of the results screen: smartdumb subtitle (when relevant), then counts / ranking / tierlist,
 * or « Personne n'a répondu » when nobody voted.
 * @param {object} round round of the `results` phase
 * @param {Array<{ id: string, name: string }>} [players] state.players, to name the tierlist pages
 * @returns {HTMLElement}
 */
export function resultsBody(round, players = []) {
  if (round.question.type === 'anecdote') return anecdoteResultsBody(round, players);
  if (round.question.type === 'guess') return guessResultsBody(round, round.results, players);
  if (round.question.type === 'which') return whichResultsBody(round, round.results, players);
  const results = round.results;
  const itemsById = new Map(round.items.map((item) => [item.id, item]));
  const subtitle =
    round.question.type === 'smartdumb'
      ? el('p', { class: 'muted' }, 'Votes cumulés (intelligent + débile) — à vous de deviner')
      : null;

  // Ranking: rankings left unvalidated when the round ended (SPEC §5, incompleteCount), shown under the results.
  const incomplete = round.question.type === 'ranking' ? incompleteRankingLine(results.incompleteCount) : null;

  if (results.voters === 0) {
    return el('div', { class: 'results' }, [
      subtitle,
      el('p', { class: 'muted' }, "Personne n'a répondu"),
      incomplete,
    ]);
  }

  let body;
  if (results.kind === 'counts') {
    body = el('div', { class: 'results__rows' }, countsRows(round, results, itemsById));
  } else if (results.kind === 'ranking') {
    body = rankingBody(results, itemsById);
  } else {
    body = tierlistBody(round, results, itemsById, players);
  }
  return el('div', { class: 'results' }, [subtitle, body, incomplete]);
}
