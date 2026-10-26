// « La roue qui balance » (contract wheel, §5 and §6): the wheel shown after the results of some questions.
// The server draws everything and sends `state.round.wheel` (candidates, spin, reveal). This module only
// animates the last `state` it received and sends the host's two intentions (`round:spin`, `round:next`).
// Its overlay lives outside #app, so the re-renders of the results screen never restart it: one surprise and
// one spin per wheel (the session is keyed by the round index and the question id).
import { el, avatar } from './ui.js';

/* Timings shared with the server (contract §1), in ms. */
const WHEEL_SPIN_MS = 5200;
const WHEEL_HOLD_MS = 1100;
const WHEEL_CREEP_MS = 750;
const WHEEL_LANDED_MS = 1700;
/** Client only (contract §6): the surprise before the wheel falls. */
const SURPRISE_MS = 1300;
/** A viewer who arrives more than this far into a spin gets the final position at once (contract §5). */
const LATE_MS = 500;

const SLICE_COLORS = ['var(--accent)', 'var(--accent-2)', 'var(--sticker)'];
/** Colour of a last slice that would touch the first (yellow) one. */
const SLICE_BLUE = 'var(--surface-2)';
const SPIN_EASE = 'cubic-bezier(.12, .75, .12, 1)';
const CREEP_EASE = 'cubic-bezier(.55, 0, .35, 1)';
const BULB_COUNT = 18;
const TAPE_TEXT = 'LA ROUE QUI BALANCE ✦ '.repeat(8);
const REVEAL_LABELS = {
  single: 'Son vote secret',
  multiple: 'Ses choix secrets',
  ranking: 'Son classement secret',
  smartdumb: 'Ses votes secrets',
};

/**
 * Rotations of a spin (contract §5). Slice k spans [k*seg, (k+1)*seg] degrees clockwise from the top. The wheel
 * turns clockwise and the pointer stays at the top, so wheel angle `a` is under the pointer when the wheel is
 * rotated by `base - a`. `first` is where the pointer stops first; `final` is where the wheel rests (after the
 * creep when `suspense`, which is `first` otherwise).
 * @param {{ x: number, stop: number, suspense: boolean, creep: number, turns: number }} spin
 * @param {number} n number of candidates (slices)
 */
export function spinRotations(spin, n) {
  const seg = 360 / n;
  const base = 360 * (spin.turns + 1);
  const first = base - (spin.x * seg + spin.stop);
  const final = spin.suspense ? base - (spin.x * seg - spin.creep) : first;
  return { seg, first, final };
}

/** Conic background of the wheel: alternating slices, a navy line at each slice start. */
function wheelBackground(n) {
  const seg = 360 / n;
  const stops = [];
  for (let k = 0; k < n; k += 1) {
    let color = SLICE_COLORS[k % SLICE_COLORS.length];
    if (k === n - 1 && color === SLICE_COLORS[0]) color = SLICE_BLUE;
    stops.push(`${color} ${k * seg}deg ${(k + 1) * seg}deg`);
  }
  return `repeating-conic-gradient(var(--ink) 0 1deg, transparent 1deg ${seg}deg), conic-gradient(${stops.join(', ')})`;
}

function reducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Roster entry of a player id (guests included), or a placeholder. */
function playerOf(state, id) {
  return state.players.find((player) => player.id === id) ?? { name: '?', avatar: null, color: null };
}

function hostNameOf(state) {
  return state.players.find((player) => player.id === state.hostId)?.name ?? null;
}

/** A round item as a sticker (photo with the name on its strip), or a coloured face for a custom option. */
function itemNode(item, index) {
  if (typeof item.avatar === 'string') {
    return el('div', { class: 'tile wheel-item' }, [avatar(item, 56), el('span', { class: 'tile__name' }, item.label)]);
  }
  return el(
    'div',
    { class: 'wheel-item wheel-item--face', style: { background: `var(--pill-${(index % 6) + 1})` } },
    el('span', { class: 'wheel-item__label' }, item.label),
  );
}

