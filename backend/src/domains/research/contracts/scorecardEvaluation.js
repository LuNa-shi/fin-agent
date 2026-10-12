import { deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import { validateJsonSchema } from '../../../core/validation/OutputGate.js';
import { getResearchSchema } from './schemaRegistry.js';

export const SCORECARD_EVALUATION_CONTRACT_VERSION = '1.0.0';
export const SCORECARD_EVALUATION_SCHEMA_ID = 'scorecard-evaluation.v1';

export function validateScorecardEvaluationSchema(value) {
  const schema = getResearchSchema(SCORECARD_EVALUATION_SCHEMA_ID);
  if (!schema) return [`unknown output schema: ${SCORECARD_EVALUATION_SCHEMA_ID}`];
  return validateJsonSchema(value, schema);
}

export function assertScorecardEvaluationSchema(value) {
  const errors = validateScorecardEvaluationSchema(value);
  if (errors.length) {
    const error = new TypeError(`${SCORECARD_EVALUATION_SCHEMA_ID} validation failed: ${errors.join('; ')}`);
    error.code = 'SCORECARD_EVALUATION_INVALID';
    error.errors = errors;
    throw error;
  }
  return deepFreeze(value);
}
