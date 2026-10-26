// Page admin (SPEC §9 API, §10 « Page admin »). Talks only to /api/admin/*.
// Server-provided text is always written with textContent, never innerHTML.

const PIN_KEY = 'quiz-admin-pin';
const POLL_MS = 2000;
const TOO_MANY = "Trop d'essais, réessaie dans une minute";
const PIN_INVALID = 'PIN admin invalide';

const TYPE_ORDER = ['single', 'multiple', 'ranking', 'smartdumb', 'tierlist', 'anecdote', 'guess', 'which'];
const TYPE_LABELS = {
  single: 'QCU',
  multiple: 'QCM',
  ranking: 'Classement',
  smartdumb: 'Intelligent / Débile',
  tierlist: 'Tierlist',
  anecdote: 'Anecdote',
  guess: 'Devine sa réponse',
  which: 'Quelle était la question ?',
};
// Types where a question can be negative (SPEC §5 polarity). Intelligent / Débile, Anecdote, Devine sa réponse
// and Quelle était la question ? never are.
const NEGATIVE_TYPES = ['single', 'multiple', 'ranking', 'tierlist'];
// Timer pre-filled when a new anecdote question is started (SPEC T9: anecdote default 180 s).
const ANECDOTE_TIMER = 180;
// Timer pre-filled when a new « Quelle était la question ? » is started (contract which: default 45 s).
const WHICH_TIMER = 45;
// Possible questions of « Quelle était la question ? » (contract which: 3 to 5 variants).
const VARIANT_MIN = 3;
const VARIANT_MAX = 5;
const VARIANT_LENGTH = 200;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const $ = (id) => document.getElementById(id);
const enc = (value) => encodeURIComponent(value);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(label, className, act) {
  const button = el('button', className, label);
  button.type = 'button';
  button.dataset.act = act;
  return button;
}

const els = {
  global: $('global-error'),
  logout: $('logout'),
  pinScreen: $('pin-screen'),
  pinForm: $('pin-form'),
  pinInput: $('pin-input'),
  pinSubmit: $('pin-submit'),
  pinError: $('pin-error'),
  boot: $('boot'),
  app: $('admin-app'),
  accessLabel: $('access-label'),
  btnAccess: $('btn-access'),
  accessError: $('access-error'),
  phase: $('phase-label'),
  btnReveal: $('btn-reveal'),
  btnNext: $('btn-next'),
  btnReset: $('btn-reset'),
  pilotError: $('pilot-error'),
  settingsForm: $('settings-form'),
  setLimit: $('set-limit'),
  setWheel: $('set-wheel'),
  settingsCount: $('settings-count'),
  settingsError: $('settings-error'),
  settingsSaved: $('settings-saved'),
  settingsSubmit: $('settings-submit'),
  playersStatus: $('players-status'),
  playersList: $('players-list'),
  playersEmpty: $('players-empty'),
  guestsStatus: $('guests-status'),
  guestsList: $('guests-list'),
  guestsEmpty: $('guests-empty'),
  qNew: $('q-new'),
  qForm: $('q-form'),
  qFormTitle: $('q-form-title'),
  qType: $('q-type'),
  qText: $('q-text'),
  qTextLabel: $('q-text-label'),
  qVariantsWrap: $('q-variants-wrap'),
  qVariants: $('q-variants'),
  qVariantAdd: $('q-variant-add'),
  qAnswerKindWrap: $('q-answer-kind-wrap'),
  qSubjectsWrap: $('q-subjects-wrap'),
  qGuessPlayersWrap: $('q-guess-players-wrap'),
  qOptionsWrap: $('q-options-wrap'),
  qOptions: $('q-options'),
  qMaxWrap: $('q-max-wrap'),
  qMax: $('q-max'),
  qNegativeWrap: $('q-negative-wrap'),
  qNegative: $('q-negative'),
  qTimer: $('q-timer'),
  qEnabled: $('q-enabled'),
  qSubmit: $('q-submit'),
  qCancel: $('q-cancel'),
  qError: $('q-error'),
  qList: $('q-list'),
  qEmpty: $('q-empty'),
  qNoMatch: $('q-nomatch'),
  qListError: $('q-list-error'),
  fText: $('f-text'),
  fType: $('f-type'),
  fStatus: $('f-status'),
  fReset: $('f-reset'),
  qCount: $('q-count'),
};

// --- State ---------------------------------------------------------------

let authed = false;          // true once a PIN has been validated and not rejected since
let memoryPin = null;        // fallback when sessionStorage is unavailable
let settings = null;         // last saved settings (GET/PUT response)
let questions = [];          // last known list of questions
let editingId = null;        // id of the question being edited, null when creating
const playersById = new Map();
const playerRows = new Map(); // id -> row refs (keyed so that focus and scroll survive re-renders)
let guests = [];             // last list from GET /api/admin/guests (SPEC T13)
// guest id -> visibility the host just set, while its POST is in flight (the switch keeps it until settled)
const pendingVisible = new Map();
let pollTimer = null;
let pollBusy = false;
let pollQueued = false;
// Filter over the questions list (SPEC T15). Module state, so it survives every list reload.
const questionFilter = { text: '', type: '', status: '' }; // status: '' | 'enabled' | 'disabled' | 'pending'

