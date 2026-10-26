// Answer widgets for the 5 question types (SPEC §10 item 4) and answer building (SPEC §5 shapes).
// The in-progress draft lives in a module-level map keyed by round.index, so a new `state` (someone
// else answered, a reconnection) rebuilds the widget from the draft and never erases the selection.
// Drag and drop (dnd.js) and the tap fallback (« select, then place ») call the same draft mutations.
import { el, avatar } from './ui.js';
import { draggable, markDropped, onDrop } from './dnd.js';

const TIERS = ['S', 'A', 'B', 'C', 'D'];
/** Root class of the answer widget per type (default: plain widget). */
const ROOT_CLASS = {
  ranking: 'widget widget--ranking',
  tierlist: 'widget widget--tierlist',
  which: 'widget widget--which',
};
/** Longest text answer of « Quelle était la question ? » (contract which: trim 1..80). */
const WHICH_TEXT_MAX = 80;
const PODIUM_LABELS = ['1er', '2e', '3e'];
const BADGE_LABELS = { smart: 'Intelligent', dumb: 'Débile' };
const OTHER_BADGE = { smart: 'dumb', dumb: 'smart' };

/** @type {Map<number, object>} round.index -> draft */
const drafts = new Map();

function isPlayerItem(item) {
  return typeof item.avatar === 'string';
}

function allPlayerItems(items) {
  return items.every(isPlayerItem);
}

function emptyDraft(round) {
  // The stage is part of the draft: a guess question has two stages with their own answer (see draftFor).
  const base = { questionId: round.question.id, stage: round.stage ?? null };
  switch (round.question.type) {
    case 'single':
    case 'guess':
      return { ...base, choice: null };
    case 'which':
      // `choice` for a copain or a variant, `text` for a free text answer (only the target's pick).
      return { ...base, choice: null, text: '' };
    case 'multiple':
      return { ...base, choices: [] };
    case 'ranking':
      // One entry per slot (1er, 2e, 3e, 4., …), null when empty. Same for propositions and players.
      return { ...base, slots: new Array(round.items.length).fill(null), selected: null };
    case 'smartdumb':
      return { ...base, smart: null, dumb: null, selected: null };
    case 'tierlist':
      return { ...base, tiers: {}, selected: null };
    default:
      throw new Error(`Type de question inconnu : ${round.question.type}`);
  }
}

/**
 * Draft of the round, created empty when missing or when it belongs to another question or stage (a
 * guess question: the target's pick and the guessers' guess are two different answers).
 */
export function draftFor(round) {
  let draft = drafts.get(round.index);
  if (!draft || draft.questionId !== round.question.id || draft.stage !== (round.stage ?? null)) {
    draft = emptyDraft(round);
    drafts.set(round.index, draft);
  }
  return draft;
}

/** Forgets every draft (called when no round is running, so the next game starts clean). */
export function clearDrafts() {
  drafts.clear();
}

/**
 * Returns the answer object of SPEC §5 for the draft, or null when the draft is not a complete valid
 * answer. The server still validates; this only decides whether « Valider » is enabled.
 */
export function buildAnswer(round, draft) {
  if (!draft || draft.questionId !== round.question.id) return null;
  const ids = round.items.map((item) => item.id);
  const question = round.question;
  switch (question.type) {
    case 'single':
    case 'guess':
      return draft.choice !== null && ids.includes(draft.choice) ? { choice: draft.choice } : null;
    case 'which': {
      // Pick of a text answer: { text } (trim 1..80). Otherwise a choice: a copain (pick) or a variant (guess).
      if (round.stage === 'pick' && question.answerKind === 'text') {
        const text = draft.text.trim();
        return text.length >= 1 && text.length <= WHICH_TEXT_MAX ? { text } : null;
      }
      return draft.choice !== null && ids.includes(draft.choice) ? { choice: draft.choice } : null;
    }
    case 'multiple': {
      const count = draft.choices.length;
      if (count < 1) return null;
      if (question.maxChoices !== null && count > question.maxChoices) return null;
      return { choices: [...draft.choices] };
    }
    case 'ranking': {
      const slots = draft.slots;
      const complete =
        Array.isArray(slots) &&
        slots.length === ids.length &&
        slots.every((id) => id !== null && ids.includes(id)) &&
        new Set(slots).size === ids.length;
      return complete ? { order: [...slots] } : null;
    }
    case 'smartdumb':
      return draft.smart !== null && draft.dumb !== null && draft.smart !== draft.dumb
        ? { smart: draft.smart, dumb: draft.dumb }
        : null;
    case 'tierlist':
      if (!ids.every((id) => TIERS.includes(draft.tiers[id]))) return null;
      return { tiers: Object.fromEntries(ids.map((id) => [id, draft.tiers[id]])) };
    default:
      return null;
  }
}

