/**
 * A stand-in 2D context for drawing tests in Node: every call is a no-op except `fillText`, which
 * is recorded with the alpha, font size (px, before any transform), font and fill style it was
 * drawn at, and
 * `measureText`, which estimates a width from the font size (0.55 em per character). Gradients
 * are inert stubs.
 */
export interface FakeCtx {
  ctx: CanvasRenderingContext2D;
  texts: {
    text: string;
    alpha: number;
    x: number;
    y: number;
    px: number;
    font: string;
    color: string;
  }[];
}

export function fakeCtx(): FakeCtx {
  const texts: FakeCtx['texts'] = [];
  const state: Record<string | symbol, unknown> = { font: '10px sans-serif', globalAlpha: 1 };
  const px = (): number => Number(/(\d+(?:\.\d+)?)px/.exec(String(state['font']))?.[1] ?? 10);
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'fillText') {
        return (text: string, x: number, y: number) => {
          texts.push({
            text,
            alpha: Number(target['globalAlpha']),
            x,
            y,
            px: px(),
            font: String(target['font']),
            color: String(target['fillStyle']),
          });
        };
      }
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: () => undefined });
      }
      if (prop === 'measureText') return (text: string) => ({ width: text.length * px() * 0.55 });
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}
