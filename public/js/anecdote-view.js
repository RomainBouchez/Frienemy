// Anecdote question (SPEC §6, §10; T9 « UI »): the three stages of the question phase (write, read,
// match) and the anecdote results. The server owns the stages and the answers; this module only builds
// the DOM and keeps the local drafts (one per round.index and stage). Player text is set with textContent.
import { el, avatar } from './ui.js';
import { draggable, markDropped, onDrop } from './dnd.js';

const MAX_LENGTH = 280;

/** @type {Map<number, object>} round.index -> draft of the current stage */
const drafts = new Map();

/** Draft of the round for its current stage; a new stage starts an empty draft. */
function draftFor(round) {
  let draft = drafts.get(round.index);
  if (!draft || draft.questionId !== round.question.id || draft.stage !== round.stage) {
    draft = { questionId: round.question.id, stage: round.stage, text: '', matches: {}, selected: null };
    drafts.set(round.index, draft);
  }
  return draft;
}

/** Forgets every anecdote draft (called when no round is running). */
export function clearAnecdoteDrafts() {
  drafts.clear();
}

/** Write answer `{ text }` (trimmed, 1..280 characters), or null while « Valider » must stay disabled. */
function writeAnswer(round) {
  const text = draftFor(round).text.trim();
  return text.length >= 1 && text.length <= MAX_LENGTH ? { text } : null;
}

/**
 * Match answer `{ matches }`: every anecdote except the player's own is linked to an author, or null.
 * Authors are distinct by construction (one chip per author), and the server validates the rest.
 */
function matchAnswer(round, you) {
  const draft = draftFor(round);
  const matches = {};
  for (const anecdote of round.anecdotes) {
    if (anecdote.id === you.ownAnecdoteId) continue;
    const authorId = draft.matches[anecdote.id];
    if (!authorId) return null;
    matches[anecdote.id] = authorId;
  }
  return { matches };
}

/** Answer to send for the current stage (`you` = state.you), or null. */
export function anecdoteAnswer(round, you) {
  if (round.stage === 'write') return writeAnswer(round);
  if (round.stage === 'match') return matchAnswer(round, you);
  return null;
}

/**
 * Draft of the current stage for the draft sync (`round:draft`, SPEC §8): `{ text }` in write (same as
 * the answer), `{ matches }` with the associations made so far in match (partial allowed), null
 * otherwise (nothing to send, read stage included).
 */
export function anecdoteDraft(round, you) {
  if (round.stage === 'write') return writeAnswer(round);
  if (round.stage !== 'match') return null;
  const draft = draftFor(round);
  const matches = {};
  for (const anecdote of round.anecdotes) {
    if (anecdote.id === you.ownAnecdoteId) continue;
    const authorId = draft.matches[anecdote.id];
    if (authorId) matches[anecdote.id] = authorId;
  }
  return Object.keys(matches).length > 0 ? { matches } : null;
}

/* ---------- Write stage ---------- */

/** Textarea (maxlength 280) with a live « 123/280 » counter. The text lives in the draft. */
export function createWriteWidget(round, { onChange = () => {} } = {}) {
  const draft = draftFor(round);
  const area = el('textarea', {
    class: 'anecdote-input',
    maxlength: MAX_LENGTH,
    rows: 5,
    'aria-label': 'Ton anecdote',
    placeholder: 'Raconte une anecdote…',
  });
  area.value = draft.text;
  const counter = el('p', { class: 'anecdote-counter', 'aria-live': 'polite' });
  const refresh = () => {
    counter.textContent = `${area.value.length}/${MAX_LENGTH}`;
  };
  area.addEventListener('input', () => {
    draft.text = area.value;
    refresh();
    onChange();
  });
  refresh();
  return { node: el('div', { class: 'widget' }, [area, counter]) };
}

/* ---------- Read stage ---------- */

/** Big anonymous card of the anecdote being read. `reading` = round.reading = { index, total, text }. */
export function anecdoteReadCard(reading) {
  return el('article', { class: 'anecdote-read' }, [
    el('p', { class: 'eyebrow' }, `Anecdote ${reading.index + 1}/${reading.total}`),
    el('p', { class: 'anecdote-read__text' }, reading.text),
  ]);
}