// --- PIN storage (sessionStorage, with an in-memory fallback) ------------

function readPin() {
  try {
    const stored = sessionStorage.getItem(PIN_KEY);
    if (stored) return stored;
  } catch {
    // Storage unavailable: fall back to memory.
  }
  return memoryPin;
}

function storePin(pin) {
  memoryPin = pin;
  try {
    sessionStorage.setItem(PIN_KEY, pin);
  } catch {
    // Storage unavailable: memory copy only.
  }
}

function clearPin() {
  memoryPin = null;
  try {
    sessionStorage.removeItem(PIN_KEY);
  } catch {
    // Nothing to clear.
  }
}

// --- HTTP ----------------------------------------------------------------

/** Raw request. Never throws on HTTP errors; throws ApiError(0) only when the server is unreachable. */
async function send(method, path, body, pin) {
  const headers = {};
  if (pin) headers['x-admin-pin'] = pin;
  const init = { method, headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Serveur injoignable');
  }
  let data = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  return { status: res.status, ok: res.ok, data };
}

/**
 * Admin API call with the stored PIN.
 * 401 clears the PIN and shows the PIN screen; 429 throws the « Trop d'essais » message;
 * other errors throw with the server `error` text.
 */
async function api(method, path, body) {
  const res = await send(method, path, body, readPin());
  if (res.status === 401) {
    clearPin();
    showPinScreen(PIN_INVALID);
    throw new ApiError(401, PIN_INVALID);
  }
  if (res.status === 429) {
    throw new ApiError(429, TOO_MANY);
  }
  if (!res.ok) {
    throw new ApiError(res.status, res.data?.error || `Erreur ${res.status}`);
  }
  return res.data;
}

/** Shows an error in `target`. A 401 is silent: the PIN screen already explains it. */
function fail(target, err) {
  if (err instanceof ApiError && err.status === 401) return;
  target.textContent = err instanceof Error ? err.message : 'Erreur inattendue';
  target.hidden = false;
}

// --- Screens -------------------------------------------------------------

function showPinScreen(message = '') {
  authed = false;
  stopPolling();
  els.app.hidden = true;
  els.logout.hidden = true;
  els.boot.hidden = true;
  els.global.hidden = true;
  els.pinScreen.hidden = false;
  els.pinSubmit.disabled = false;
  els.pinError.textContent = message;
  els.pinError.hidden = message === '';
  els.pinInput.value = '';
  els.pinInput.focus();
}

async function enterAdmin() {
  authed = true;
  els.pinInput.value = '';
  els.pinScreen.hidden = true;
  els.boot.hidden = true;
  els.app.hidden = false;
  els.logout.hidden = false;
  try {
    await Promise.all([loadSettings(), loadQuestions()]);
  } catch (err) {
    fail(els.global, err);
  }
  if (authed) startPolling();
}

/** Validates a PIN with GET /api/admin/check before storing it. */
async function verifyPin(pin, fromStorage) {
  let res;
  try {
    res = await send('GET', '/api/admin/check', undefined, pin);
  } catch (err) {
    if (fromStorage) {
      showPinScreen(err.message);
    } else {
      els.pinError.textContent = err.message;
      els.pinError.hidden = false;
    }
    return;
  }
  if (res.status === 204) {
    storePin(pin);
    await enterAdmin();
    return;
  }
  if (res.status === 401) {
    clearPin();
    showPinScreen(PIN_INVALID);
    return;
  }
  if (res.status === 429) {
    showPinScreen(TOO_MANY);
    return;
  }
  showPinScreen(res.data?.error || `Erreur ${res.status}`);
}

// --- Partie --------------------------------------------------------------

function phaseText({ phase, round }) {
  if (phase === 'lobby') return 'Salon';
  if (phase === 'question' && round) return `Question ${round.index + 1}/${round.total}`;
  if (phase === 'results' && round) return `Résultats ${round.index + 1}/${round.total}`;
  if (phase === 'end') return 'Fin';
  return phase;
}

/** Access gate (SPEC §9 /api/admin/access), from the last players poll; null before the first one. */
let accessOpen = null;

function updatePartie(data) {
  accessOpen = data.accessOpen === true;
  els.accessLabel.textContent = accessOpen ? 'Session ouverte' : 'Session fermée';
  els.accessLabel.classList.toggle('is-open', accessOpen);
  els.btnAccess.textContent = accessOpen ? 'Fermer la session' : 'Lancer la session';
  els.btnAccess.className = accessOpen ? 'btn btn--ghost' : 'btn btn--primary';
  els.btnAccess.disabled = false;
  els.phase.textContent = phaseText(data);
  els.btnReveal.hidden = data.phase !== 'question';
  els.btnNext.hidden = data.phase !== 'results';
  els.btnReset.hidden = data.phase === 'lobby';
}

async function toggleAccess() {
  if (accessOpen === null) return;
  els.accessError.hidden = true;
  els.btnAccess.disabled = true;
  try {
    await api('POST', '/api/admin/access', { open: !accessOpen });
    requestRefresh();
  } catch (err) {
    fail(els.accessError, err);
    els.btnAccess.disabled = false;
  }
}