/**
 * Partial answer of the draft for the draft sync (`round:draft`, SPEC §8), or null. Only ranking and
 * tierlist have one: ranking `{ order }` with null for the empty slots (as soon as one slot is filled),
 * tierlist `{ tiers }` with only the placed items (as soon as one is placed). Other types: null, since
 * they are sent only when complete (buildAnswer).
 */
export function partialAnswer(round, draft) {
  if (!draft || draft.questionId !== round.question.id) return null;
  switch (round.question.type) {
    case 'ranking':
      return draft.slots.some((id) => id !== null) ? { order: [...draft.slots] } : null;
    case 'tierlist': {
      const tiers = {};
      for (const item of round.items) {
        if (TIERS.includes(draft.tiers[item.id])) tiers[item.id] = draft.tiers[item.id];
      }
      return Object.keys(tiers).length > 0 ? { tiers } : null;
    }
    default:
      return null;
  }
}

/* ---------- Placement rules (shared by drag and drop and by the tap fallback) ---------- */

/**
 * Ranking on custom propositions. `slot` is a slot index, or null to send the chip back to the pool.
 * A chip moved onto an occupied slot swaps with its occupant: the occupant goes to the origin slot of
 * the moved chip, or back to the pool when the moved chip came from the pool.
 */
function placeRankingChip(draft, id, slot) {
  const slots = draft.slots;
  const origin = slots.indexOf(id);
  if (slot === null) {
    if (origin !== -1) slots[origin] = null;
  } else if (origin !== slot) {
    const occupant = slots[slot];
    slots[slot] = id;
    if (origin !== -1) slots[origin] = occupant;
  }
  draft.selected = null;
}

/**
 * Intelligent / Débile. `tileId` is the player tile, or null for the tray. A tile holds one badge: if
 * the tile already holds the other badge, the two swap (the other badge goes to the origin tile, or to
 * the tray when the moved badge came from the tray).
 */
function placeBadge(draft, key, tileId) {
  const origin = draft[key];
  if (tileId === null) {
    draft[key] = null;
  } else if (origin !== tileId) {
    const other = OTHER_BADGE[key];
    const occupant = draft[other] === tileId ? other : null;
    draft[key] = tileId;
    if (occupant) draft[occupant] = origin;
  }
  draft.selected = null;
}

/** Tierlist: `tier` is one of S..D, or null to send the chip back to the pool. */
function placeTierChip(draft, id, tier) {
  if (tier === null) delete draft.tiers[id];
  else draft.tiers[id] = tier;
  draft.selected = null;
}

/* ---------- Widgets ---------- */

/** One item as a tile (players) or a pill (custom options). Read-only items are not buttons. */
function choiceButton(item, { selected = false, disabled = false, readOnly = false, onTap = null }) {
  const player = isPlayerItem(item);
  const classes = [player ? 'tile' : 'pill'];
  if (selected) classes.push('is-selected');
  if (disabled) classes.push('is-disabled');
  if (readOnly) classes.push('is-static');
  const content = player
    ? [avatar(item, 72), el('span', { class: 'tile__name' }, item.label)]
    : [el('span', { class: 'pill__label' }, item.label)];
  if (readOnly) {
    return el('div', { class: classes.join(' ') }, content);
  }
  return el(
    'button',
    {
      type: 'button',
      class: classes.join(' '),
      disabled,
      'aria-pressed': selected ? 'true' : 'false',
      onclick: onTap,
    },
    content,
  );
}

/**
 * Container for a list of choice buttons: grid of tiles for players, grid of pills for custom.
 * `.stack` and `.grid-3` stay defined in game.css for other screens; they are no longer used here.
 */
function choiceContainer(items, children) {
  const players = allPlayerItems(items);
  return el(
    'div',
    { class: 'choice-grid ' + (players ? 'choice-grid--players' : 'choice-grid--custom') },
    children,
  );
}