/* ---------- Match stage ---------- */

/** Pure placement rule: puts `authorId` on `anecdoteId`, swapping with the occupant (back to the origin). */
function placeMatch(draft, authorId, anecdoteId) {
  const origin = Object.keys(draft.matches).find((id) => draft.matches[id] === authorId) ?? null;
  draft.selected = null;
  if (origin === anecdoteId) return;
  const occupant = draft.matches[anecdoteId] ?? null;
  if (origin !== null) {
    if (occupant) draft.matches[origin] = occupant;
    else delete draft.matches[origin];
  }
  draft.matches[anecdoteId] = authorId;
}

/** Sends `authorId` back to the authors tray. */
function unplaceMatch(draft, authorId) {
  for (const id of Object.keys(draft.matches)) {
    if (draft.matches[id] === authorId) delete draft.matches[id];
  }
  draft.selected = null;
}

function authorChip(author, { selected = false, readOnly = false, onTap = null }) {
  if (readOnly) {
    return el('span', { class: 'author-chip is-static' }, [
      avatar(author, 32),
      el('span', { class: 'author-chip__label' }, author.label),
    ]);
  }
  const node = el(
    'button',
    {
      type: 'button',
      class: 'author-chip' + (selected ? ' is-selected' : ''),
      'aria-pressed': selected ? 'true' : 'false',
      onclick: (event) => {
        // A chip sits inside a slot or the tray: its tap must not also act on the container.
        event.stopPropagation();
        onTap?.();
      },
    },
    [avatar(author, 32), el('span', { class: 'author-chip__label' }, author.label)],
  );
  return draggable(node, { kind: 'author', id: author.id });
}

/**
 * Match widget: one card per anecdote with a dotted slot for its author, and the authors tray (the
 * writers except the player). The player's own anecdote is greyed out, without slot. Drag and drop
 * (dnd.js) and the tap fallback (« select a chip, then tap a slot or the tray ») share placeMatch /
 * unplaceMatch. `readOnly` (spectators) shows the texts and the authors without interaction.
 */
export function createMatchWidget(round, you, { readOnly = false, onChange = () => {} } = {}) {
  const root = el('div', { class: 'widget anecdote-match' });
  const draft = draftFor(round);
  const authors = round.authors.filter((author) => author.id !== you.playerId);
  const authorsById = new Map(authors.map((author) => [author.id, author]));
  const slotted = round.anecdotes.filter((anecdote) => anecdote.id !== you.ownAnecdoteId);

  /** Change behind the next paint (a drop settles the dropped author chip); consumed by that paint only. */
  let pending = null;
  const update = (change = null) => {
    pending = change;
    paint();
    onChange();
  };

  const trayNode = (placedIds) => {
    const tray = authors.filter((author) => !placedIds.has(author.id));
    if (readOnly) {
      return el('div', { class: 'author-tray' }, tray.map((author) => authorChip(author, { readOnly: true })));
    }
    return el(
      'div',
      {
        class: 'author-tray',
        'data-drop': 'tray',
        onclick: () => {
          // Tap on the tray with a placed author selected: send that author back.
          if (draft.selected === null || !placedIds.has(draft.selected)) return;
          unplaceMatch(draft, draft.selected);
          update();
        },
      },
      tray.map((author) =>
        authorChip(author, {
          selected: draft.selected === author.id,
          onTap: () => {
            draft.selected = draft.selected === author.id ? null : author.id;
            update();
          },
        }),
      ),
    );
  };

  const anecdoteCard = (anecdote) => {
    if (anecdote.id === you.ownAnecdoteId) {
      return el('article', { class: 'anecdote-card is-own' }, [
        el('p', { class: 'eyebrow' }, 'Ton anecdote'),
        el('p', { class: 'anecdote-card__text' }, anecdote.text),
      ]);
    }
    const authorId = draft.matches[anecdote.id] ?? null;
    const author = authorId === null ? null : authorsById.get(authorId);
    const slotChildren = author
      ? [
          authorChip(author, {
            readOnly,
            selected: draft.selected === author.id,
            onTap: () => {
              draft.selected = draft.selected === author.id ? null : author.id;
              update();
            },
          }),
        ]
      : [el('span', { class: 'anecdote-slot__hint' }, readOnly ? 'Pas encore relié' : 'Dépose ici')];
    const slot = readOnly
      ? el('div', { class: 'anecdote-slot' + (author ? ' is-filled' : '') }, slotChildren)
      : el(
          'div',
          {
            class: 'anecdote-slot' + (author ? ' is-filled' : ''),
            'data-drop': `slot:${anecdote.id}`,
            onclick: () => {
              if (draft.selected === null) return;
              placeMatch(draft, draft.selected, anecdote.id);
              update();
            },
          },
          slotChildren,
        );
    return el('article', { class: 'anecdote-card' }, [
      el('p', { class: 'anecdote-card__text' }, anecdote.text),
      slot,
    ]);
  };

  const paint = () => {
    const placedIds = new Set(slotted.map((anecdote) => draft.matches[anecdote.id]).filter(Boolean));
    const filled = placedIds.size;
    // A local repaint is not a screen entry: end the entry so the new nodes do not replay its cascade.
    root.closest('.is-entering')?.classList.remove('is-entering');
    root.replaceChildren(
      el('p', { class: 'counter' }, `${filled}/${slotted.length} reliées`),
      trayNode(placedIds),
      ...round.anecdotes.map(anecdoteCard),
    );
    if (pending?.dropped) markDropped(root, pending.dropped);
    pending = null;
  };

  if (!readOnly) {
    onDrop(root, (data, dropEl) => {
      if (data.kind !== 'author') return;
      const [zone, value] = dropEl.dataset.drop.split(':');
      if (zone === 'slot') placeMatch(draft, data.id, value);
      else if (zone === 'tray') unplaceMatch(draft, data.id);
      else return;
      update({ dropped: data });
    });
  }
  paint();
  return { node: root };
}

