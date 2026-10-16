import type { CardRoute } from '../route.js';
import { showError } from '../shell/player.js';
import { cardFor, type CardData } from './index.js';

/**
 * Render mode for a card (`/?card=<name>&render=1&size=<W>x<H>`): a canvas of exactly W × H
 * pixels, frame 0 drawn, and the same handles as a match's render mode:
 * `window.renderInfo = { frames, width, height }` and `window.renderFrame(n)`, which draws frame
 * n (clamped) synchronously and returns it.
 */
export function mountCardRenderMode(root: HTMLElement, route: CardRoute, data: CardData): void {
  const card = cardFor(route.card, data);
  if (card === null) {
    showError(root, `No card named "${route.card}".`);
    return;
  }
  root.innerHTML = '';
  root.className = 'render-root';
  const { width, height } = route.size;
  const canvas = document.createElement('canvas');
  canvas.className = 'render-canvas';
  canvas.setAttribute('aria-label', `Video card: ${card.name}`);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${String(width)}px`;
  canvas.style.height = `${String(height)}px`;
  root.append(canvas);
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    showError(root, '2D canvas not supported');
    return;
  }
  const renderFrame = (n: number): number => {
    const frame = Math.max(0, Math.min(card.frames - 1, Math.floor(n)));
    card.draw(ctx, frame, route.size);
    return frame;
  };
  renderFrame(0);
  window.renderInfo = { frames: card.frames, width, height };
  window.renderFrame = renderFrame;
}
