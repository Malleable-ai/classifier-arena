import { openaiDecisions } from './openai-decisions.js';
import { systemone } from './systemone.js';
import type { DecisionFormat, FormatId } from './types.js';

export const FORMATS: Record<FormatId, DecisionFormat> = {
  systemone,
  'openai-decisions': openaiDecisions,
};

export type { DecisionFormat, FormatId, ParsedAnswer, SharedPayload } from './types.js';
export { InvalidAnswer } from './types.js';
