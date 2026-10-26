// Propositions de questions depuis le salon (SPEC §8 proposal:*, §10 « Propositions »; T12).
// Three pieces: the « Proposer une question » row (every player, lobby), the three-step wizard (an
// overlay outside #app, so a `state` re-render never rebuilds it) and the host's list of proposals to
// validate. The wizard draft lives in its closure and survives `state` events: inputs write to the draft
// on `input` and never trigger a rebuild, so the caret stays where it is. Player text is set with
// textContent (via el()).
import { el, TYPE_LABELS } from './ui.js';

const TEXT_MAX = 200;
const ANSWER_MAX = 60;
const ANSWERS_MIN = 2;
const ANSWERS_MAX = 12;
const MSG_GENERIC = 'Une erreur est survenue, réessaie.';

/**
 * The kinds offered in step 1 (SPEC T12). Placeholders are examples for step 2. `choice` is not a
 * server type: it sends `single` or `multiple` with the player's own answers. `preview` names the
 * small illustration on the right of the card (KIND_PREVIEWS).
 */
export const PROPOSAL_KINDS = [
  {
    type: 'single',
    title: 'Qui est le plus… ?',
    hint: 'Un seul copain',
    placeholder: 'Qui est le plus bavard ?',
    preview: 'pick-one',
  },
  {
    type: 'multiple',
    title: 'Qui pourrait… ?',
    hint: 'Plusieurs copains',
    placeholder: 'Qui pourrait oublier son téléphone au resto ?',
    preview: 'pick-many',
  },
  {
    type: 'choice',
    title: 'Question choix unique / multiple',
    hint: 'Tes propres réponses',
    placeholder: 'Quel est le meilleur fromage ?',
    preview: 'pills',
  },
  {
    type: 'ranking',
    title: 'Top du… au…',
    hint: 'Un podium',
    placeholder: 'Classe du plus frileux au plus chaud',
    preview: 'podium',
  },
  {
    type: 'tierlist',
    title: 'Range en S, A, B, C, D',
    hint: 'Une tier list',
    placeholder: 'Les meilleurs plats du traiteur',
    preview: 'tierlist',
  },
  {
    type: 'anecdote',
    title: 'Anecdote sur…',
    hint: 'Une anecdote sur un thème',
    placeholder: 'Thème : Uber',
    preview: 'bubble',
  },
  {
    type: 'guess',
    title: 'Devine sa réponse',
    hint: 'Un copain répond, les autres devinent',
    placeholder: 'Quel est son film préféré ?',
    preview: 'guess',
  },
];

/* Kind card illustrations: decorative (aria-hidden), drawn in CSS from empty spans. */

function kindArt(name, children) {
  return el('span', { class: `kind-art ${name}`, 'aria-hidden': 'true' }, children);
}

/** Three little friends; `picked[i]` puts the selection ring on the i-th one. */
function miniPeople(picked) {
  return kindArt(
    'mini-people',
    ['s', 'd', 'c'].map((color, index) =>
      el('span', { class: `mini-person mini-person--${color}` + (picked[index] ? ' is-picked' : '') }),
    ),
  );
}

/** Three option pills, the middle one selected. */
function miniPills() {
  return kindArt(
    'mini-pills',
    [false, true, false].map((picked) =>
      el('span', { class: 'mini-pill' + (picked ? ' is-picked' : '') }, el('span', { class: 'mini-pill__label' })),
    ),
  );
}

/** Podium 2-1-3, a friend on each step. */
function miniPodium() {
  return kindArt(
    'mini-podium',
    [
      { rank: 2, color: 'd' },
      { rank: 1, color: 's' },
      { rank: 3, color: 'c' },
    ].map(({ rank, color }) =>
      el('span', { class: `mini-podium__place mini-podium__place--${rank}` }, [
        el('span', { class: `mini-podium__head mini-person--${color}` }),
        el('span', { class: 'mini-podium__step' }, String(rank)),
      ]),
    ),
  );
}

/** Empty tier list S..D. */
function miniTier() {
  return kindArt(
    'mini-tier',
    ['S', 'A', 'B', 'C', 'D'].map((tier) =>
      el('span', { class: 'mini-tier__row' }, [
        el('span', { class: `mini-tier__letter mini-tier__letter--${tier.toLowerCase()}` }, tier),
        el('span', { class: 'mini-tier__lane' }),
      ]),
    ),
  );
}