/** Ranking answer: the first three places, « ⋯ » and the last when there are more than four items. */
function rankingList(items, order) {
  const last = order.length - 1;
  const row = (id, index) => {
    const item = items.find((candidate) => candidate.id === id) ?? null;
    return el('li', { class: 'wheel-rank__row' + (index === last ? ' is-last' : '') }, [
      el('em', { class: 'wheel-rank__num' }, String(index + 1)),
      item && typeof item.avatar === 'string' ? avatar(item, 26) : null,
      el('span', { class: 'wheel-rank__label' }, item ? item.label : '—'),
    ]);
  };
  const entries = [];
  if (order.length <= 4) {
    order.forEach((id, index) => entries.push(row(id, index)));
  } else {
    [0, 1, 2].forEach((index) => entries.push(row(order[index], index)));
    entries.push(el('li', { class: 'wheel-rank__gap' }, '⋯'));
    entries.push(row(order[last], last));
  }
  return el('ol', { class: 'wheel-rank' }, entries);
}

/** The secret answer of the winner, by question type (contract §6). `answer` null: no answer. */
function answerNode(round, answer) {
  if (answer === null || answer === undefined) return el('p', { class: 'wheel-noanswer' }, 'Pas de réponse');
  const items = round.items;
  const node = (id) => {
    const index = items.findIndex((item) => item.id === id);
    return index < 0 ? el('p', { class: 'wheel-noanswer' }, '—') : itemNode(items[index], index);
  };
  switch (round.question.type) {
    case 'single':
      return el('div', { class: 'wheel-picks' }, node(answer.choice));
    case 'multiple':
      return el('div', { class: 'wheel-picks' }, (answer.choices ?? []).map((id) => node(id)));
    case 'ranking':
      return rankingList(items, answer.order ?? []);
    case 'smartdumb':
      return el('div', { class: 'wheel-sd' }, [
        el('div', { class: 'wheel-sd__col' }, [node(answer.smart), el('span', { class: 'wheel-tag is-smart' }, 'Intelligent')]),
        el('div', { class: 'wheel-sd__col' }, [node(answer.dumb), el('span', { class: 'wheel-tag is-dumb' }, 'Débile')]),
      ]);
    default:
      return null;
  }
}

/** The « dos de vignette » card: the question, the label of the secret answer, the answer. */
function revealCard(round, reveal) {
  const incomplete = round.question.type === 'ranking' && reveal.incomplete === true;
  return el('div', { class: 'wheel-card' }, [
    el('p', { class: 'wheel-card__q' }, `« ${round.question.text} »`),
    el('p', { class: 'wheel-card__label' }, [
      REVEAL_LABELS[round.question.type] ?? '',
      incomplete ? el('span', { class: 'wheel-card__note' }, ' (incomplet)') : null,
    ]),
    answerNode(round, reveal.answer),
  ]);
}

/** The winner's big sticker with the « Balancé ! » stamp. */
function heroNode(player) {
  return el('div', { class: 'wheel-hero' }, [
    el('div', { class: 'tile wheel-hero__card' }, [avatar(player, 120), el('span', { class: 'tile__name' }, player.name)]),
    el('span', { class: 'wheel-stamp' }, 'Balancé !'),
  ]);
}

