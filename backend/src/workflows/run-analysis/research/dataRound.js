import { acquireData } from './dataAgent.js';

export async function runDataRound(args) {
  return { dataContext: await acquireData(args) };
}
