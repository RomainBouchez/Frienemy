// « Scanne pour rejoindre » (lobby, every player): the QR code of the address to join, as a small card in the
// lobby, enlarged on tap in a full-screen overlay (outside #app, so a `state` re-render never closes it).
// The library is the global `qrcode` of /vendor/qrcode-generator.js (loaded by index.html).
import { el } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Hostnames of a page opened on the host machine itself: the phones need the LAN address instead. */
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];
/** Quiet zone around the code, in modules: a scanner needs a light margin to find it. */
const QUIET_ZONE = 4;

/**
 * Returns `{ card(), sync(state) }`. `onResolved` is called once the address is known (after a local
 * request to /api/lan-url), so the caller re-renders and the card shows the code.
 */
export function createJoinQr(onResolved) {
  // undefined: not known yet; null: no LAN address on the host; string: the address to encode.
  let address;
  let requested = false;
  let overlay = null;
  let overlayOpen = false;
  let opener = null;

  /** The address the phones must open: the page's own origin, or the host's LAN address when the page is local. */
  function resolveAddress() {
    if (requested) return;
    requested = true;
    if (!LOCAL_HOSTNAMES.includes(location.hostname)) {
      address = location.origin;
      return;
    }
    fetch('/api/lan-url', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        address = typeof body?.url === 'string' ? body.url : null;
      })
      .catch(() => {
        address = null;
      })
      .finally(() => onResolved?.());
  }

  /** The QR code as an inline SVG (black on white, quiet zone included), or null when the library is missing. */
  function qrSvg(text, className) {
    if (typeof qrcode !== 'function') return null;
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const size = count + QUIET_ZONE * 2;
    // The code is always black on white, whatever the theme: a scanner needs the contrast.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code pour rejoindre la partie');
    const background = document.createElementNS(SVG_NS, 'rect');
    background.setAttribute('width', String(size));
    background.setAttribute('height', String(size));
    background.setAttribute('fill', '#ffffff');
    let d = '';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) d += `M${col + QUIET_ZONE},${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
    const modules = document.createElementNS(SVG_NS, 'path');
    modules.setAttribute('d', d);
    modules.setAttribute('fill', '#000000');
    svg.append(background, modules);
    return svg;
  }

  /** The lobby card. Rebuilt at each lobby render; the code is cheap to draw for a short address. */
  function card() {
    resolveAddress();
    if (address === undefined) {
      return el('div', { class: 'join-qr is-pending', 'aria-hidden': 'true' }, el('span', { class: 'join-qr__code' }));
    }
    if (address === null) {
      return el('div', { class: 'join-qr is-missing', role: 'status' }, [
        el('span', { class: 'join-qr__text' }, [
          el('span', { class: 'join-qr__title' }, 'Scanne pour rejoindre'),
          el('span', { class: 'join-qr__url' }, 'Adresse réseau introuvable'),
        ]),
      ]);
    }
    const code = qrSvg(address, 'join-qr__svg');
    return el(
      'button',
      { type: 'button', class: 'join-qr', onclick: (event) => open(event.currentTarget) },
      [
        code ? el('span', { class: 'join-qr__code' }, code) : null,
        el('span', { class: 'join-qr__text' }, [
          el('span', { class: 'join-qr__title' }, 'Scanne pour rejoindre'),
          el('span', { class: 'join-qr__url' }, address),
        ]),
      ],
    );
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    // Any tap on the overlay closes it (the code included): the phone that scans gets it at full size.
    overlay = el('div', {
      class: 'join-qr-overlay',
      hidden: true,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Scanne pour rejoindre',
      onclick: () => close(),
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function open(origin) {
    if (typeof address !== 'string') return;
    opener = origin;
    const node = ensureOverlay();
    const code = qrSvg(address, 'join-qr-overlay__svg');
    node.replaceChildren(
      el('div', { class: 'join-qr-overlay__panel' }, [
        code ? el('span', { class: 'join-qr-overlay__code' }, code) : null,
        el('span', { class: 'join-qr-overlay__title' }, 'Scanne pour rejoindre'),
        el('span', { class: 'join-qr-overlay__url' }, address),
        el('span', { class: 'join-qr-overlay__close' }, 'Fermer'),
      ]),
    );
    node.hidden = false;
    overlayOpen = true;
    document.addEventListener('keydown', onKeydown);
  }

  function close() {
    if (!overlay || !overlayOpen) return;
    overlay.hidden = true;
    overlay.replaceChildren();
    overlayOpen = false;
    document.removeEventListener('keydown', onKeydown);
    if (opener?.isConnected) opener.focus();
    opener = null;
  }

  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }

  /** Closes the overlay as soon as the viewer leaves the lobby (a game starts, or the viewer is no longer seated). */
  function sync(state) {
    if (overlayOpen && !(state.you && state.phase === 'lobby')) close();
  }

  return { card, sync };
}