async function pilot(path, button, confirmMessage) {
  if (confirmMessage && !confirm(confirmMessage)) return;
  els.pilotError.hidden = true;
  button.disabled = true;
  try {
    await api('POST', path);
    requestRefresh();
  } catch (err) {
    fail(els.pilotError, err);
  } finally {
    button.disabled = false;
  }
}

function parseOptionalInt(raw) {
  const text = raw.trim();
  if (text === '') return null;
  // Non-integer text is sent as-is so that the server answers 400 with its French message.
  return /^-?\d+$/.test(text) ? Number(text) : text;
}

/** « − » / « + » next to a count input (data-min / data-max). From empty, « + » starts at the minimum. */
function stepCount(input, delta) {
  const min = Number(input.dataset.min);
  const max = Number(input.dataset.max);
  const text = input.value.trim();
  if (/^\d+$/.test(text)) {
    input.value = String(Math.min(max, Math.max(min, Number(text) + delta)));
  } else {
    if (delta < 0) return;
    input.value = String(min);
  }
  // Same path as typing, so existing listeners and validation run.
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Digits only (timers): removes anything that is not 0-9, whatever the source (typing, paste, autofill, IME). */
function keepDigits(input) {
  const digits = input.value.replace(/\D/g, '');
  if (digits !== input.value) input.value = digits;
}

/** Inserts only the digits of `text` at the caret, replacing the selection and respecting maxlength. */
function insertDigits(input, text) {
  const digits = text.replace(/\D/g, '');
  const maxLength = input.maxLength > 0 ? input.maxLength : Infinity;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const head = input.value.slice(0, start) + digits;
  input.value = (head + input.value.slice(end)).replace(/\D/g, '').slice(0, maxLength);
  const caret = Math.min(head.length, input.value.length);
  input.setSelectionRange(caret, caret);
}

function bindDigitsOnly(input) {
  input.addEventListener('beforeinput', (event) => {
    // Deletions and navigation carry no data. An insertion with non-digits keeps only its digits.
    if (event.inputType.startsWith('insert') && event.data && /\D/.test(event.data)) {
      event.preventDefault();
      insertDigits(input, event.data);
    }
  });
  input.addEventListener('input', () => keepDigits(input));
  input.addEventListener('paste', (event) => {
    event.preventDefault();
    insertDigits(input, event.clipboardData?.getData('text') ?? '');
  });
}

/** Seconds on blur: clamp to 0..59 and pad to 2 digits when minutes are set. */
function normalizeSeconds(pair) {
  const minutes = partOf(pair, 'min');
  const seconds = partOf(pair, 'sec');
  if (seconds.value === '') return;
  const value = Math.min(59, Number(seconds.value));
  seconds.value = minutes.value !== '' ? String(value).padStart(2, '0') : String(value);
}

function partOf(pair, part) {
  return pair.querySelector(`[data-part="${part}"]`);
}

/** Timer = minutes * 60 + seconds (integer). Both empty → null (per-type: timer of each question). */
function readTimer(pair) {
  const minutes = partOf(pair, 'min').value;
  const seconds = partOf(pair, 'sec').value;
  if (minutes === '' && seconds === '') return null;
  return Number(minutes || 0) * 60 + Number(seconds || 0);
}

/** Splits stored seconds into the minutes and seconds fields; null empties both. */
function writeTimer(pair, seconds) {
  if (seconds === null) {
    partOf(pair, 'min').value = '';
    partOf(pair, 'sec').value = '';
    return;
  }
  partOf(pair, 'min').value = String(Math.floor(seconds / 60));
  partOf(pair, 'sec').value = String(seconds % 60).padStart(2, '0');
}

/** One timer per question type (SPEC T14), each pair carries its type in `data-timer-type`. */
function timerPairs() {
  return [...document.querySelectorAll('.timer-pair[data-timer-type]')];
}

function typeBoxes() {
  return [...document.querySelectorAll('input[name="set-type"]')];
}

function fillSettingsForm(s) {
  els.setLimit.value = s.questionLimit === null ? '' : String(s.questionLimit);
  // Server default (contract wheel §2) when the key is missing from an older settings file.
  els.setWheel.value = String(s.wheelChance ?? 20);
  for (const pair of timerPairs()) {
    writeTimer(pair, s.timerByType?.[pair.dataset.timerType] ?? null);
  }
  for (const box of typeBoxes()) box.checked = s.types.includes(box.value);
}

function readSettingsForm() {
  const checked = typeBoxes().filter((box) => box.checked).map((box) => box.value);
  const timerByType = {};
  for (const pair of timerPairs()) {
    timerByType[pair.dataset.timerType] = readTimer(pair);
  }
  return {
    questionLimit: parseOptionalInt(els.setLimit.value),
    // Empty → null: the server keeps its default (20), as for the question limit it is read back on load.
    wheelChance: parseOptionalInt(els.setWheel.value),
    timerByType,
    types: TYPE_ORDER.filter((type) => checked.includes(type)),
  };
}

/** « N questions jouables » = min(limit, enabled questions whose type is checked in the SAVED settings). */
function updatePlayableCount() {
  if (!settings) {
    els.settingsCount.textContent = '';
    return;
  }
  const matching = questions.filter((q) => q.enabled && settings.types.includes(q.type)).length;
  const n = Math.min(settings.questionLimit ?? Infinity, matching);
  els.settingsCount.textContent = `${n} question${n > 1 ? 's' : ''} jouable${n > 1 ? 's' : ''}`;
}

async function loadSettings() {
  settings = await api('GET', '/api/admin/settings');
  fillSettingsForm(settings);
  updatePlayableCount();
}

// --- Joueurs -------------------------------------------------------------

function initialOf(name) {
  return name.trim().charAt(0).toUpperCase() || '?';
}

function buildPlayerRow(p) {
  const li = el('li', 'player');
  li.dataset.id = p.id;

  const avatar = el('div', 'avatar');
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('error', () => {
    avatar.classList.add('avatar--fallback');
    avatar.textContent = initialOf(p.name);
  });
  img.src = p.avatar;
  avatar.append(img);

  const info = el('div', 'player-info');
  const name = el('p', 'player-name');
  const meta = el('p', 'player-meta');
  const status = el('span', 'muted');
  const host = el('span', 'badge', 'Hôte');
  const round = el('span', 'muted');
  meta.append(status, host, round);
  info.append(name, meta);

  const actions = el('div', 'player-actions');
  const makeHost = actionButton('Rendre hôte', 'btn btn--ghost btn--sm', 'host');
  const kick = actionButton('Exclure', 'btn btn--danger btn--sm', 'kick');
  actions.append(makeHost, kick);

  li.append(avatar, info, actions);
  return { li, name, status, host, round, makeHost };
}

function roundState(p) {
  if (!p.isParticipant) return 'spectateur';
  return p.hasAnswered ? 'a répondu ✓' : 'en attente';
}

function updatePlayerRow(row, p, phase) {
  const online = p.status === 'online';
  row.li.classList.toggle('is-offline', !online);
  row.name.textContent = p.name;
  row.status.textContent = online ? 'en ligne' : 'hors ligne';
  row.host.hidden = !p.isHost;
  row.makeHost.hidden = !online || p.isHost;
  row.round.hidden = phase !== 'question';
  if (phase === 'question') row.round.textContent = roundState(p);
}

/** Renders the visible players (status !== 'free') in ROSTER order, reusing existing rows. */
function renderPlayers(data) {
  const visible = [];
  playersById.clear();
  for (const p of data.players) {
    playersById.set(p.id, p);
    if (p.status !== 'free') visible.push(p);
  }

  const seen = new Set();
  visible.forEach((p, index) => {
    seen.add(p.id);
    let row = playerRows.get(p.id);
    if (!row) {
      row = buildPlayerRow(p);
      playerRows.set(p.id, row);
    }
    updatePlayerRow(row, p, data.phase);
    const expected = els.playersList.children[index];
    if (expected !== row.li) els.playersList.insertBefore(row.li, expected ?? null);
  });

  for (const [id, row] of playerRows) {
    if (!seen.has(id)) {
      row.li.remove();
      playerRows.delete(id);
    }
  }
  els.playersEmpty.hidden = visible.length > 0;
  refreshAuthors();
}

// --- Invités (SPEC T13) --------------------------------------------------

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function buildGuestRow(guest) {
  const li = el('li', 'player');
  li.dataset.id = guest.id;

  const avatar = el('div', 'avatar');
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('error', () => {
    avatar.classList.add('avatar--fallback');
    avatar.textContent = initialOf(guest.name);
  });
  img.src = guest.avatar;
  avatar.append(img);

  const info = el('div', 'player-info');
  info.append(el('p', 'player-name', guest.name), el('p', 'player-meta', `Créé le ${formatDate(guest.createdAt)}`));

  const inFlight = pendingVisible.has(guest.id);
  const toggle = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.dataset.act = 'visible';
  input.checked = inFlight ? pendingVisible.get(guest.id) : guest.visible;
  input.disabled = inFlight;
  toggle.append(input, el('span', null, 'Affiché dans la liste'));

  const actions = el('div', 'player-actions');
  actions.append(actionButton('Supprimer', 'btn btn--danger btn--sm', 'delete'));

  li.append(avatar, info, toggle, actions);
  return li;
}

/** Rebuilds the guest list from `guests`, keeping keyboard focus on the same control. */
function renderGuests() {
  const active = document.activeElement;
  let focusTarget = null;
  if (active && els.guestsList.contains(active) && active.dataset.act) {
    focusTarget = { id: active.closest('li')?.dataset.id, act: active.dataset.act };
  }
  els.guestsList.replaceChildren(...guests.map(buildGuestRow));
  els.guestsEmpty.hidden = guests.length > 0;
  if (focusTarget) {
    const item = [...els.guestsList.querySelectorAll('li')].find((li) => li.dataset.id === focusTarget.id);
    item?.querySelector(`[data-act="${focusTarget.act}"]`)?.focus();
  }
}

/** Reloads the guests (part of the players poll). Its errors stay until the next action. */
async function refreshGuests() {
  try {
    guests = await api('GET', '/api/admin/guests');
    renderGuests();
  } catch (err) {
    fail(els.guestsStatus, err);
  }
}

async function setGuestVisible(id, visible, input) {
  els.guestsStatus.hidden = true;
  pendingVisible.set(id, visible);
  input.disabled = true;
  try {
    await api('POST', `/api/admin/guests/${enc(id)}/visible`, { visible });
  } catch (err) {
    fail(els.guestsStatus, err);
  } finally {
    pendingVisible.delete(id);
    requestRefresh();
  }
}

async function deleteGuest(guest) {
  if (!confirm(`Supprimer l'invité ${guest.name} ?`)) return;
  els.guestsStatus.hidden = true;
  try {
    await api('DELETE', `/api/admin/guests/${enc(guest.id)}`);
    requestRefresh();
  } catch (err) {
    // 409 « Invité en jeu » (seated in a game) is shown as is.
    fail(els.guestsStatus, err);
  }
}

async function playerAction(path, button) {
  els.playersStatus.hidden = true;
  button.disabled = true;
  try {
    await api('POST', path);
    requestRefresh();
  } catch (err) {
    fail(els.playersStatus, err);
  } finally {
    button.disabled = false;
  }
}

// Polling: one request at a time, every POLL_MS, stopped while the PIN screen is shown.

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
  pollQueued = false;
}

