// Drag and drop for the answer widgets: Pointer Events, so one code path serves mouse and touch.
// No dependency, no framework.
//
// API
//   draggable(node, data)  node becomes a drag source; `data` is handed back to the drop handler.
//   onDrop(root, handler)  handler(data, dropEl, ghostRect) runs when a drag is released over a `[data-drop]`
//                          element inside `root`. `dropEl` is the nearest `[data-drop]` ancestor of the
//                          element under the pointer; its value is read with `dropEl.dataset.drop`.
//                          `ghostRect` is the viewport rect of the ghost at release (where the finger left
//                          the item), or null. Registrations live in a WeakMap: a re-rendered root needs no cleanup.
//
// Behaviour
// - Sources get `touch-action: none`, so a finger drags instead of scrolling the page.
// - A press becomes a drag only after DRAG_THRESHOLD px of movement. Below it the press stays a tap and
//   the element's `click` runs as usual: this is the tap « select, then place » fallback.
// - A ghost clone follows the pointer (class `drag-ghost`); the source gets `is-drag-source`.
// - The hovered drop target gets `is-drop-hover`, removed on leave and on release.
// - Within EDGE px of the top or bottom of the viewport, the page auto-scrolls (rAF loop).
// - The click a drag may produce on release is swallowed, so a drop never also acts as a tap.
// - Listeners sit on window during the gesture only, and are removed on pointerup / pointercancel.

const DRAG_THRESHOLD = 6;
const EDGE = 56;
const MAX_SCROLL = 18;
const CLICK_SWALLOW_MS = 300;

/** @type {WeakMap<Element, (data: object, dropEl: Element) => void>} */
const dropHandlers = new WeakMap();

/** @type {WeakMap<Element, object>} data each drag source carries, read back by markDropped. */
const dragData = new WeakMap();

/** Current gesture (one at a time), or null. */
let active = null;
/** True right after a real drag, until the click it may have produced has been dispatched. */
let swallowClick = false;

document.addEventListener(
  'click',
  (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  },
  true,
);

/** Registers the drop handler of a widget root. Calling it again replaces the previous handler. */
export function onDrop(root, handler) {
  dropHandlers.set(root, handler);
}

/** Makes `node` a drag source carrying `data`. Returns `node`. */
export function draggable(node, data) {
  node.classList.add('is-draggable');
  dragData.set(node, data);
  node.style.touchAction = 'none';
  node.addEventListener('pointerdown', (event) => startGesture(event, node, data));
  // Native image / link dragging would cancel the pointer gesture: block it on the source.
  node.addEventListener('dragstart', (event) => event.preventDefault());
  return node;
}

/**
 * Marks with `is-dropped` the drag source under `root` that carries the same data as the element just
 * dropped. Called right after a re-render (the source was rebuilt), so the settle animation plays once.
 */
export function markDropped(root, data) {
  if (!data) return;
  const wanted = JSON.stringify(data);
  for (const node of root.querySelectorAll('.is-draggable')) {
    if (JSON.stringify(dragData.get(node)) === wanted) {
      node.classList.add('is-dropped');
      return;
    }
  }
}

function findDropElement(x, y) {
  const hit = document.elementFromPoint(x, y);
  return hit ? hit.closest('[data-drop]') : null;
}

function handlerFor(dropEl) {
  for (let node = dropEl; node; node = node.parentElement) {
    const handler = dropHandlers.get(node);
    if (handler) return handler;
  }
  return null;
}

function startGesture(event, source, data) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (active) finish();
  active = {
    id: event.pointerId,
    source,
    data,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    dragging: false,
    ghost: null,
    offsetX: 0,
    offsetY: 0,
    hover: null,
    scrollSpeed: 0,
    frame: 0,
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

function onMove(event) {
  const gesture = active;
  if (!gesture || event.pointerId !== gesture.id) return;
  gesture.x = event.clientX;
  gesture.y = event.clientY;
  if (!gesture.dragging) {
    if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < DRAG_THRESHOLD) return;
    beginDrag(gesture);
  }
  moveGhost(gesture);
  updateHover(gesture);
  updateScroll(gesture);
}

function beginDrag(gesture) {
  const rect = gesture.source.getBoundingClientRect();
  gesture.offsetX = gesture.startX - rect.left;
  gesture.offsetY = gesture.startY - rect.top;

  const ghost = gesture.source.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.removeAttribute('data-drop');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);

  gesture.ghost = ghost;
  gesture.dragging = true;
  gesture.source.classList.add('is-drag-source');
}

function moveGhost(gesture) {
  if (!gesture.ghost) return;
  gesture.ghost.style.left = `${gesture.x - gesture.offsetX}px`;
  gesture.ghost.style.top = `${gesture.y - gesture.offsetY}px`;
}

function updateHover(gesture) {
  const target = findDropElement(gesture.x, gesture.y);
  if (target === gesture.hover) return;
  gesture.hover?.classList.remove('is-drop-hover');
  gesture.hover = target;
  target?.classList.add('is-drop-hover');
}

function updateScroll(gesture) {
  let speed = 0;
  if (gesture.y < EDGE) {
    speed = -MAX_SCROLL * ((EDGE - gesture.y) / EDGE);
  } else if (gesture.y > window.innerHeight - EDGE) {
    speed = MAX_SCROLL * ((gesture.y - (window.innerHeight - EDGE)) / EDGE);
  }
  gesture.scrollSpeed = speed;
  if (speed !== 0 && !gesture.frame) gesture.frame = requestAnimationFrame(scrollTick);
}

function scrollTick() {
  const gesture = active;
  if (!gesture) return;
  gesture.frame = 0;
  if (!gesture.dragging || gesture.scrollSpeed === 0) return;
  window.scrollBy(0, gesture.scrollSpeed);
  // The element under a still pointer changes while the page scrolls.
  updateHover(gesture);
  gesture.frame = requestAnimationFrame(scrollTick);
}

function onUp(event) {
  const gesture = active;
  if (!gesture || event.pointerId !== gesture.id) return;
  const dragging = gesture.dragging;
  const dropEl = dragging ? findDropElement(event.clientX, event.clientY) : null;
  // Read before finish() removes the ghost.
  const ghostRect = dragging && gesture.ghost ? gesture.ghost.getBoundingClientRect() : null;
  finish();
  if (!dragging) return;

  swallowClick = true;
  setTimeout(() => {
    swallowClick = false;
  }, CLICK_SWALLOW_MS);

  const handler = dropEl ? handlerFor(dropEl) : null;
  handler?.(gesture.data, dropEl, ghostRect);
}

function onCancel(event) {
  const gesture = active;
  if (!gesture || event.pointerId !== gesture.id) return;
  finish();
}

/** Ends the current gesture and removes everything it added to the page. */
function finish() {
  const gesture = active;
  if (!gesture) return;
  active = null;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancel);
  if (gesture.frame) cancelAnimationFrame(gesture.frame);
  gesture.ghost?.remove();
  gesture.source.classList.remove('is-drag-source');
  gesture.hover?.classList.remove('is-drop-hover');
}
