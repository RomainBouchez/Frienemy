// Session stored in localStorage (JS port of PolyPoly apps/web/src/session.ts, SPEC §7).
// Every storage access is wrapped: private windows or blocked storage must not break the page.

const KEY = 'quiz-session';

/**
 * @typedef {{ playerId: string, sessionToken: string }} StoredSession
 */

/** @returns {StoredSession | null} */
export function loadSession() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.playerId === 'string' &&
      typeof parsed.sessionToken === 'string'
    ) {
      return { playerId: parsed.playerId, sessionToken: parsed.sessionToken };
    }
    return null;
  } catch {
    return null;
  }
}

/** @param {StoredSession} session */
export function saveSession(session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable: the player will simply have to pick their name again after a reload.
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