function startPolling() {
  stopPolling();
  pollOnce();
}

/** Refreshes now (after an action); if a poll is already in flight, one more runs right after it. */
function requestRefresh() {
  if (!authed) return;
  if (pollBusy) {
    pollQueued = true;
    return;
  }
  pollOnce();
}

async function pollOnce() {
  if (!authed || pollBusy) return;
  pollBusy = true;
  clearTimeout(pollTimer);
  pollTimer = null;
  try {
    try {
      const data = await api('GET', '/api/admin/players');
      renderPlayers(data);
      updatePartie(data);
      els.playersStatus.hidden = true;
    } catch (err) {
      fail(els.playersStatus, err);
    }
    if (authed) await refreshGuests();
  } finally {
    pollBusy = false;
    if (authed) {
      if (pollQueued) {
        pollQueued = false;
        pollOnce();
      } else {
        pollTimer = setTimeout(pollOnce, POLL_MS);
      }
    }
  }
}

// --- Questions -----------------------------------------------------------

async function loadQuestions() {
  questions = await api('GET', '/api/admin/questions');
  renderQuestions();
  updatePlayableCount();
}

function questionBody(q) {
  return {
    type: q.type,
    text: q.text,
    subjects: q.subjects,
    options: q.options,
    maxChoices: q.maxChoices,
    timer: q.timer,
    enabled: q.enabled,
    // Sent back on every update (the list toggle included), so a negative question stays negative.
    polarity: q.polarity === 'negative' ? 'negative' : 'positive',
    // Same for the players of a guess (null on other questions): a toggle keeps 'all' as it is.
    guessPlayers: q.guessPlayers,
    // Same for the possible questions and the answer kind of « Quelle était la question ? » (null otherwise).
    variants: q.variants ?? null,
    answerKind: q.answerKind ?? null,
  };
}