/* ---------- Results ---------- */

/**
 * Anecdote results (phase results): each anecdote with its real author and the « trouvé par » avatars,
 * then the « Bonnes associations » scoreboard. `round.results` = { anecdotes, scores } (SPEC §5).
 * @param {object} round round of the results phase
 * @param {Array<{ id: string, name: string, color: string, avatar: string }>} players state.players
 */
export function anecdoteResultsBody(round, players) {
  const results = round.results;
  const byId = (id) => players.find((player) => player.id === id);
  if (results.anecdotes.length === 0) {
    return el('div', { class: 'results' }, el('p', { class: 'muted' }, "Personne n'a écrit d'anecdote"));
  }

  const cards = results.anecdotes.map((anecdote) => {
    const author = byId(anecdote.authorId) ?? { name: '?', avatar: null, color: null };
    const finders = anecdote.foundBy.map(byId).filter(Boolean);
    return el('article', { class: 'anecdote-result' }, [
      el('p', { class: 'anecdote-result__text' }, anecdote.text),
      el('div', { class: 'anecdote-result__row' }, [
        el('span', { class: 'muted' }, 'Écrit par'),
        avatar(author, 40),
        el('span', { class: 'anecdote-result__name' }, author.name),
      ]),
      el(
        'div',
        { class: 'anecdote-result__row' },
        finders.length > 0
          ? [
              el('span', { class: 'muted' }, 'trouvé par'),
              el('span', { class: 'found-avatars' }, finders.map((player) => avatar(player, 32))),
            ]
          : el('span', { class: 'muted' }, "Personne n'a trouvé"),
      ),
    ]);
  });

  const board =
    results.scores.length > 0
      ? [
          el('p', { class: 'zone__title' }, 'Bonnes associations'),
          el(
            'ol',
            { class: 'score-list' },
            results.scores.map((score) => {
              const player = byId(score.playerId);
              return el('li', { class: 'score-row' }, [
                avatar(player ?? { name: '?' }, 40),
                el('span', { class: 'score-row__name' }, player?.name ?? '?'),
                // Incomplete: the player left some associations unsent (SPEC §5, scores[].incomplete).
                score.incomplete ? el('span', { class: 'muted' }, '(incomplète)') : null,
                el('span', { class: 'score-row__value' }, `${score.correct}/${score.total}`),
              ]);
            }),
          ),
        ]
      : null;

  return el('div', { class: 'results' }, [cards, board]);
}
