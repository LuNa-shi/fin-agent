import { measureThemeConcentration } from '../nodes/candidateSelection.js';
import { hydrate } from './shared.js';

export async function execute(context) {
  const allIdeas = context.snapshot.inputs.existingIdeas;
  const portfolio = context.snapshot.inputs.positions;
  const existingTitleLimit = context.snapshot.inputs.settings.DEMO_MODE === true
    ? 80
    : 40;
  const existingTitles = allIdeas
    .slice(0, existingTitleLimit)
    .map((idea) => idea.title);
  const heldThemes = portfolio
    .map((position) => position.theme || position.ticker)
    .filter(Boolean);
  const concentration = measureThemeConcentration(allIdeas, portfolio);
  return {
    existingTitles,
    heldThemes,
    heavyThemes: concentration.heavy,
    concentration: {
      sorted: concentration.sorted,
      total: concentration.total,
    },
  };
}

export { hydrate };