/** Small chip used by the tierlist (32px avatar + label for players, label only for custom). Draggable. */
function chip(item, { selected = false, onTap = null }) {
  const node = el(
    'button',
    {
      type: 'button',
      class: 'chip' + (selected ? ' is-selected' : ''),
      'data-item': String(item.id),
      'aria-pressed': selected ? 'true' : 'false',
      onclick: (event) => {
        // A chip sits inside a tier row: its tap must not also place the selection in the row.
        event.stopPropagation();
        onTap?.();
      },
    },
    isPlayerItem(item) ? avatar(item, 32) : null,
    el('span', { class: 'chip__label' }, item.label),
  );
  return draggable(node, { kind: 'chip', id: item.id });
}

function staticItems(items) {
  return choiceContainer(items, items.map((item) => choiceButton(item, { readOnly: true })));
}

/** Read-only items with the chosen one ringed (guess, the target sees her own pick). `choiceId` may be null. */
export function selectedStaticItems(round, choiceId) {
  return choiceContainer(
    round.items,
    round.items.map((item) => choiceButton(item, { selected: item.id === choiceId, readOnly: true })),
  );
}

function singleNodes(round, draft, update) {
  const items = round.items;
  return choiceContainer(
    items,
    items.map((item) =>
      choiceButton(item, {
        selected: draft.choice === item.id,
        onTap: () => {
          draft.choice = item.id;
          update({ pop: items.indexOf(item) });
        },
      }),
    ),
  );
}

function multipleNodes(round, draft, update) {
  const items = round.items;
  const max = round.question.maxChoices;
  const count = draft.choices.length;
  const atMax = max !== null && count >= max;
  const counter = max !== null ? `${count}/${max} max` : count === 1 ? '1 choisi' : `${count} choisis`;
  return [
    el('p', { class: 'counter' }, counter),
    choiceContainer(
      items,
      items.map((item) => {
        const selected = draft.choices.includes(item.id);
        return choiceButton(item, {
          selected,
          disabled: !selected && atMax,
          onTap: () => {
            let pop = null;
            if (selected) {
              draft.choices = draft.choices.filter((id) => id !== item.id);
            } else if (!atMax) {
              draft.choices = [...draft.choices, item.id];
              pop = items.indexOf(item);
            }
            update(pop === null ? null : { pop });
          },
        });
      }),
    ),
  ];
}

/** Ranking (propositions or players): dotted podium (1er, 2e, 3e), list slots (4., 5., …) and pool. */
function rankingNodes(round, draft, update) {
  const byId = new Map(round.items.map((item) => [item.id, item]));
  const count = round.items.length;

  const chipNode = (item) => {
    const selected = draft.selected === item.id;
    const player = isPlayerItem(item);
    const node = el(
      'button',
      {
        type: 'button',
        class: 'rank-chip' + (player ? ' rank-chip--player' : '') + (selected ? ' is-selected' : ''),
        'data-item': String(item.id),
        'aria-pressed': selected ? 'true' : 'false',
        onclick: (event) => {
          // Inside a slot: the tap selects the chip and must not also place the selection in the slot.
          event.stopPropagation();
          draft.selected = selected ? null : item.id;
          update();
        },
      },
      player ? avatar(item, 28) : null,
      el('span', { class: 'rank-chip__label' }, item.label),
    );
    return draggable(node, { kind: 'chip', id: item.id });
  };

  const slotNode = (index, label, extraClass) => {
    const occupantId = draft.slots[index];
    const occupant = occupantId === null ? null : byId.get(occupantId);
    return el(
      'div',
      {
        class: `rank-slot ${extraClass}` + (occupant ? ' is-filled' : ''),
        'data-drop': `slot:${index}`,
        onclick: () => {
          if (draft.selected === null) return;
          placeRankingChip(draft, draft.selected, index);
          update();
        },
      },
      [el('span', { class: 'rank-slot__label' }, label), occupant ? chipNode(occupant) : null],
    );
  };

  // Podium in visual order: 2e left, 1er centre (taller), 3e right. Only the places that exist.
  const podiumIndexes = count >= 3 ? [1, 0, 2] : count === 2 ? [1, 0] : [0];
  const podium = el(
    'div',
    { class: 'podium' },
    podiumIndexes.map((index) =>
      slotNode(index, PODIUM_LABELS[index], `podium__slot podium__slot--${index + 1}`),
    ),
  );

  const listIndexes = [];
  for (let index = 3; index < count; index += 1) listIndexes.push(index);
  const list =
    listIndexes.length > 0
      ? [
          el('p', { class: 'zone__title' }, 'Liste'),
          el(
            'div',
            { class: 'rank-slots' },
            listIndexes.map((index) => slotNode(index, `${index + 1}.`, 'rank-slot--row')),
          ),
        ]
      : null;

  const placed = draft.slots.filter((id) => id !== null);
  const pool = round.items.filter((item) => !placed.includes(item.id));
  const poolNode = el(
    'div',
    {
      class: 'rank-pool',
      'data-drop': 'pool',
      onclick: () => {
        if (draft.selected === null || !draft.slots.includes(draft.selected)) return;
        placeRankingChip(draft, draft.selected, null);
        update();
      },
    },
    pool.map(chipNode),
  );

  return [
    podium,
    list,
    pool.length > 0 ? el('p', { class: 'zone__title' }, 'À classer') : null,
    poolNode,
    placed.length > 0
      ? el(
          'button',
          {
            type: 'button',
            class: 'link-btn',
            onclick: () => {
              draft.slots = draft.slots.map(() => null);
              draft.selected = null;
              update();
            },
          },
          'Recommencer',
        )
      : null,
  ];
}

