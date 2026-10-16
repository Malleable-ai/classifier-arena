/** Where a provider's model runs. Logged in the match header (kept apart from the registry). */
export type Hosting = 'vendor-api' | 'edge' | 'local';

/** Every `Hosting` value (the log reader checks header seats against it). */
export const HOSTINGS: readonly Hosting[] = ['vendor-api', 'edge', 'local'];
