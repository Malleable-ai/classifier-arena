/** A dated price on a provider entry (4c). */
export interface ProviderPrice {
  usdPerMillionInputTokens: number;
  /** ISO date the price was checked. */
  asOf: string;
}

/** Input tokens × price. Unknown token counts cost 0. */
export function costUsd(price: ProviderPrice, inputTokens: number | null): number {
  if (inputTokens === null) return 0;
  if (inputTokens < 0) throw new RangeError(`negative inputTokens: ${String(inputTokens)}`);
  return (inputTokens * price.usdPerMillionInputTokens) / 1_000_000;
}
