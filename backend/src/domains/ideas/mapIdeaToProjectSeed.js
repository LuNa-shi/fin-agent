export const IDEA_TO_PROJECT_MAPPING_VERSION = 'idea-to-project.v1';

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

function tickersFor(idea, input) {
  const source = Array.isArray(idea?.tickers) && idea.tickers.length
    ? idea.tickers
    : input.tickers;
  return Array.isArray(source)
    ? source.filter((ticker) => typeof ticker === 'string' && ticker.trim())
    : [];
}

// Pure ProjectSeed mapping. Store lookup, template selection, persistence, and
// index projection belong to createProjectFromIdea().
export function mapIdeaToProjectSeed(input = {}) {
  const idea = input.idea && typeof input.idea === 'object' ? input.idea : null;
  const title = firstNonEmpty(idea?.title, input.title);
  if (!title) throw new TypeError('title required');
  const theme = firstNonEmpty(idea?.theme, input.theme, 'general');
  const rationale = firstNonEmpty(idea?.rationale, input.rationale, title);
  const industryTemplate = firstNonEmpty(input.industryTemplate, 'industry_generic');
  const companyTemplate = firstNonEmpty(input.companyTemplate, 'company_generic');
  const titleZh = firstNonEmpty(idea?.titleZh, input.titleZh, title);

  return {
    title,
    theme,
    industryTemplate,
    companyTemplate,
    rationale,
    tickers: tickersFor(idea, input),
    titleZh,
  };
}
