import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import {
  capturedIdeaRoutes,
  effectiveConfigByAgent,
} from '../runtime/inputSnapshot.js';
import { hydrate, jsonSnapshot, safeAgentResult } from './shared.js';

function reviewPool(ideas) {
  return ideas.map((idea) => ({
    title: idea.title,
    theme: idea.theme,
    heat: idea.heat,
    rationale: idea.rationale,
    tickers: idea.tickers,
    droppedTickers: idea.droppedTickers,
    catalyst: idea.catalyst,
    edge: idea.edge,
    titleZh: idea.titleZh,
    rationaleZh: idea.rationaleZh,
    catalystZh: idea.catalystZh,
    edgeZh: idea.edgeZh,
  }));
}

function annotation(idea, {
  selected = null,
  score = null,
  rank = null,
  reason = null,
  source,
  warnings = [],
} = {}) {
  return {
    ideaId: idea.id,
    selected,
    score,
    rank,
    reason,
    source,
    warnings,
  };
}

function applyAnnotations(ideas, annotations) {
  const byId = new Map(annotations.map((item) => [item.ideaId, item]));
  return ideas.map((idea) => {
    const quality = byId.get(idea.id);
    return {
      ...idea,
      qualityScore: quality.score,
      qualityRank: quality.rank,
      qualityReason: quality.reason,
      qualitySelected: quality.selected,
      qualitySource: quality.source,
      qualityWarnings: quality.warnings,
    };
  });
}

export async function execute(context) {
  const verified = context.nodeResults['verify-candidates'];
  const ideas = verified.validIdeas;
  const count = context.snapshot.inputs.command.count;
  const demo = context.snapshot.inputs.settings.DEMO_MODE === true;
  if (ideas.length <= count || demo) {
    const annotations = ideas.map((idea) => annotation(idea, {
      score: demo ? (idea.qualityScore ?? 50) : null,
      source: demo ? 'deterministic-demo' : 'not-run',
      warnings: ['quality-review-not-required'],
    }));
    return {
      ideas: applyAnnotations(ideas, annotations),
      annotations,
      review: null,
      agent: null,
    };
  }

  const config = effectiveConfigByAgent(context.snapshot).get('idea-quality-reviewer');
  const pool = reviewPool(ideas);
  const result = await runDefinedAgent('idea-quality-reviewer', { count, pool }, {
    callId: 'review-quality',
    expectedEffectiveConfigDigest: config.digest,
    ...capturedIdeaRoutes(context.snapshot).reviewer,
    kind: 'idea-screen',
    temperature: 0.3,
    throwOnFailure: false,
  });
  const rawSelected = result.status === 'succeeded' && result.valid !== false
    ? result.output?.selected
    : null;
  const selected = [];
  const seen = new Set();
  if (Array.isArray(rawSelected)) {
    for (const candidate of rawSelected) {
      if (
        selected.length >= count
        || !Number.isInteger(candidate?.index)
        || candidate.index < 0
        || candidate.index >= ideas.length
        || seen.has(candidate.index)
      ) continue;
      seen.add(candidate.index);
      selected.push(candidate);
    }
  }
  const byIndex = new Map(selected.map((item, index) => [item.index, {
    item,
    rank: index + 1,
  }]));
  const reviewAvailable = Array.isArray(rawSelected);
  const annotations = ideas.map((idea, index) => {
    const selectedItem = byIndex.get(index);
    if (selectedItem) {
      return annotation(idea, {
        selected: true,
        score: typeof selectedItem.item.score === 'number'
          ? selectedItem.item.score
          : null,
        rank: selectedItem.rank,
        reason: selectedItem.item.reason || null,
        source: 'idea-quality-reviewer',
      });
    }
    return annotation(idea, {
      selected: reviewAvailable ? false : null,
      source: reviewAvailable ? 'idea-quality-reviewer' : 'review-unavailable',
      warnings: [
        reviewAvailable
          ? 'not-selected-by-quality-reviewer'
          : 'quality-review-unavailable',
      ],
    });
  });
  return {
    ideas: applyAnnotations(ideas, annotations),
    annotations,
    review: jsonSnapshot(result.output, null),
    agent: safeAgentResult(result),
  };
}

export { hydrate };