/** Badge on a player tile (draggable, not a button: the tile is the tap target). */
function tileBadge(key, selected) {
  const node = el(
    'span',
    {
      class: `badge-token badge-token--${key} tile__badge` + (selected ? ' is-selected' : ''),
      'data-item': `badge:${key}`,
    },
    BADGE_LABELS[key],
  );
  return draggable(node, { kind: 'badge', key });
}

/** Unplaced badge in the tray (a button: tap to select it, drag to place it). */
function trayBadge(key, draft, update) {
  const selected = draft.selected === key;
  const node = el(
    'button',
    {
      type: 'button',
      class: `badge-token badge-token--${key}` + (selected ? ' is-selected' : ''),
      'data-item': `badge:${key}`,
      'aria-pressed': selected ? 'true' : 'false',
      onclick: (event) => {
        event.stopPropagation();
        draft.selected = selected ? null : key;
        update();
      },
    },
    BADGE_LABELS[key],
  );
  return draggable(node, { kind: 'badge', key });
}

function smartdumbNodes(round, draft, update) {
  const tile = (item) => {
    const key = draft.smart === item.id ? 'smart' : draft.dumb === item.id ? 'dumb' : null;
    return el(
      'button',
      {
        type: 'button',
        class: 'tile',
        'data-drop': `tile:${item.id}`,
        onclick: () => {
          if (draft.selected !== null) {
            placeBadge(draft, draft.selected, item.id);
            update();
          } else if (key !== null) {
            // Tap on a tile that holds a badge: select that badge (a second tap on the tile removes it).
            draft.selected = key;
            update();
          }
        },
      },
      [
        avatar(item, 72),
        el('span', { class: 'tile__name' }, item.label),
        key !== null ? tileBadge(key, draft.selected === key) : null,
      ],
    );
  };

  const trayKeys = ['smart', 'dumb'].filter((key) => draft[key] === null);
  const tray = el(
    'div',
    {
      class: 'badge-tray',
      'data-drop': 'tray',
      onclick: () => {
        // Tap on the tray with a placed badge selected: remove that badge.
        if (draft.selected === null || draft[draft.selected] === null) return;
        placeBadge(draft, draft.selected, null);
        update();
      },
    },
    trayKeys.map((key) => trayBadge(key, draft, update)),
  );

  return [tray, el('div', { class: 'choice-grid choice-grid--players' }, round.items.map(tile))];
}

