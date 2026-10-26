// Frienemy has no fixed roster: everyone creates a name from the « + » tile of the name picker (guests,
// src/guests.js), with an optional photo. ROSTER stays empty and keeps the same exports as the private copy.
export const ROSTER = [];

export function avatarUrl(id) {
  return `/avatars/${id}.jpg`;
}