/** Builds the overlay for one wheel (not yet in the document) and the session that drives it. */
function openSession(key, wheel, state, act) {
  const candidates = wheel.candidates;
  const n = candidates.length;
  const seg = 360 / n;

  const s = {
    key,
    act,
    state,
    wheel,
    candidates,
    run: 0, // every running step holds the run it started with; a change cancels them
    anim: null,
    angle: 0,
    stage: null,
    spun: false,
    landed: false,
    revealed: false,
    closed: false,
    spinSending: false,
    nextSending: false,
    errorText: null,
  };

  const hl = el('div', { class: 'wheel-hl' });
  s.faces = candidates.map((id, k) =>
    el(
      'span',
      { class: 'wheel-face', style: { '--a': `${(k + 0.5) * seg}deg` } },
      avatar(playerOf(state, id), 40),
    ),
  );
  s.disc = el('div', { class: 'wheel-disc', style: { background: wheelBackground(n) } }, [hl, ...s.faces]);
  s.disc.style.transform = 'rotate(0deg)';
  s.hl = hl;
  s.hub = el('div', { class: 'wheel-hub' }, '?');
  s.pin = el('div', { class: 'wheel-pin' }, el('i'));
  const bulbs = Array.from({ length: BULB_COUNT }, (_, i) =>
    el('i', { class: 'wheel-bulb', style: { '--b': `${i * (360 / BULB_COUNT)}deg` } }),
  );
  const wrap = el('div', { class: 'wheel-wrap', style: { '--seg': `${seg}deg` } }, [s.disc, ...bulbs, s.hub, s.pin]);

  s.cta = el(
    'button',
    { type: 'button', class: 'btn btn--primary btn--block wheel-cta', onclick: () => spinClick(s) },
    'Faire tourner !',
  );
  s.waitLead = el('span');
  s.landName = el('b');
  const foot = el('div', { class: 'wheel-foot' }, [
    s.cta,
    el('p', { class: 'wheel-wait' }, [
      s.waitLead,
      el('small', null, `Sur la roue : les ${n} copains qui ont répondu`),
    ]),
    el('p', { class: 'wheel-spin' }, 'Ça tourne…'),
    el('p', { class: 'wheel-hold' }, 'Ça hésite…'),
    el('p', { class: 'wheel-land' }, ["C'est tombé sur ", s.landName, ' !']),
  ]);
  const wheelLayer = el('div', { class: 'wheel-layer wheel-layer--wheel' }, [
    el('div', { class: 'wheel-title' }, ['La roue', el('span', null, 'qui balance')]),
    el('p', { class: 'wheel-sub' }, 'Une réponse secrète va être dévoilée…'),
    wrap,
    foot,
  ]);

  s.heroSlot = el('div', { class: 'wheel-hero-slot' });
  s.cardSlot = el('div', { class: 'wheel-card-slot' });
  s.next = el(
    'button',
    { type: 'button', class: 'btn btn--primary btn--block wheel-next', onclick: () => nextClick(s) },
    'Question suivante',
  );
  s.revealWait = el('p', { class: 'wheel-reveal-wait' }, "En attente de l'hôte…");
  const revealLayer = el('div', { class: 'wheel-layer wheel-layer--reveal' }, [
    el('p', { class: 'wheel-kicker' }, 'La roue balance…'),
    s.heroSlot,
    s.cardSlot,
    s.next,
    s.revealWait,
  ]);

  s.errorEl = el('p', { class: 'wheel-error', role: 'alert', hidden: true });
  s.root = el(
    'div',
    { class: 'wheel-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'La roue qui balance' },
    [
      el('div', { class: 'wheel-screen__backdrop' }),
      el('div', { class: 'wheel-screen__tapes', 'aria-hidden': 'true' }, [
        el('div', { class: 'wheel-tape wheel-tape--a' }, el('span', null, TAPE_TEXT)),
        el('div', { class: 'wheel-tape wheel-tape--b' }, el('span', null, TAPE_TEXT)),
      ]),
      el('div', { class: 'wheel-screen__flash' }),
      el('div', { class: 'wheel-screen__panel' }, [wheelLayer, revealLayer, s.errorEl]),
    ],
  );
  document.body.appendChild(s.root);
  return s;
}

function setStage(s, stage) {
  if (s.stage === stage) return;
  s.stage = stage;
  s.root.dataset.stage = stage;
}

/** Host or not, pending buttons, error line and the names in the texts. Cheap: called on every step. */
function updateControls(s) {
  const host = s.state.you?.isHost === true;
  s.root.classList.toggle('is-host', host);
  s.root.classList.toggle('is-copain', !host);
  s.cta.disabled = s.spinSending;
  s.next.disabled = s.nextSending;
  s.waitLead.textContent = `${hostNameOf(s.state) ?? "L'hôte"} va lancer la roue…`;
  s.errorEl.hidden = s.errorText === null;
  s.errorEl.textContent = s.errorText ?? '';
}

/** Runs `fn` after `ms`, unless the run has changed meanwhile. */
function pause(s, run, ms) {
  return new Promise((resolve) => setTimeout(resolve, ms)).then(() => run === s.run);
}

/** Index of the winner among the candidates (the server's `spin.winnerId`). */
function winnerIndex(s) {
  const index = s.candidates.indexOf(s.wheel.spin?.winnerId);
  return index < 0 ? 0 : index;
}

/** Highlights the winner's slice and face and sets the landing hub; the stage is set by the caller. */
function markLanded(s) {
  const index = winnerIndex(s);
  const seg = 360 / s.candidates.length;
  s.faces.forEach((face, k) => {
    face.classList.toggle('is-won', k === index);
    face.classList.toggle('is-lost', k !== index);
  });
  s.hub.textContent = '!';
  s.hl.style.setProperty('--from', `${index * seg}deg`);
  s.landName.textContent = playerOf(s.state, s.candidates[index]).name;
}

/** Pointer ticks: each slice edge that passes under the pointer clicks it (rAF on the computed rotation). */
function trackPointer(s, run, ms) {
  const seg = 360 / s.candidates.length;
  const under = () => {
    const match = getComputedStyle(s.disc).transform.match(/matrix\(([^)]+)\)/);
    if (!match) return -1;
    const [a, b] = match[1].split(',').map(Number);
    const angle = (Math.atan2(b, a) * 180) / Math.PI;
    // Wheel angle under the pointer: the wheel is turned by `angle`, so the pointer sees -angle.
    const pointed = ((-angle % 360) + 360) % 360;
    return Math.floor(pointed / seg);
  };
  const quiet = reducedMotion();
  let last = under();
  const t0 = performance.now();
  const frame = (now) => {
    if (run !== s.run) return;
    const current = under();
    if (current !== last && !quiet) {
      s.pin.classList.remove('is-tick');
      void s.pin.offsetWidth;
      s.pin.classList.add('is-tick');
    }
    last = current;
    if (now - t0 < ms + 50) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Turns the wheel to `to` degrees in `ms`. Resolves true at the end, false when the run has changed. */
function rotate(s, run, to, ms, easing) {
  const anim = s.disc.animate(
    [{ transform: `rotate(${s.angle}deg)` }, { transform: `rotate(${to}deg)` }],
    { duration: ms, easing, fill: 'forwards' },
  );
  s.anim = anim;
  trackPointer(s, run, ms);
  return anim.finished.then(
    () => {
      if (run !== s.run) return false;
      s.disc.style.transform = `rotate(${to}deg)`;
      anim.cancel();
      s.anim = null;
      s.angle = to;
      return true;
    },
    () => false,
  );
}

/** The wheel rests on its final position at once, no animation (late viewers and reconnections). */
function landStatic(s) {
  s.spun = true;
  s.run += 1;
  s.anim?.cancel();
  s.anim = null;
  const { final } = spinRotations(s.wheel.spin, s.candidates.length);
  s.angle = final;
  s.disc.style.transform = `rotate(${final}deg)`;
  markLanded(s);
  s.landed = true;
  setStage(s, 'landed');
}

/** The spin as the client shows it: stop, optional suspense (hold, creep), landing. Same durations as the server. */
async function runSpin(s, run) {
  const { spin } = s.wheel;
  const { first, final } = spinRotations(spin, s.candidates.length);
  setStage(s, 'spin');
  if (!(await rotate(s, run, first, WHEEL_SPIN_MS, SPIN_EASE))) return;
  if (spin.suspense) {
    setStage(s, 'hold');
    s.pin.classList.add('is-strain');
    if (!(await pause(s, run, WHEEL_HOLD_MS))) return;
    s.pin.classList.remove('is-strain');
    if (!(await rotate(s, run, final, WHEEL_CREEP_MS, CREEP_EASE))) return;
  }
  markLanded(s);
  setStage(s, 'landed');
  if (!(await pause(s, run, WHEEL_LANDED_MS))) return;
  s.landed = true;
  if (s.wheel.status === 'done') showReveal(s);
  updateControls(s);
}

function startSpin(s) {
  s.spun = true;
  // Cancels the surprise timer and any running step.
  const run = ++s.run;
  if ((s.wheel.elapsedMs ?? 0) > LATE_MS) {
    landStatic(s);
    return;
  }
  runSpin(s, run);
}

/** Fills the reveal once (the answer is secret until now), then shows it. */
function showReveal(s) {
  if (!s.revealed) {
    const { reveal } = s.wheel;
    if (reveal) {
      s.heroSlot.replaceChildren(heroNode(playerOf(s.state, reveal.playerId)));
      s.cardSlot.replaceChildren(revealCard(s.state.round, reveal));
    }
    s.revealed = true;
  }
  setStage(s, 'reveal');
}

/** Moves the session to the stage the last `state` calls for. Idempotent: called on every render. */
function advance(s) {
  const { wheel } = s;
  if (s.stage === null) {
    if (wheel.status === 'ready') {
      setStage(s, 'alert');
      const run = ++s.run;
      setTimeout(() => {
        if (run === s.run) setStage(s, 'ready');
      }, SURPRISE_MS);
    } else if (wheel.status === 'spinning') {
      startSpin(s);
    } else {
      landStatic(s);
    }
  } else if (!s.spun && wheel.status === 'spinning') {
    startSpin(s);
  } else if (!s.spun && wheel.status === 'done') {
    landStatic(s);
  }
  // The spin request is answered once the wheel left `ready`.
  if (wheel.status !== 'ready') s.spinSending = false;
  if (wheel.status === 'done' && s.landed) showReveal(s);
  updateControls(s);
}

/** Host: « Faire tourner ! » (SPEC §8 round:spin). The server answers the ack; the spin comes with the next state. */
function spinClick(s) {
  if (s.spinSending) return;
  s.spinSending = true;
  s.errorText = null;
  updateControls(s);
  s.act('round:spin', null, (res) => {
    if (s.closed) return;
    if (!res.ok) {
      s.spinSending = false;
      s.errorText = res.reason;
    }
    updateControls(s);
  });
}

/** Host: « Question suivante » on the reveal (SPEC §8 round:next, the same as on the results). */
function nextClick(s) {
  if (s.nextSending) return;
  s.nextSending = true;
  s.errorText = null;
  updateControls(s);
  s.act('round:next', null, (res) => {
    if (s.closed) return;
    if (!res.ok) {
      s.nextSending = false;
      s.errorText = res.reason;
    }
    updateControls(s);
  });
}

/**
 * Wheel view. `act` is the app's emitter (ack `{ ok, reason? }`). `sync(state)` is called on every render: it opens
 * the overlay when `state.round.wheel` appears in the results, moves it through its stages, and closes it when the
 * wheel is gone (next round, new game, not in the results).
 */
export function createWheelView(act) {
  /** Session of the wheel on screen, or null. */
  let session = null;

  function close() {
    if (!session) return;
    session.closed = true;
    session.run += 1;
    session.anim?.cancel();
    session.root.remove();
    session = null;
  }

  function sync(state) {
    const round = state.round;
    const wheel = state.you && state.phase === 'results' && round ? (round.wheel ?? null) : null;
    if (!wheel) {
      close();
      return;
    }
    const key = `${round.index}:${round.question.id}`;
    if (!session || session.key !== key) {
      close();
      session = openSession(key, wheel, state, act);
    }
    session.state = state;
    session.wheel = wheel;
    advance(session);
  }

  return { sync };
}