function tierlistNodes(round, draft, update) {
  const items = round.items;
  const selectChip = (id) => {
    draft.selected = draft.selected === id ? null : id;
    update();
  };
  const placeIn = (tier) => {
    if (draft.selected === null) return;
    placeTierChip(draft, draft.selected, tier);
    update();
  };
  const unplace = () => {
    if (draft.selected === null || !(draft.selected in draft.tiers)) return;
    placeTierChip(draft, draft.selected, null);
    update();
  };
  const rows = TIERS.map((tier) => {
    const members = items.filter((item) => draft.tiers[item.id] === tier);
    return el('div', { class: 'tier-row', 'data-drop': `tier:${tier}` }, [
      el(
        'button',
        {
          type: 'button',
          class: 'tier-row__label',
          'data-tier': tier,
          onclick: () => placeIn(tier),
        },
        tier,
      ),
      el(
        'div',
        { class: 'tier-row__zone', onclick: () => placeIn(tier) },
        members.map((item) =>
          chip(item, { selected: draft.selected === item.id, onTap: () => selectChip(item.id) }),
        ),
      ),
    ]);
  });
  const pool = items.filter((item) => !(item.id in draft.tiers));
  return [
    ...rows,
    pool.length > 0 ? el('p', { class: 'zone__title' }, 'À placer') : null,
    el(
      'div',
      { class: 'tier-pool', 'data-drop': 'pool', onclick: unplace },
      pool.map((item) =>
        chip(item, { selected: draft.selected === item.id, onTap: () => selectChip(item.id) }),
      ),
    ),
  ];
}

/**
 * One-shot classes of the change that caused the paint: a tap pops the tapped tile or pill (`pop` = its
 * index among the choices), a drop settles the dropped chip or badge (`dropped` = its drag data).
 */
function markChange(root, change) {
  if (!change) return;
  if (change.pop !== undefined) {
    root.querySelectorAll('.choice-grid > .tile, .choice-grid > .pill')[change.pop]?.classList.add('just-selected');
  }
  if (change.dropped) markDropped(root, change.dropped);
}

/* ---------- Move animation (FLIP) ----------
   Elements carrying data-item (chips, badges) glide from their previous place to their new one when a
   repaint moves them. Only translate moves (the individual property, so the tilt and scale stay free).
   Centres are compared, not corners: a pressed or selected chip changes size, its centre does not move. */

