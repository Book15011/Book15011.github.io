// @ts-check
/** Opens the game in a modal over the current page, so a visitor never loses their place. */
import { mountPokerGame } from './game.js';

const CSS_URL = new URL('../../css/poker.css', import.meta.url).href;
const PAGE_URL = new URL('../../how-it-works.html', import.meta.url).href;

/** @type {HTMLElement|null} */
let modal = null;
/** @type {{destroy:()=>void}|null} */
let mounted = null;

function ensureCss() {
  if (document.querySelector(`link[href="${CSS_URL}"]`)) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS_URL;
    l.onload = () => resolve(undefined);
    l.onerror = () => resolve(undefined);
    document.head.appendChild(l);
  });
}

export async function openPokerModal() {
  if (modal) { modal.hidden = false; modal.querySelector('.pk-app')?.focus?.(); document.body.style.overflow = 'hidden'; return; }
  await ensureCss();
  const opener = /** @type {HTMLElement|null} */ (document.activeElement);
  modal = document.createElement('div');
  modal.className = 'pk-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Poker game against the AI');
  modal.innerHTML = '<div class="pk-modal-box"></div>';
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  const close = () => {
    if (!modal) return;
    // The match stays in memory, so closing to read the CV and coming back keeps your place.
    modal.hidden = true;
    document.body.style.overflow = '';
    opener?.focus?.();
  };
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
  mounted = mountPokerGame(/** @type {HTMLElement} */ (modal.querySelector('.pk-modal-box')), {
    onClose: close,
    links: {
      howItWorks: PAGE_URL,
      benchmarks: `${PAGE_URL}#benchmarks`,
      source: 'https://github.com/Book15011/Book15011.github.io/tree/main/poker',
    },
  });
  /** @type {HTMLElement|null} */ (modal.querySelector('.pk-app'))?.focus();
  void mounted;
}
