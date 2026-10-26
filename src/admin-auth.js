import crypto from 'node:crypto';

const MAX_FAILURES = 5;
const BLOCK_MS = 60_000;
const BLOCKED_MESSAGE = "Trop d'essais, réessaie dans une minute";
const INVALID_MESSAGE = 'PIN admin invalide';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Admin PIN check (SPEC §9 Accès).
 * @param {{ pin?: string, now?: () => number }} [options]
 *   `pin`: PIN to use; when empty or missing, a random 6-digit PIN is generated.
 *   `now`: clock in ms, injectable for tests.
 * @returns {{ pin: string, generated: boolean, middleware: import('express').RequestHandler }}
 */
export function createAdminAuth({ pin, now = Date.now } = {}) {
  const suppliedPin = typeof pin === 'string' ? pin.trim() : '';
  const generated = suppliedPin === '';
  const adminPin = generated
    ? crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
    : suppliedPin;
  const expectedDigest = sha256(adminPin);

  // ip -> { failures, blockedUntil } ; blockedUntil = 0 when not blocked.
  const attempts = new Map();

  function middleware(req, res, next) {
    const ip = req.ip;
    const t = now();

    const entry = attempts.get(ip);
    if (entry && entry.blockedUntil !== 0) {
      if (entry.blockedUntil > t) {
        res.status(429).json({ error: BLOCKED_MESSAGE });
        return;
      }
      // Block expired: forget the IP entirely.
      attempts.delete(ip);
    }

    const provided = req.get('x-admin-pin');
    const valid =
      typeof provided === 'string' &&
      crypto.timingSafeEqual(sha256(provided), expectedDigest);

    if (valid) {
      attempts.delete(ip);
      next();
      return;
    }

    const failures = (attempts.get(ip)?.failures ?? 0) + 1;
    if (failures >= MAX_FAILURES) {
      attempts.set(ip, { failures: 0, blockedUntil: t + BLOCK_MS });
    } else {
      attempts.set(ip, { failures, blockedUntil: 0 });
    }
    res.status(401).json({ error: INVALID_MESSAGE });
  }

  return { pin: adminPin, generated, middleware };
}