/** Key of a drag source in the move animation: the item id, or `badge:<key>` for an Intelligent/Débile badge. */
function dragKey(data) {
  return data.kind === 'chip' ? String(data.id) : `badge:${data.key}`;
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Viewport rect of every data-item element under root, by key. */
function measureItems(root) {
  const rects = new Map();
  for (const node of root.querySelectorAll('[data-item]')) {
    rects.set(node.dataset.item, node.getBoundingClientRect());
  }
  return rects;
}

/**
 * Runs the glide after a repaint. `before` holds the rects measured before the repaint. `origin`
 * ({ key, rect } or null) replaces the previous rect of the dropped item: after a drag its origin is where
 * the ghost was released, not its place in the pool.
 */
function animateMoves(root, before, origin) {
  if (!root.isConnected || prefersReducedMotion()) return;
  const moved = [];
  for (const node of root.querySelectorAll('[data-item]')) {
    const key = node.dataset.item;
    const from = origin && origin.key === key ? origin.rect : before.get(key);
    if (!from || (from.width === 0 && from.height === 0)) continue;
    const to = node.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    // Start position, with no transition: the element is put back where it was before the repaint.
    node.style.transition = 'none';
    node.style.translate = `${dx}px ${dy}px`;
    moved.push(node);
  }
  if (moved.length === 0) return;
  // Commit the start positions (reflow) so the transition below starts from them.
  void root.offsetWidth;
  for (const node of moved) {
    const settle = () => {
      node.removeEventListener('transitionend', onEnd);
      node.style.transition = '';
      node.style.translate = '';
    };
    const onEnd = (event) => {
      if (event.target === node && event.propertyName === 'translate') settle();
    };
    node.addEventListener('transitionend', onEnd);
    // Fallback for a transition that never ends (element hidden mid-move): settle anyway.
    setTimeout(settle, 400);
    node.style.transition = 'translate var(--dur-med) var(--ease-out)';
    node.style.translate = '0px 0px';
  }
}

/**
 * Drop handler of a widget root (drag and drop), or null when the type has no drag interaction.
 * Reads only the drag data and the drop zone; the draft stays the source of truth.
 */
function dropHandler(round, draft, update) {
  // `ghostRect` is where the ghost was released: the dropped item glides from there, not from the pool.
  const dropChange = (data, ghostRect) => ({
    dropped: data,
    origin: ghostRect ? { key: dragKey(data), rect: ghostRect } : null,
  });
  switch (round.question.type) {
    case 'ranking':
      return (data, dropEl, ghostRect) => {
        if (data.kind !== 'chip') return;
        const [zone, value] = dropEl.dataset.drop.split(':');
        if (zone === 'pool') placeRankingChip(draft, data.id, null);
        else if (zone === 'slot') placeRankingChip(draft, data.id, Number(value));
        else return;
        update(dropChange(data, ghostRect));
      };
    case 'smartdumb':
      return (data, dropEl, ghostRect) => {
        if (data.kind !== 'badge') return;
        const [zone, value] = dropEl.dataset.drop.split(':');
        if (zone === 'tray') placeBadge(draft, data.key, null);
        else if (zone === 'tile') placeBadge(draft, data.key, value);
        else return;
        update(dropChange(data, ghostRect));
      };
    case 'tierlist':
      return (data, dropEl, ghostRect) => {
        if (data.kind !== 'chip') return;
        const [zone, value] = dropEl.dataset.drop.split(':');
        if (zone === 'tier') placeTierChip(draft, data.id, value);
        else if (zone === 'pool') placeTierChip(draft, data.id, null);
        else return;
        update(dropChange(data, ghostRect));
      };
    default:
      return null;
  }
}

/**
 * One-line text answer of « Quelle était la question ? » (answerKind text, the target's pick). The input is
 * built once: a repaint would drop the focus on each key, so only the draft and the caller's onChange run.
 */
function textAnswerNode(draft, onChange) {
  const input = el('input', {
    type: 'text',
    class: 'which-input',
    maxlength: WHICH_TEXT_MAX,
    autocomplete: 'off',
    'aria-label': 'Ta réponse',
    placeholder: 'Ta réponse…',
  });
  input.value = draft.text;
  const counter = el('p', { class: 'counter', 'aria-live': 'polite' });
  const refresh = () => {
    counter.textContent = `${input.value.length}/${WHICH_TEXT_MAX}`;
  };
  input.addEventListener('input', () => {
    draft.text = input.value;
    refresh();
    onChange();
  });
  refresh();
  return el('div', { class: 'widget' }, [input, counter]);
}

/**
 * Answer widget for the round. `readOnly` (spectators) shows the items without any interaction.
 * `onChange` runs after every local change so the caller can refresh the « Valider » button.
 * @returns {{ node: HTMLElement }}
 */
export function createAnswerWidget(round, { readOnly = false, onChange = () => {} } = {}) {
  // The ranking widget has tighter gaps: it holds up to 13+ chips on a phone (SPEC §10).
  const root = el('div', { class: ROOT_CLASS[round.question.type] ?? 'widget' });
  if (readOnly) {
    root.replaceChildren(staticItems(round.items));
    return { node: root };
  }
  // Note: paint() below filters null entries before replaceChildren (which would stringify them).

  const draft = draftFor(round);
  if (round.question.type === 'which' && round.stage === 'pick' && round.question.answerKind === 'text') {
    root.replaceChildren(textAnswerNode(draft, onChange));
    return { node: root };
  }
  /** Change behind the next paint (see markChange); consumed by that paint only. */
  let pending = null;
  const update = (change = null) => {
    pending = change;
    paint();
    onChange();
  };
  const paint = () => {
    let nodes;
    switch (round.question.type) {
      case 'single':
      case 'guess':
      case 'which':
        nodes = singleNodes(round, draft, update);
        break;
      case 'multiple':
        nodes = multipleNodes(round, draft, update);
        break;
      case 'ranking':
        nodes = rankingNodes(round, draft, update);
        break;
      case 'smartdumb':
        nodes = smartdumbNodes(round, draft, update);
        break;
      case 'tierlist':
        nodes = tierlistNodes(round, draft, update);
        break;
      default:
        nodes = [];
    }
    const list = (Array.isArray(nodes) ? nodes : [nodes]).flat();
    // Rects of the current items, read before the nodes are replaced (see animateMoves).
    const before = measureItems(root);
    // A local repaint is not a screen entry: end the entry so the new nodes do not replay its cascade.
    root.closest('.is-entering')?.classList.remove('is-entering');
    root.replaceChildren(...list.filter((node) => node));
    markChange(root, pending);
    animateMoves(root, before, pending?.origin ?? null);
    pending = null;
  };
  const handleDrop = dropHandler(round, draft, update);
  if (handleDrop) onDrop(root, handleDrop);
  paint();
  return { node: root };
}
