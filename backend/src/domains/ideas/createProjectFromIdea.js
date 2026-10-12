import { runtime } from '../../config.js';
import { canonicalSha256 } from '../../core/contracts/ArtifactRef.js';
import { globalContentIndex } from '../../core/persistence/GlobalContentIndex.js';
import { ProjectSpace } from '../../project-space/ProjectSpace.js';
import { TemplateSystem } from '../research/templates/templateSystem.js';
import { IdeaStore } from './IdeaStore.js';
import {
  IDEA_TO_PROJECT_MAPPING_VERSION,
  mapIdeaToProjectSeed,
} from './mapIdeaToProjectSeed.js';

function dependencies(overrides = {}) {
  return {
    projectStore: overrides.projectStore || ProjectSpace,
    ideaStore: overrides.ideaStore || IdeaStore,
    templateSystem: overrides.templateSystem || TemplateSystem,
    index: Object.prototype.hasOwnProperty.call(overrides, 'index')
      ? overrides.index
      : globalContentIndex,
    defaults: overrides.defaults || runtime,
  };
}

function projectError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function resolveIdea(input, ideaStore) {
  if (!input.ideaId) return { idea: null, writable: false };
  const idea = typeof ideaStore.getIdea === 'function'
    ? ideaStore.getIdea(input.ideaId)
    : ideaStore.getIdeas().find((candidate) => candidate.id === input.ideaId) || null;
  if (!idea) {
    throw projectError(`Idea not found: ${input.ideaId}`, 'IDEA_NOT_FOUND', 404);
  }
  return {
    idea,
    writable: typeof ideaStore.isWritable === 'function'
      ? ideaStore.isWritable(idea.id)
      : true,
  };
}

function resolveTemplates(input, idea, templateSystem) {
  const routingText = [
    idea?.title || input.title,
    idea?.theme || input.theme,
    idea?.rationale || input.rationale,
  ].filter(Boolean).join(' ');
  const industryTemplate = input.industryTemplate && templateSystem.get(input.industryTemplate)
    ? input.industryTemplate
    : templateSystem.matchIndustryTemplate(routingText).template?.id || 'industry_generic';
  const companyTemplate = input.companyTemplate && templateSystem.get(input.companyTemplate)
    ? input.companyTemplate
    : templateSystem.matchCompanyTemplate(routingText).template?.id || 'company_generic';
  return { industryTemplate, companyTemplate };
}

function linkageFor(idea, writable) {
  if (!idea) {
    return {
      sourceIdeaId: null,
      sourceIdeaRunId: null,
      sourceRunInputSnapshotId: null,
    };
  }
  return {
    sourceIdeaId: idea.id,
    sourceIdeaRunId: writable
      ? (idea.sourceIdeaRunId || idea.sourceRunId || null)
      : null,
    sourceRunInputSnapshotId: writable
      ? (idea.sourceRunInputSnapshotId || idea.sourceSnapshotId || null)
      : null,
  };
}

function refreshProjection(index) {
  if (!index) return null;
  try {
    return index.rebuild();
  } catch {
    // Idea and Project folders are authoritative. A later index read repairs
    // the rebuildable projection without rolling back committed content.
    return null;
  }
}

function existingMappedProject(projectStore, projectCreationKey) {
  if (!projectCreationKey || typeof projectStore.list !== 'function') return null;
  return projectStore.list().find((project) => (
    project.projectCreationKey === projectCreationKey
  )) || null;
}

function associateProject(deps, idea, project) {
  const updated = typeof deps.ideaStore.associateProject === 'function'
    ? deps.ideaStore.associateProject(idea.id, project.id, { refreshIndex: false })
    : deps.ideaStore.updateIdea(idea.id, {
        status: 'added',
        associatedProjectIds: [...new Set([
          ...(Array.isArray(idea.associatedProjectIds) ? idea.associatedProjectIds : []),
          project.id,
        ])],
      }, { refreshIndex: false });
  if (!updated) {
    const error = projectError(
      `Idea association failed after Project commit: ${idea.id}`,
      'IDEA_PROJECT_ASSOCIATION_FAILED',
      409,
    );
    error.projectId = project.id;
    throw error;
  }
}

function executeProjectCommand(input, deps) {
  const { idea, writable } = resolveIdea(input, deps.ideaStore);
  const templates = resolveTemplates(input, idea, deps.templateSystem);
  const seed = mapIdeaToProjectSeed({ ...input, ...templates, idea });
  const linkage = linkageFor(idea, writable);
  const projectSettings = {
    intensity: input.intensity || 'standard',
    analysisLanguage: input.analysisLanguage || deps.defaults.ANALYSIS_LANGUAGE,
    reportLanguage: input.reportLanguage || deps.defaults.REPORT_LANGUAGE,
    companyLocale: input.companyLocale || 'global',
  };
  const source = idea ? 'idea' : (input.source === 'quick' ? 'quick' : 'manual');
  const projectCreationKey = canonicalSha256({
    mappingVersion: IDEA_TO_PROJECT_MAPPING_VERSION,
    seed,
    linkage,
    projectSettings,
    source,
    sourceText: input.sourceText || null,
  });
  const recovered = existingMappedProject(deps.projectStore, projectCreationKey);
  const project = recovered || deps.projectStore.create({
    ...seed,
    ...projectSettings,
    source,
    ...(input.sourceText ? { sourceText: input.sourceText } : {}),
    ...linkage,
    projectSeedMappingVersion: IDEA_TO_PROJECT_MAPPING_VERSION,
    projectCreationKey,
  }, { refreshIndex: false });

  try {
    if (idea && writable) associateProject(deps, idea, project);
    return project;
  } catch (error) {
    if (error?.code === 'IDEA_PROJECT_ASSOCIATION_FAILED') {
      error.projectCreationKey = error.projectCreationKey || projectCreationKey;
      throw error;
    }
    const partial = projectError(
      `Idea association failed after Project commit: ${idea?.id || 'unknown'}`,
      'IDEA_PROJECT_ASSOCIATION_FAILED',
      409,
    );
    partial.cause = error;
    partial.projectId = project.id;
    partial.projectCreationKey = projectCreationKey;
    throw partial;
  } finally {
    refreshProjection(deps.index);
  }
}

export function createProjectFromIdea(input = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const resolved = resolveIdea(input, deps.ideaStore);
  const execute = () => (
    typeof deps.projectStore.withCreationLock === 'function'
      ? deps.projectStore.withCreationLock(() => executeProjectCommand(input, deps))
      : executeProjectCommand(input, deps)
  );
  if (
    resolved.idea
    && resolved.writable
    && typeof deps.ideaStore.withProjectAssociationLock === 'function'
  ) {
    return deps.ideaStore.withProjectAssociationLock(
      resolved.idea.id,
      execute,
    );
  }
  return execute();
}