/** Speech bubble with three lines of text. */
function miniBubble() {
  return kindArt(
    'mini-bubble',
    [0, 1, 2].map(() => el('span', { class: 'mini-bubble__line' })),
  );
}

/** One friend, picked, with a « ? » bubble above: someone answers, the others guess. */
function miniGuess() {
  return kindArt('mini-guess', [
    el('span', { class: 'mini-person mini-person--s is-picked' }),
    el('span', { class: 'mini-guess__bubble' }, '?'),
  ]);
}

const KIND_PREVIEWS = {
  'pick-one': () => miniPeople([false, true, false]),
  'pick-many': () => miniPeople([true, false, true]),
  pills: miniPills,
  podium: miniPodium,
  tierlist: miniTier,
  bubble: miniBubble,
  guess: miniGuess,
};

function newDraft() {
  return {
    step: 1,
    type: null,
    text: '',
    custom: false, // « Sur mes réponses » (never for anecdote, always for choice)
    multi: false, // choice: « Plusieurs réponses » (multiple) instead of « Une seule réponse » (single)
    answers: ['', ''],
    error: null,
    pending: false,
    sent: null, // payload accepted by the server, for the recap
  };
}

/** One proposal card: type label, text, answers when they are custom, then `actions`. */
export function proposalCard(proposal, actions = null) {
  const answers = proposal.subjects === 'custom' && Array.isArray(proposal.options) ? proposal.options : null;
  return el('article', { class: 'proposal-card' }, [
    el('p', { class: 'proposal-card__meta' }, TYPE_LABELS[proposal.type] ?? proposal.type),
    el('p', { class: 'proposal-card__text' }, proposal.text),
    answers ? el('ul', { class: 'proposal-card__answers' }, answers.map((label) => el('li', null, label))) : null,
    actions,
  ]);
}

/** Host list « Propositions à valider (n) » (SPEC T12). No author is shown. */
export function hostProposals(proposals, { busy, onAccept, onReject }) {
  return el('section', { class: 'proposals', 'aria-label': 'Propositions à valider' }, [
    el('h2', { class: 'proposals__title' }, `Propositions à valider (${proposals.length})`),
    proposals.map((proposal) =>
      proposalCard(
        proposal,
        el('div', { class: 'proposal-card__actions' }, [
          el(
            'button',
            { type: 'button', class: 'btn btn--primary', disabled: busy.has(proposal.id), onclick: () => onAccept(proposal) },
            'Ajouter',
          ),
          el(
            'button',
            { type: 'button', class: 'btn btn--ghost', disabled: busy.has(proposal.id), onclick: () => onReject(proposal) },
            'Refuser',
          ),
        ]),
      ),
    ),
  ]);
}

/** « Proposer une question » row for the lobby, with the player's own pending count. */
export function proposeRow(pendingCount, onOpen) {
  return el('div', { class: 'stack' }, [
    el(
      'button',
      { type: 'button', class: 'btn btn--ghost btn--block', onclick: (event) => onOpen(event.currentTarget) },
      'Proposer une question',
    ),
    pendingCount > 0 ? el('p', { class: 'muted' }, `${pendingCount} en attente`) : null,
  ]);
}

/**
 * The wizard. `act(event, payload, onResult)` is app.js's emitter (it refuses to send while offline and
 * always calls back). Returns `{ open(origin), close(), sync(state) }`; `sync` closes the wizard as soon
 * as the viewer is no longer a player in the lobby.
 */
