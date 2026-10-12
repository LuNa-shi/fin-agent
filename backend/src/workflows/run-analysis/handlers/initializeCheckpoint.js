import { prepareCheckpointContext } from '../runtime/checkpointContext.js';

export async function initializeCheckpoint(context) {
  return prepareCheckpointContext(context);
}

export async function hydrateInitializeCheckpoint(context) {
  if (context.cp) return context.cp;
  return prepareCheckpointContext(context, { emitLifecycle: false });
}

export { initializeCheckpoint as execute, hydrateInitializeCheckpoint as hydrate };
