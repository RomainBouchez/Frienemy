// Invités (SPEC §8 guest:create, T13): the « + » tile at the end of the name picker and its form.
// The form is an overlay outside #app (like the proposal wizard), so a `state` re-render never rebuilds
// it: the draft survives every incoming `state`. The photo is optional; when given, it is resized client-side
// (short side 300 px, JPEG 0.85) before it is sent as a data URL. Player text is set with textContent (via el()).
import { el } from './ui.js';

const NAME_MAX = 20;
const SHORT_SIDE = 300;
const JPEG_QUALITY = 0.85;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const MSG_NAME = 'Choisis un pseudo';
const MSG_BAD_IMAGE = 'Cette image ne passe pas, essaie une autre';
const MSG_GENERIC = 'Une erreur est survenue, réessaie.';

/** Decodes a File in an <img>. Rejects when the browser cannot read it. */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image'));
    };
    img.src = url;
  });
}

/** Image File → JPEG data URL whose short side is at most 300 px (never upscaled). */
export async function resizeImage(file) {
  const img = await loadImage(file);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error('image');
  const scale = Math.min(1, SHORT_SIDE / Math.min(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas');
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  if (!dataUrl.startsWith(JPEG_PREFIX)) throw new Error('encode');
  return dataUrl;
}

/** The « Invité » tile, last of the name picker grid. `onOpen(origin)` opens the form. */
export function guestTile(onOpen) {
  return el(
    'button',
    {
      type: 'button',
      class: 'tile tile--add',
      'aria-label': 'Ajouter un invité',
      onclick: (event) => onOpen(event.currentTarget),
    },
    [el('span', { class: 'tile__plus', 'aria-hidden': 'true' }, '+'), el('span', { class: 'tile__name' }, 'Invité')],
  );
}

function newDraft() {
  return {
    photoPromise: null, // resize in progress or done for the chosen file; null when no file
    pending: false, // true from submit until the guest:create ack
  };
}

/**
 * The guest form. `act(event, payload, onResult)` is app.js's emitter. `onCreated(playerId)` runs after
 * the server accepted the guest: app.js then joins with that id, like a friend tile.
 * Returns `{ open(origin), close(), sync(state) }`; `sync` closes the form once the viewer has a seat.
 */
export function createGuestForm(act, onCreated) {
  let isOpen = false;
  let opener = null;
  let draft = newDraft();
  let view = null;
  const overlay = el('div', {
    class: 'wizard',
    hidden: true,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Ajouter un invité',
  });
  document.body.appendChild(overlay);

  function show(node, message) {
    node.textContent = message;
    node.hidden = false;
  }

  function clearErrors() {
    for (const node of [view.nameError, view.photoError, view.formError]) {
      node.hidden = true;
      node.textContent = '';
    }
  }

  function setPending(value) {
    draft.pending = value;
    view.submitButton.disabled = value;
    view.cancelButton.disabled = value;
    view.nameInput.disabled = value;
    view.cameraButton.disabled = value;
    view.libraryButton.disabled = value;
    view.cameraInput.disabled = value;
    view.libraryInput.disabled = value;
  }

  function showPreview(dataUrl) {
    view.preview.replaceChildren(
      el(
        'span',
        { class: 'avatar', role: 'img', 'aria-label': 'Aperçu de la photo', style: { '--size': '96px' } },
        el('img', { alt: '', src: dataUrl }),
      ),
    );
  }

  /** Starts the resize as soon as a file is chosen, so the preview appears and submit is ready. */
  function choosePhoto(file) {
    view.photoError.hidden = true;
    view.preview.replaceChildren();
    const promise = file ? resizeImage(file) : null;
    draft.photoPromise = promise;
    if (!promise) return;
    promise.then(
      (dataUrl) => {
        if (draft.photoPromise === promise && isOpen) showPreview(dataUrl);
      },
      () => {
        if (draft.photoPromise === promise && isOpen) {
          view.preview.replaceChildren();
          show(view.photoError, MSG_BAD_IMAGE);
        }
      },
    );
  }

  async function submit() {
    if (!isOpen || draft.pending) return;
    clearErrors();
    const name = view.nameInput.value.trim();
    // The photo is optional: no file means `photo` null, and the server draws an initial instead.
    const promise = draft.photoPromise;
    if (name === '') {
      show(view.nameError, MSG_NAME);
      view.nameInput.focus();
      return;
    }

    const current = draft;
    setPending(true);
    let photo;
    try {
      photo = await promise;
    } catch {
      // The preview handler already shows the message when this promise is still the current one.
      if (current === draft && isOpen) setPending(false);
      return;
    }
    if (current !== draft || !isOpen) return;
    act('guest:create', { name, photo }, (res) => {
      // The form was closed (or replaced) while the request was in flight: ignore the ack.
      if (current !== draft || !isOpen) return;
      if (res?.ok) {
        close();
        onCreated(res.playerId);
        return;
      }
      setPending(false);
      show(view.formError, res?.reason ?? MSG_GENERIC);
    });
  }

  function build() {
    const nameInput = el('input', {
      type: 'text',
      class: 'guest-input',
      maxlength: NAME_MAX,
      placeholder: 'Interdit de mettre ton vrai prénom !',
      autocomplete: 'off',
      'aria-label': 'Pseudo',
      oninput: () => {
        nameError.hidden = true;
      },
    });
    const nameError = el('p', { class: 'error', role: 'alert', hidden: true });
    // Two hidden file inputs, one per source: « Prendre une photo » opens the front camera on phones
    // (capture="user"; a desktop browser just shows its file picker), « Choisir dans la librairie » none.
    // Both feed choosePhoto, so the resize, preview and validation are the same for either.
    const cameraInput = el('input', {
      type: 'file',
      accept: 'image/*',
      capture: 'user',
      hidden: true,
      onchange: () => choosePhoto(cameraInput.files?.[0] ?? null),
    });
    const libraryInput = el('input', {
      type: 'file',
      accept: 'image/*',
      hidden: true,
      onchange: () => choosePhoto(libraryInput.files?.[0] ?? null),
    });
    const cameraButton = el(
      'button',
      { type: 'button', class: 'btn btn--ghost btn--block', onclick: () => cameraInput.click() },
      'Prendre une photo',
    );
    const libraryButton = el(
      'button',
      { type: 'button', class: 'btn btn--ghost btn--block', onclick: () => libraryInput.click() },
      'Choisir dans la librairie',
    );
    const preview = el('div', { class: 'guest-preview' });
    const photoError = el('p', { class: 'error', role: 'alert', hidden: true });
    const formError = el('p', { class: 'error', role: 'alert', hidden: true });
    const cancelButton = el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => close() }, 'Annuler');
    const submitButton = el('button', { type: 'submit', class: 'btn btn--primary' }, 'Rejoindre');

    const form = el(
      'form',
      {
        class: 'guest-form',
        novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          submit();
        },
      },
      [
        el('label', { class: 'guest-field' }, [el('span', { class: 'guest-field__label' }, 'Pseudo'), nameInput, nameError]),
        el('div', { class: 'guest-field' }, [
          el('span', { class: 'guest-field__label' }, 'Photo (facultative)'),
          cameraButton,
          libraryButton,
          cameraInput,
          libraryInput,
          preview,
          photoError,
        ]),
        formError,
        el('div', { class: 'wizard__foot' }, [cancelButton, submitButton]),
      ],
    );

    view = {
      nameInput,
      nameError,
      cameraButton,
      libraryButton,
      cameraInput,
      libraryInput,
      preview,
      photoError,
      formError,
      cancelButton,
      submitButton,
    };
    overlay.replaceChildren(
      el('div', { class: 'wizard__inner' }, [
        el('div', { class: 'wizard__head' }, [
          el('h2', { class: 'wizard__title', tabindex: -1 }, 'Ajouter un invité'),
        ]),
        form,
      ]),
    );
  }

  function open(origin = null) {
    if (isOpen) return;
    draft = newDraft();
    opener = origin;
    isOpen = true;
    build();
    overlay.hidden = false;
    view.nameInput.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    draft = newDraft();
    view = null;
    overlay.hidden = true;
    overlay.replaceChildren();
    if (opener?.isConnected) opener.focus();
    opener = null;
  }

  /** A `state` that gives the viewer a seat means the join went through: the form is no longer needed. */
  function sync(state) {
    // Also closed when the admin closes the access: the waiting screen replaces the picker.
    if (isOpen && (state.you || state.accessOpen === false)) close();
  }

  return { open, close, sync };
}
