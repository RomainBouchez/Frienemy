// Invités (SPEC §4, §8, §9, T13): pseudo + optional photo created from the lobby, stored in DATA_DIR.
// Visibility is runtime only: every guest starts hidden on load, the admin shows them again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError, writeFileAtomic } from './store.js';

export const MAX_GUESTS = 30;
export const GUEST_NAME_MAX = 20;
export const GUEST_PHOTO_MAX_BYTES = 300 * 1024;
// Colours for guests, distinct from the roster colours (SPEC §4). Cycled by creation count.
export const GUEST_PALETTE = Object.freeze(['#ea580c', '#65a30d', '#0891b2', '#7c3aed', '#be185d', '#475569']);

const DATA_URL_PREFIX = 'data:image/jpeg;base64,';
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const NAME_REQUIRED = 'Choisis un pseudo';
const NAME_TOO_LONG = 'Le pseudo doit faire 20 caractères maximum';
const NAME_TAKEN = 'Ce pseudo est déjà pris';
const PHOTO_INVALID = 'Photo invalide ou trop lourde';
const TOO_MANY_GUESTS = "Trop d'invités enregistrés, demande à l'admin de faire le ménage";

/**
 * Public URL of a guest picture, served from DATA_DIR/guest-avatars (SPEC §4). Without a photo the
 * picture is a generated SVG square with the initial, so the client renders it like any photo.
 */
export function guestAvatarUrl(id, hasPhoto = true) {
  return `/guest-avatars/${id}.${hasPhoto ? 'jpg' : 'svg'}`;
}

function fail(message) {
  throw new ValidationError(message);
}

function normalizeName(raw) {
  if (typeof raw !== 'string') fail(NAME_REQUIRED);
  const name = raw.trim();
  if (name.length < 1) fail(NAME_REQUIRED);
  if (name.length > GUEST_NAME_MAX) fail(NAME_TOO_LONG);
  return name;
}

/**
 * Decodes an optional `data:image/jpeg;base64,…` photo; checks the JPEG magic bytes and the size.
 * @returns {Buffer | null} the JPEG bytes, or null when no photo was sent (undefined, null or '')
 */
function decodePhoto(photo) {
  if (photo === undefined || photo === null || photo === '') return null;
  if (typeof photo !== 'string' || !photo.startsWith(DATA_URL_PREFIX)) fail(PHOTO_INVALID);
  const base64 = photo.slice(DATA_URL_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) fail(PHOTO_INVALID);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > GUEST_PHOTO_MAX_BYTES) fail(PHOTO_INVALID);
  if (bytes.length < JPEG_MAGIC.length || !bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    fail(PHOTO_INVALID);
  }
  return bytes;
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * Initial picture for a guest without photo: a coloured square with the first letter of the name, the same
 * letter rule as the client fallback (`initialOf` in public/js/ui.js). `name` is already trimmed and non-empty.
 */
function initialSvg(name, color) {
  const letter = name.charAt(0).toUpperCase().replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    `<rect width="100" height="100" fill="${color}"/>`,
    '<text x="50" y="50" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif"',
    ` font-size="48" font-weight="700" fill="#fff">${letter}</text>`,
    '</svg>',
    '',
  ].join('');
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort: a leftover picture is harmless, the guest list is the source of truth.
  }
}

/**
 * Guest store backed by `dataDir/guests.json` and `dataDir/guest-avatars/<id>.jpg` (or `<id>.svg` without photo).
 * Writes are atomic (tmp + rename). Visibility is kept in memory only: all guests start hidden.
 * All returned values are copies.
 * @param {string} dataDir
 */
export function createGuestStore(dataDir) {
  const guestsFile = path.join(dataDir, 'guests.json');
  const avatarDir = path.join(dataDir, 'guest-avatars');
  fs.mkdirSync(avatarDir, { recursive: true });

  // Records: { id, name, color, createdAt, photo, visible }. `photo` is absent in older files: those had one.
  let guests = fs.existsSync(guestsFile)
    ? JSON.parse(fs.readFileSync(guestsFile, 'utf8')).map((guest) => ({ ...guest, photo: guest.photo !== false, visible: false }))
    : [];

  function photoPath(id) {
    return path.join(avatarDir, `${id}.jpg`);
  }

  function initialPath(id) {
    return path.join(avatarDir, `${id}.svg`);
  }

  function persist(next) {
    const stored = next.map(({ id, name, color, createdAt, photo }) => ({ id, name, color, createdAt, photo }));
    writeFileAtomic(guestsFile, `${JSON.stringify(stored, null, 2)}\n`);
    guests = next;
  }

  function newGuestId() {
    let id;
    do {
      id = `g_${crypto.randomBytes(3).toString('hex')}`;
    } while (guests.some((guest) => guest.id === id));
    return id;
  }

  function view(guest) {
    return {
      id: guest.id,
      name: guest.name,
      color: guest.color,
      createdAt: guest.createdAt,
      avatar: guestAvatarUrl(guest.id, guest.photo),
      visible: guest.visible,
    };
  }

  return {
    list() {
      return guests.map(view);
    },

    visible() {
      return guests.filter((guest) => guest.visible).map(view);
    },

    get(id) {
      const guest = guests.find((g) => g.id === id);
      return guest ? view(guest) : null;
    },

    /**
     * Creates a visible guest (SPEC §8, T13). `takenNames` are the roster names; the stored guests
     * are checked here too. Names are compared case-insensitively, after trimming. The photo is optional.
     * @returns {object} the created guest (see `view`)
     * @throws {ValidationError} French message for the user
     */
    create(input, takenNames = []) {
      const body = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
      const name = normalizeName(body.name);
      const taken = new Set(
        [...takenNames, ...guests.map((guest) => guest.name)]
          .filter((value) => typeof value === 'string')
          .map((value) => value.trim().toLowerCase()),
      );
      if (taken.has(name.toLowerCase())) fail(NAME_TAKEN);
      const bytes = decodePhoto(body.photo);
      if (guests.length >= MAX_GUESTS) fail(TOO_MANY_GUESTS);

      const id = newGuestId();
      const record = {
        id,
        name,
        color: GUEST_PALETTE[guests.length % GUEST_PALETTE.length],
        createdAt: Date.now(),
        photo: bytes !== null,
        visible: true,
      };
      const file = record.photo ? photoPath(id) : initialPath(id);
      writeFileAtomic(file, record.photo ? bytes : initialSvg(name, record.color));
      try {
        persist([...guests, record]);
      } catch (err) {
        removeQuietly(file);
        throw err;
      }
      return view(record);
    },

    /** @returns {object | null} the updated guest, or null when unknown */
    setVisible(id, visible) {
      const guest = guests.find((g) => g.id === id);
      if (!guest) return null;
      guest.visible = visible;
      return view(guest);
    },

    /** Deletes the guest and its picture. @returns {boolean} false when unknown */
    remove(id) {
      if (!guests.some((guest) => guest.id === id)) return false;
      persist(guests.filter((guest) => guest.id !== id));
      removeQuietly(photoPath(id));
      removeQuietly(initialPath(id));
      return true;
    },
  };
}
