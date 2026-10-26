// DOM helpers. Player-provided text (names, question texts, options) is always set with textContent,
// never with innerHTML.

/** French labels of the question types (SPEC §5). */
export const TYPE_LABELS = {
  single: 'QCU',
  multiple: 'QCM',
  ranking: 'Classement',
  smartdumb: 'Intelligent / Débile',
  tierlist: 'Tierlist',
  anecdote: 'Anecdote',
  guess: 'Devine sa réponse',
  which: 'Quelle était la question ?',
};

/**
 * Creates an element. `attrs` may be null. Attribute values: `true` sets a boolean attribute, `false`
 * / `null` / `undefined` skip it, `on<event>` functions are event listeners, `style` is an object
 * (custom properties `--x` included). Children: strings, numbers, nodes, nested arrays; null/false
 * are ignored.
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'style' && typeof value === 'object') {
        for (const [prop, val] of Object.entries(value)) {
          if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
          else node.style[prop] = String(val);
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** First letter of a name, upper case; '?' when empty. */
export function initialOf(name) {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

/**
 * Round avatar. `entity` is a player (`name`, `avatar`, `color`) or a round item (`label`, `avatar`,
 * `color`). `size` in px (40 / 56 / 72 / 32 in practice). If the photo fails (or there is none), the
 * element becomes `.avatar--fallback`: the initial on the player's colour.
 */
export function avatar(entity, size = 56) {
  const name = entity.name ?? entity.label ?? '';
  const color = entity.color ?? null;
  const src = entity.avatar ?? null;
  const node = el('span', {
    class: 'avatar',
    role: 'img',
    'aria-label': name,
    style: { '--size': `${size}px` },
  });

  const toFallback = () => {
    node.classList.add('avatar--fallback');
    if (color) node.style.setProperty('--color', color);
    node.replaceChildren(document.createTextNode(initialOf(name)));
  };

  if (!src) {
    toFallback();
    return node;
  }
  const img = el('img', { alt: '', loading: 'lazy', src });
  img.addEventListener('error', toFallback, { once: true });
  node.appendChild(img);
  return node;
}