/** Author name of a pending proposal, from the players list; the raw id when the roster is not loaded yet. */
function authorName(playerId) {
  if (!playerId) return '?';
  return playersById.get(playerId)?.name ?? playerId;
}

/** Keeps the « proposée par » names in step with the players poll, without rebuilding the list. */
function refreshAuthors() {
  for (const node of els.qList.querySelectorAll('[data-author-id]')) {
    node.textContent = authorName(node.dataset.authorId);
  }
}

function buildQuestionItem(q) {
  const li = el('li', q.pending ? 'qitem qitem--pending' : 'qitem');
  li.dataset.id = q.id;

  const main = el('div', 'qitem-main');
  const meta = el('p', 'qmeta', TYPE_LABELS[q.type] ?? q.type);
  if (q.pending) meta.append(' ', el('span', 'badge badge--pending', 'en attente'));
  if (q.polarity === 'negative') meta.append(' ', el('span', 'badge', 'négative'));
  main.append(el('p', 'qtext', q.text), meta);
  if (q.pending) {
    // Author of a player proposal (SPEC T12): shown to the admin only.
    const author = el('span', null, authorName(q.proposedBy));
    author.dataset.authorId = q.proposedBy ?? '';
    const line = el('p', 'qitem-author', 'proposée par ');
    line.append(author);
    main.append(line);
  }

  // A pending question is activated with « Valider », not with the switch.
  const toggle = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.dataset.act = 'toggle';
  input.checked = q.enabled;
  input.disabled = Boolean(q.pending);
  toggle.append(input, el('span', null, 'Actif'));

  const actions = el('div', 'qitem-actions');
  if (q.pending) actions.append(actionButton('Valider', 'btn btn--primary btn--sm', 'accept'));
  actions.append(
    actionButton('Modifier', 'btn btn--ghost btn--sm', 'edit'),
    actionButton('Supprimer', 'btn btn--danger btn--sm', 'delete'),
  );

  li.append(main, toggle, actions);
  return li;
}