export function createProposalWizard(act) {
  let draft = newDraft();
  let isOpen = false;
  let opener = null;
  const overlay = el('div', {
    class: 'wizard',
    hidden: true,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Proposer une question',
  });
  document.body.appendChild(overlay);

  function isCustom() {
    if (draft.type === 'choice') return true;
    return draft.type !== 'anecdote' && draft.custom;
  }

  function answerValues() {
    return draft.answers.map((answer) => answer.trim()).filter((answer) => answer !== '');
  }

  function hasDuplicates() {
    const values = answerValues();
    return new Set(values).size !== values.length;
  }

  function canSend() {
    if (draft.pending || draft.type === null || draft.text.trim() === '') return false;
    if (!isCustom()) return true;
    const values = answerValues();
    return values.length >= ANSWERS_MIN && !hasDuplicates();
  }

  /** Updates the send button and the duplicate hint in place (no rebuild while typing). */
  function refreshSend() {
    const sendButton = overlay.querySelector('[data-send]');
    if (sendButton) sendButton.disabled = !canSend();
    const duplicateHint = overlay.querySelector('[data-duplicate]');
    if (duplicateHint) {
      duplicateHint.hidden = !(isCustom() && answerValues().length >= ANSWERS_MIN && hasDuplicates());
    }
  }

  function render({ focus = false } = {}) {
    overlay.replaceChildren(el('div', { class: 'wizard__inner' }, pageFor(draft.step)));
    overlay.hidden = !isOpen;
    refreshSend();
    if (focus) {
      overlay.scrollTop = 0;
      overlay.querySelector('[data-focus]')?.focus();
    }
  }

  function pageFor(step) {
    if (step === 1) return kindPage();
    if (step === 2) return questionPage();
    return donePage();
  }

  function head(step, title, focusTitle = false) {
    return el('div', { class: 'wizard__head' }, [
      el('p', { class: 'eyebrow' }, `Étape ${step}/3`),
      el(
        'h2',
        { class: 'wizard__title', tabindex: focusTitle ? -1 : null, 'data-focus': focusTitle ? true : null },
        title,
      ),
    ]);
  }

  /* Step 1: the kind of question */
  function kindPage() {
    return [
      head(1, 'Quel genre de question ?'),
      el(
        'div',
        { class: 'wizard__body' },
        PROPOSAL_KINDS.map((kind, index) =>
          el(
            'button',
            {
              type: 'button',
              class: 'kind-card',
              'data-focus': index === 0 ? true : null,
              onclick: () => chooseKind(kind.type),
            },
            kindCardContent(kind),
          ),
        ),
      ),
      el(
        'div',
        { class: 'wizard__foot' },
        el('button', { type: 'button', class: 'btn btn--ghost btn--block', onclick: () => close() }, 'Annuler'),
      ),
    ];
  }

  /** Title + hint on the left, the kind's illustration on the right. */
  function kindCardContent(kind) {
    const text = [el('span', { class: 'kind-card__title' }, kind.title), el('span', { class: 'kind-card__hint' }, kind.hint)];
    const preview = KIND_PREVIEWS[kind.preview];
    if (!preview) return text;
    return [el('span', { class: 'kind-card__text' }, text), preview()];
  }

  function chooseKind(type) {
    draft.type = type;
    if (type === 'anecdote') draft.custom = false;
    draft.step = 2;
    draft.error = null;
    render({ focus: true });
  }

  /* Step 2: the question, then the answers (custom) */
  function questionPage() {
    const kind = PROPOSAL_KINDS.find((item) => item.type === draft.type);
    const anecdote = draft.type === 'anecdote';
    const custom = isCustom();

    const textInput = el('textarea', {
      class: 'wizard__input',
      rows: 3,
      maxlength: TEXT_MAX,
      placeholder: kind.placeholder,
      'aria-label': 'Ta question',
      'data-focus': true,
      oninput: (event) => {
        draft.text = event.target.value;
        refreshSend();
      },
    });
    textInput.value = draft.text;

    const children = [head(2, 'Ta question'), textInput];

    if (draft.type === 'choice') {
      children.push(
        el('div', { class: 'segmented', role: 'group', 'aria-label': 'Nombre de réponses' }, [
          segmentButton('Une seule réponse', !draft.multi, () => setMulti(false)),
          segmentButton('Plusieurs réponses', draft.multi, () => setMulti(true)),
        ]),
      );
    } else if (!anecdote) {
      children.push(
        el('div', { class: 'segmented', role: 'group', 'aria-label': 'Réponses' }, [
          segmentButton('Sur les copains', !custom, () => setCustom(false)),
          segmentButton('Sur mes réponses', custom, () => setCustom(true)),
        ]),
      );
    }

    if (custom) {
      children.push(
        el('div', { class: 'wizard__answers' }, [
          el('p', { class: 'muted' }, 'Réponses (2 à 12)'),
          draft.answers.map((_, index) => answerRow(index)),
          el('p', { class: 'muted', 'data-duplicate': true, hidden: true }, 'Deux réponses sont identiques.'),
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost btn--block',
              disabled: draft.answers.length >= ANSWERS_MAX,
              onclick: () => addAnswer(),
            },
            '+ Ajouter une réponse',
          ),
        ]),
      );
    }

    children.push(draft.error ? el('p', { class: 'error', role: 'alert' }, draft.error) : null);
    children.push(
      el('div', { class: 'wizard__foot' }, [
        el(
          'button',
          { type: 'button', class: 'btn btn--ghost', disabled: draft.pending, onclick: () => back() },
          'Retour',
        ),
        el(
          'button',
          { type: 'button', class: 'btn btn--primary', 'data-send': true, onclick: () => submit() },
          'Envoyer',
        ),
      ]),
    );
    return children;
  }

  function segmentButton(label, pressed, onSelect) {
    return el(
      'button',
      {
        type: 'button',
        class: 'segmented__btn' + (pressed ? ' is-selected' : ''),
        'aria-pressed': String(pressed),
        onclick: onSelect,
      },
      label,
    );
  }

  function setCustom(value) {
    draft.custom = value;
    draft.error = null;
    render();
  }

  function setMulti(value) {
    draft.multi = value;
    draft.error = null;
    render();
  }

  function answerRow(index) {
    const input = el('input', {
      type: 'text',
      class: 'answer-row__input',
      maxlength: ANSWER_MAX,
      placeholder: `Réponse ${index + 1}`,
      'aria-label': `Réponse ${index + 1}`,
      oninput: (event) => {
        draft.answers[index] = event.target.value;
        refreshSend();
      },
    });
    input.value = draft.answers[index];
    const remove = el(
      'button',
      {
        type: 'button',
        class: 'answer-row__remove',
        'aria-label': `Retirer la réponse ${index + 1}`,
        disabled: draft.answers.length <= ANSWERS_MIN,
        onclick: () => removeAnswer(index),
      },
      '×',
    );
    return el('div', { class: 'answer-row' }, [input, remove]);
  }

  function addAnswer() {
    if (draft.answers.length >= ANSWERS_MAX) return;
    draft.answers.push('');
    render();
  }

  function removeAnswer(index) {
    if (draft.answers.length <= ANSWERS_MIN) return;
    draft.answers.splice(index, 1);
    render();
  }

  function back() {
    if (draft.pending) return;
    draft.step = 1;
    draft.error = null;
    render({ focus: true });
  }

  function payloadOf() {
    const custom = isCustom();
    return {
      type: draft.type === 'choice' ? (draft.multi ? 'multiple' : 'single') : draft.type,
      text: draft.text.trim(),
      subjects: custom ? 'custom' : 'players',
      options: custom ? answerValues() : [],
      polarity: 'positive',
    };
  }

  function submit() {
    if (!canSend()) return;
    const current = draft;
    const payload = payloadOf();
    current.pending = true;
    current.error = null;
    render();
    act('proposal:create', payload, (res) => {
      // The wizard was closed (or restarted) while the request was in flight: ignore the ack.
      if (draft !== current || !isOpen) return;
      current.pending = false;
      if (res?.ok) {
        current.sent = payload;
        current.step = 3;
        render({ focus: true });
      } else {
        current.error = res?.reason ?? MSG_GENERIC;
        render();
      }
    });
  }

  /* Step 3: thanks and recap */
  function donePage() {
    return [
      head(3, "Merci ! L'hôte va la valider.", true),
      draft.sent ? proposalCard(draft.sent) : null,
      el('div', { class: 'wizard__foot wizard__foot--stack' }, [
        el(
          'button',
          { type: 'button', class: 'btn btn--primary btn--block', onclick: () => restart() },
          'Proposer une autre',
        ),
        el(
          'button',
          { type: 'button', class: 'btn btn--ghost btn--block', onclick: () => close() },
          'Retour au salon',
        ),
      ]),
    ];
  }

  function restart() {
    draft = newDraft();
    render({ focus: true });
  }

  function open(origin = null) {
    draft = newDraft();
    opener = origin;
    isOpen = true;
    render({ focus: true });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    draft = newDraft();
    overlay.hidden = true;
    overlay.replaceChildren();
    if (opener?.isConnected) opener.focus();
    opener = null;
  }

  function sync(state) {
    if (!isOpen) return;
    if (!state.you || state.phase !== 'lobby') {
      close();
      return;
    }
    refreshSend();
  }

  return { open, close, sync };
}
