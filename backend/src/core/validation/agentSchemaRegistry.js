import { getSupportAgentSchema } from '../../agents/contracts/schemaRegistry.js';
import { getIdeaSchema } from '../../domains/ideas/contracts/schemaRegistry.js';
import { getResearchSchema } from '../../domains/research/contracts/schemaRegistry.js';
import { getWorldviewSchema } from '../../domains/worldview/contracts/schemaRegistry.js';

const resolvers = Object.freeze([getResearchSchema, getIdeaSchema, getSupportAgentSchema, getWorldviewSchema]);

export function getAgentSchema(id) {
  for (const resolve of resolvers) {
    const schema = resolve(id);
    if (schema) return schema;
  }
  return null;
}