/** Lower case without accents, so that « ecole » matches « École ». */
function foldText(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** True when the question passes the three filters (type, status, text), which combine with AND. */
function matchesFilter(q) {
  if (questionFilter.type && q.type !== questionFilter.type) return false;
  if (questionFilter.status === 'pending' && !q.pending) return false;
  if (questionFilter.status === 'enabled' && (q.pending || !q.enabled)) return false;
  if (questionFilter.status === 'disabled' && (q.pending || q.enabled)) return false;
  const needle = foldText(questionFilter.text.trim());
  if (needle === '') return true;
  if (foldText(q.text).includes(needle)) return true;
  return (q.options ?? []).some((option) => foldText(option).includes(needle));
}

function renderQuestions() {
  // Keep keyboard focus on the same control when the list is rebuilt.
  const active = document.activeElement;
  let focusTarget = null;
  if (active && els.qList.contains(active) && active.dataset.act) {
    focusTarget = { id: active.closest('li')?.dataset.id, act: active.dataset.act };
  }

  // Pending proposals first (they wait for the admin), then the rest in their stored order.
  const ordered = [...questions.filter((q) => q.pending), ...questions.filter((q) => !q.pending)];
  const shown = ordered.filter(matchesFilter);
  els.qList.replaceChildren(...shown.map(buildQuestionItem));
  els.qEmpty.hidden = questions.length > 0;
  // « no match » is distinct from the empty state (no question at all).
  els.qNoMatch.hidden = questions.length === 0 || shown.length > 0;
  els.qCount.textContent = `${shown.length} / ${questions.length}`;

  if (focusTarget) {
    const item = [...els.qList.querySelectorAll('li')].find((li) => li.dataset.id === focusTarget.id);
    item?.querySelector(`[data-act="${focusTarget.act}"]`)?.focus();
  }
}

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value ?? 'players';
}

function setRadio(name, value) {
  for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
    radio.checked = radio.value === value;
  }
}

/** Answer kind chosen in the « Réponse attendue » radios of « Quelle était la question ? » (`player` or `text`). */
function whichAnswerKind() {
  return document.querySelector('input[name="q-answer-kind"]:checked')?.value ?? 'player';
}

/** Shows only the fields that apply to the selected type (subjects and options hidden for Intelligent / Débile). */
function syncQuestionFields() {
  const type = els.qType.value;
  const smartdumb = type === 'smartdumb';
  const anecdote = type === 'anecdote';
  const which = type === 'which';
  // Anecdote: no subjects, no propositions, no max choices (SPEC T9); the subjects are forced to players.
  // Quelle était la question ? : the same, its items are the copains or the possible questions.
  els.qSubjectsWrap.hidden = smartdumb || anecdote || which;
  const custom = !smartdumb && !anecdote && !which && radioValue('q-subjects') === 'custom';
  els.qOptionsWrap.hidden = !custom;
  // Who a guess on players offers: only for Devine sa réponse on players (SPEC §5), and for « Quelle était la
  // question ? » when the answer is a copain.
  els.qGuessPlayersWrap.hidden = !((type === 'guess' && !custom) || (which && whichAnswerKind() === 'player'));
  els.qVariantsWrap.hidden = !which;
  els.qAnswerKindWrap.hidden = !which;
  // The text field is the theme for « Quelle était la question ? ».
  els.qTextLabel.textContent = which ? 'Thème' : 'Question';
  els.qMaxWrap.hidden = type !== 'multiple';
  els.qNegativeWrap.hidden = !NEGATIVE_TYPES.includes(type);
}

/** Switching to anecdote (or « Quelle était la question ? ») on a new question pre-fills its timer (the admin can still change it). */
function onTypeChange() {
  if (editingId === null) {
    if (els.qType.value === 'anecdote') writeTimer(els.qTimer, ANECDOTE_TIMER);
    if (els.qType.value === 'which') writeTimer(els.qTimer, WHICH_TIMER);
  }
  syncQuestionFields();
}

/** Rows of « Questions possibles » as read from the form: trimmed, blank lines dropped (as the options). */
function readVariantFields() {
  return [...els.qVariants.querySelectorAll('input')]
    .map((input) => input.value.trim())
    .filter((value) => value !== '');
}

/** Buttons of the variant editor: « Ajouter » up to 5 rows, « Retirer » down to 3. */
function renderVariantButtons() {
  const rows = els.qVariants.querySelectorAll('li');
  els.qVariantAdd.disabled = rows.length >= VARIANT_MAX;
  for (const button of els.qVariants.querySelectorAll('.variant-remove')) {
    button.disabled = rows.length <= VARIANT_MIN;
  }
}

/** One row of the variant editor: a wide text field and its « Retirer » button. */
function variantRow(value) {
  const item = el('li', 'variant-row');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = VARIANT_LENGTH;
  input.autocomplete = 'off';
  input.value = value;
  input.setAttribute('aria-label', 'Question possible');
  const remove = el('button', 'btn btn--ghost btn--sm variant-remove', 'Retirer');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    if (els.qVariants.querySelectorAll('li').length <= VARIANT_MIN) return;
    item.remove();
    renderVariantButtons();
  });
  item.append(input, remove);
  return item;
}

/** Fills the variant editor with `values`, padded with empty rows up to the minimum and cut at the maximum. */
function setVariantFields(values) {
  const list = [...values];
  while (list.length < VARIANT_MIN) list.push('');
  els.qVariants.replaceChildren(...list.slice(0, VARIANT_MAX).map(variantRow));
  renderVariantButtons();
}

/** « Ajouter une question » : one more empty row, focused, while under the maximum. */
function addVariantRow() {
  if (els.qVariants.querySelectorAll('li').length >= VARIANT_MAX) return;
  const item = variantRow('');
  els.qVariants.append(item);
  renderVariantButtons();
  item.querySelector('input').focus();
}

function openQuestionForm(question) {
  editingId = question ? question.id : null;
  els.qError.hidden = true;
  if (question) {
    els.qType.value = question.type;
    els.qText.value = question.text;
    setRadio('q-subjects', question.subjects);
    setRadio('q-guess-players', question.guessPlayers ?? 'online');
    setRadio('q-answer-kind', question.answerKind ?? 'player');
    setVariantFields(question.variants ?? []);
    els.qOptions.value = question.options.join('\n');
    els.qMax.value = question.maxChoices === null ? '' : String(question.maxChoices);
    els.qNegative.checked = question.polarity === 'negative';
    writeTimer(els.qTimer, question.timer);
    els.qEnabled.checked = question.enabled;
    els.qFormTitle.textContent = 'Modifier la question';
    els.qSubmit.textContent = 'Enregistrer la question';
  } else {
    els.qType.value = 'single';
    els.qText.value = '';
    setRadio('q-subjects', 'players');
    setRadio('q-guess-players', 'online');
    setRadio('q-answer-kind', 'player');
    setVariantFields([]);
    els.qOptions.value = '';
    els.qMax.value = '';
    els.qNegative.checked = false;
    writeTimer(els.qTimer, 30);
    els.qEnabled.checked = true;
    els.qFormTitle.textContent = 'Nouvelle question';
    els.qSubmit.textContent = 'Créer la question';
  }
  syncQuestionFields();
  els.qForm.hidden = false;
  els.qText.focus();
}

function closeQuestionForm() {
  editingId = null;
  els.qForm.hidden = true;
  els.qError.hidden = true;
}

function readQuestionForm() {
  const type = els.qType.value;
  const anecdote = type === 'anecdote';
  const which = type === 'which';
  const subjects = type === 'smartdumb' || anecdote || which ? 'players' : radioValue('q-subjects');
  const negative = NEGATIVE_TYPES.includes(type) && els.qNegative.checked;
  return {
    type,
    text: els.qText.value,
    subjects,
    options: subjects === 'custom'
      ? els.qOptions.value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
      : [],
    maxChoices: type === 'multiple' ? parseOptionalInt(els.qMax.value) : null,
    timer: readTimer(els.qTimer),
    enabled: els.qEnabled.checked,
    polarity: negative ? 'negative' : 'positive',
    // Only read by the store on a guess on players; sent as 'online' otherwise, which the store drops.
    guessPlayers: document.querySelector('input[name="q-guess-players"]:checked')?.value ?? 'online',
    // « Quelle était la question ? » only: its possible questions and its answer kind (null on other types).
    variants: which ? readVariantFields() : null,
    answerKind: which ? whichAnswerKind() : null,
  };
}

/** After a failed list operation, re-read the authoritative list (the item may be gone or stale). */
function onListError(err) {
  fail(els.qListError, err);
  renderQuestions(); // rebuilds the list from the last known state, re-enabling any disabled switch
  if (authed && !(err instanceof ApiError && err.status === 401)) {
    loadQuestions().catch((reloadErr) => fail(els.qListError, reloadErr));
  }
}

async function toggleQuestion(id, enabled, input) {
  const q = questions.find((item) => item.id === id);
  if (!q) return;
  els.qListError.hidden = true;
  input.disabled = true;
  try {
    const saved = await api('PUT', `/api/admin/questions/${enc(id)}`, { ...questionBody(q), enabled });
    questions = questions.map((item) => (item.id === saved.id ? saved : item));
    renderQuestions();
    updatePlayableCount();
  } catch (err) {
    onListError(err);
  }
}

/** « Valider » of a pending proposal: POST /api/admin/questions/:id/accept (204), then re-read the list. */
async function acceptQuestion(q, button) {
  els.qListError.hidden = true;
  button.disabled = true;
  try {
    await api('POST', `/api/admin/questions/${enc(q.id)}/accept`);
    await loadQuestions();
  } catch (err) {
    onListError(err);
  }
}

async function deleteQuestion(q) {
  if (!confirm(`Supprimer la question « ${q.text} » ?`)) return;
  els.qListError.hidden = true;
  try {
    await api('DELETE', `/api/admin/questions/${enc(q.id)}`);
    questions = questions.filter((item) => item.id !== q.id);
    if (editingId === q.id) closeQuestionForm();
    renderQuestions();
    updatePlayableCount();
  } catch (err) {
    onListError(err);
  }
}

// --- Event wiring --------------------------------------------------------

els.pinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = els.pinInput.value.trim();
  if (pin === '') {
    els.pinError.textContent = 'Saisis le PIN.';
    els.pinError.hidden = false;
    return;
  }
  els.pinSubmit.disabled = true;
  els.pinError.hidden = true;
  await verifyPin(pin, false);
  els.pinSubmit.disabled = false;
});

els.logout.addEventListener('click', () => {
  clearPin();
  showPinScreen();
});

els.btnAccess.addEventListener('click', toggleAccess);
els.btnReveal.addEventListener('click', () => pilot('/api/admin/game/reveal', els.btnReveal));
els.btnNext.addEventListener('click', () => pilot('/api/admin/game/next', els.btnNext));
els.btnReset.addEventListener('click', () =>
  pilot('/api/admin/game/reset', els.btnReset, 'Arrêter la partie et revenir au salon ?'),
);

els.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.settingsError.hidden = true;
  els.settingsSaved.hidden = true;
  els.settingsSubmit.disabled = true;
  try {
    const saved = await api('PUT', '/api/admin/settings', readSettingsForm());
    settings = saved;
    fillSettingsForm(saved);
    updatePlayableCount();
    els.settingsSaved.textContent = 'Paramètres enregistrés.';
    els.settingsSaved.hidden = false;
  } catch (err) {
    fail(els.settingsError, err);
  } finally {
    els.settingsSubmit.disabled = false;
  }
});

els.playersList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const id = button.closest('li')?.dataset.id;
  const player = id ? playersById.get(id) : undefined;
  if (!player) return;
  if (button.dataset.act === 'host') {
    playerAction(`/api/admin/players/${enc(id)}/host`, button);
  } else if (button.dataset.act === 'kick') {
    if (!confirm(`Exclure ${player.name} ?`)) return;
    playerAction(`/api/admin/players/${enc(id)}/kick`, button);
  }
});

els.guestsList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const guest = guests.find((item) => item.id === button.closest('li')?.dataset.id);
  if (guest && button.dataset.act === 'delete') deleteGuest(guest);
});

els.guestsList.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.dataset.act !== 'visible') return;
  const id = input.closest('li')?.dataset.id;
  if (id) setGuestVisible(id, input.checked, input);
});

els.fText.addEventListener('input', () => {
  questionFilter.text = els.fText.value;
  renderQuestions();
});
els.fType.addEventListener('change', () => {
  questionFilter.type = els.fType.value;
  renderQuestions();
});
els.fStatus.addEventListener('change', () => {
  questionFilter.status = els.fStatus.value;
  renderQuestions();
});
els.fReset.addEventListener('click', () => {
  questionFilter.text = '';
  questionFilter.type = '';
  questionFilter.status = '';
  els.fText.value = '';
  els.fType.value = '';
  els.fStatus.value = '';
  renderQuestions();
});

els.qNew.addEventListener('click', () => openQuestionForm(null));
els.qCancel.addEventListener('click', () => closeQuestionForm());
els.qVariantAdd.addEventListener('click', addVariantRow);
els.qType.addEventListener('change', onTypeChange);
els.qForm.addEventListener('change', syncQuestionFields);

els.qForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.qError.hidden = true;
  els.qSubmit.disabled = true;
  const body = readQuestionForm();
  try {
    if (editingId) {
      const saved = await api('PUT', `/api/admin/questions/${enc(editingId)}`, body);
      questions = questions.map((item) => (item.id === saved.id ? saved : item));
    } else {
      const saved = await api('POST', '/api/admin/questions', body);
      questions = [...questions, saved];
    }
    closeQuestionForm();
    renderQuestions();
    updatePlayableCount();
  } catch (err) {
    fail(els.qError, err);
    if (authed && !(err instanceof ApiError && err.status === 401)) {
      loadQuestions().catch((reloadErr) => fail(els.qListError, reloadErr));
    }
  } finally {
    els.qSubmit.disabled = false;
  }
});

els.qList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const id = button.closest('li')?.dataset.id;
  const q = questions.find((item) => item.id === id);
  if (!q) return;
  if (button.dataset.act === 'edit') {
    els.qListError.hidden = true;
    openQuestionForm(q);
    els.qForm.scrollIntoView({ block: 'nearest' });
  } else if (button.dataset.act === 'accept') {
    acceptQuestion(q, button);
  } else if (button.dataset.act === 'delete') {
    deleteQuestion(q);
  }
});

els.qList.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.dataset.act !== 'toggle') return;
  const id = input.closest('li')?.dataset.id;
  if (id) toggleQuestion(id, input.checked, input);
});

// Steppers (count fields) and digit-only timer fields (SPEC §10)
for (const button of document.querySelectorAll('.stepper-btn')) {
  button.addEventListener('click', () => {
    const input = button.closest('.stepper').querySelector('input');
    stepCount(input, Number(button.dataset.step));
  });
}

for (const pair of document.querySelectorAll('.timer-pair')) {
  for (const input of pair.querySelectorAll('.timer-part')) bindDigitsOnly(input);
  partOf(pair, 'sec').addEventListener('blur', () => normalizeSeconds(pair));
}

// --- Boot ----------------------------------------------------------------

const storedPin = readPin();
if (storedPin) {
  // A stored PIN is only trusted after GET /api/admin/check accepts it.
  els.pinScreen.hidden = true;
  els.boot.hidden = false;
  verifyPin(storedPin, true);
} else {
  showPinScreen();
}
