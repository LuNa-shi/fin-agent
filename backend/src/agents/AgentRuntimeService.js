import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { canonicalSha256 } from '../core/contracts/ArtifactRef.js';
import { runtimeToolNames } from '../core/agent-backend/runtimeToolPolicy.js';
import { atomicWriteFileSync, withFileLockSync } from '../lib/fileLock.js';
import { toolRegistry as defaultToolRegistry } from '../tools/toolCatalog.js';
import { defineAgent } from './defineAgent.js';
import { listAgentDefinitions } from './registry.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  workflowSpecHash,
} from '../workflows/run-analysis/workflowSpec.js';

export const AGENT_OVERLAY_SCHEMA_VERSION = 'agent-catalog-overlays.v1';
export const SKILL_REGISTRY_SCHEMA_VERSION = 'skills-registry.v1';
export const EFFECTIVE_AGENT_CONFIG_SCHEMA_VERSION = 'effective-agent-config.v1';

const AGENT_PATCH_FIELDS = new Set([
  'displayName',
  'description',
  'purpose',
  'catalogVisibility',
  'systemPrompt',
  'toolAllow',
  'assignedSkillIds',
]);
const SKILL_CREATE_FIELDS = new Set(['id', 'name', 'description', 'instruction', 'toolIds', 'visibility']);
const SKILL_UPDATE_FIELDS = new Set(['name', 'description', 'instruction', 'toolIds', 'visibility']);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_VISIBILITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u;
const SYSTEM_PROMPT_PREVIEW_CHARS = 4000;
const PROMPT_PREVIEW_INPUT = Object.freeze({ conclusion: null, sourceBlob: '' });

function serviceError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function uniqueStrings(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw serviceError(`${field} must be an array`, 'INVALID_RUNTIME_CONFIG');
  const normalized = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  if (!allowEmpty && normalized.length === 0) throw serviceError(`${field} must not be empty`, 'INVALID_RUNTIME_CONFIG');
  return normalized;
}

function optionalText(value, field, { max = 100000, allowEmpty = false } = {}) {
  if (value === null) return null;
  if (typeof value !== 'string') throw serviceError(`${field} must be a string or null`, 'INVALID_RUNTIME_CONFIG');
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw serviceError(`${field} must not be empty`, 'INVALID_RUNTIME_CONFIG');
  if (value.length > max) throw serviceError(`${field} exceeds ${max} characters`, 'INVALID_RUNTIME_CONFIG');
  return value;
}

function assertFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(`${label} must be an object`, 'INVALID_RUNTIME_CONFIG');
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw serviceError(`${label} contains immutable or unsupported fields: ${unexpected.join(', ')}`, 'IMMUTABLE_AGENT_FIELD');
  }
}

function defaultOverlayState() {
  return {
    schemaVersion: AGENT_OVERLAY_SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    agents: {},
  };
}

function defaultSkillState() {
  return {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    skills: {},
  };
}

function readState(file, fallback, schemaVersion, collectionField) {
  if (!fs.existsSync(file)) return fallback();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw serviceError(`runtime registry is unreadable: ${error.message}`, 'RUNTIME_REGISTRY_CORRUPT', 500);
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || parsed.schemaVersion !== schemaVersion
    || !Number.isInteger(parsed.revision)
    || parsed.revision < 0
    || !parsed[collectionField]
    || typeof parsed[collectionField] !== 'object'
    || Array.isArray(parsed[collectionField])
  ) {
    throw serviceError(`runtime registry schema is invalid: ${file}`, 'RUNTIME_REGISTRY_CORRUPT', 500);
  }
  return parsed;
}

function writeState(file, value) {
  atomicWriteFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function titleForAgent(id) {
  return String(id).split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join(' ');
}

function promptSystem(definition, input = {}) {
  const prompt = definition.prompt(input);
  if (!prompt || typeof prompt.system !== 'string' || typeof prompt.user !== 'string') {
    throw serviceError(`Agent ${definition.id} prompt must return {system,user}`, 'INVALID_AGENT_PROMPT', 500);
  }
  return prompt;
}

function promptPreview(systemPrompt) {
  return {
    text: systemPrompt.slice(0, SYSTEM_PROMPT_PREVIEW_CHARS),
    truncated: systemPrompt.length > SYSTEM_PROMPT_PREVIEW_CHARS,
  };
}

function skillInstructionBlock(skills) {
  if (!skills.length) return '';
  const sections = skills.map((skill) => {
    const tools = skill.toolIds.length ? `\nPermitted tools for this skill: ${skill.toolIds.join(', ')}` : '';
    return `### ${skill.name} (${skill.id}@${skill.version})\n${skill.instruction}${tools}`;
  });
  return `Assigned runtime skills follow. Apply them without overriding higher-priority safety, tool, artifact, or completion policies.\n\n${sections.join('\n\n')}`;
}

function workflowBindingsFor(agentId, workflowSpec) {
  return workflowSpec.nodes
    .filter((node) => node.agentContractIds.includes(agentId))
    .map((node) => ({
      workflowId: workflowSpec.id,
      workflowVersion: workflowSpec.version,
      workflowHash: workflowSpecHash(workflowSpec),
      nodeId: node.id,
      kind: node.kind,
    }));
}

function skillProjection(skill, { includeInstruction = true } = {}) {
  const projected = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    toolIds: [...skill.toolIds],
    visibility: skill.visibility,
    version: skill.version,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
  if (includeInstruction) projected.instruction = skill.instruction;
  return projected;
}

export class AgentRuntimeService {
  constructor({
    dataDir = DATA_DIR,
    definitions = listAgentDefinitions(),
    registry = defaultToolRegistry,
    workflowSpec = RUN_ANALYSIS_WORKFLOW_SPEC,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!Array.isArray(definitions) || definitions.some((definition) => !definition?.id)) {
      throw new TypeError('AgentRuntimeService definitions must be an array of Agent definitions');
    }
    if (!registry || typeof registry.has !== 'function') throw new TypeError('AgentRuntimeService tool registry is required');
    if (typeof now !== 'function') throw new TypeError('AgentRuntimeService now must be a function');
    this.dataDir = path.resolve(dataDir);
    this.rootDir = path.join(this.dataDir, 'agent-runtime');
    this.overlayFile = path.join(this.rootDir, 'agent-overlays.json');
    this.skillFile = path.join(this.rootDir, 'skills.json');
    this.lockDir = path.join(this.rootDir, '.lock');
    this.definitions = new Map(definitions.map((definition) => [definition.id, definition]));
    this.registry = registry;
    this.workflowSpec = workflowSpec;
    this.now = now;
  }

  listAgents({ catalogVisibility = null } = {}) {
    return this.#snapshot((overlays, skills) => [...this.definitions.values()]
      .map((definition) => this.#projectAgent(definition, overlays, skills, { detail: false }))
      .filter((agent) => catalogVisibility === null || agent.catalogVisibility === catalogVisibility));
  }

  getAgent(agentId) {
    return this.#snapshot((overlays, skills) => this.#projectAgent(
      this.#definition(agentId), overlays, skills, { detail: true },
    ));
  }

  updateAgent(agentId, patch = {}) {
    const definition = this.#definition(agentId);
    assertFields(patch, AGENT_PATCH_FIELDS, 'Agent overlay');
    if (Object.prototype.hasOwnProperty.call(patch, 'description') && Object.prototype.hasOwnProperty.call(patch, 'purpose')) {
      throw serviceError('Use either description or purpose, not both', 'INVALID_RUNTIME_CONFIG');
    }

    return withFileLockSync(this.lockDir, () => {
      const overlays = this.#readOverlays();
      const skills = this.#readSkills();
      const prior = overlays.agents[agentId] || {};
      const next = { ...prior };

      if (Object.prototype.hasOwnProperty.call(patch, 'displayName')) {
        const value = optionalText(patch.displayName, 'displayName', { max: 160 });
        if (value === null) delete next.displayName;
        else next.displayName = value.trim();
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'description') || Object.prototype.hasOwnProperty.call(patch, 'purpose')) {
        const raw = Object.prototype.hasOwnProperty.call(patch, 'description') ? patch.description : patch.purpose;
        const value = optionalText(raw, 'description', { max: 4000 });
        if (value === null) delete next.purpose;
        else next.purpose = value.trim();
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'catalogVisibility')) {
        const value = optionalText(patch.catalogVisibility, 'catalogVisibility', { max: 40 });
        if (value === null) delete next.catalogVisibility;
        else {
          const normalized = value.trim();
          if (!SAFE_VISIBILITY.test(normalized)) throw serviceError('catalogVisibility is unsafe', 'INVALID_RUNTIME_CONFIG');
          next.catalogVisibility = normalized;
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'systemPrompt')) {
        const value = optionalText(patch.systemPrompt, 'systemPrompt');
        if (value === null) delete next.systemPrompt;
        else next.systemPrompt = value;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'toolAllow')) {
        if (patch.toolAllow === null) delete next.toolAllow;
        else next.toolAllow = uniqueStrings(patch.toolAllow, 'toolAllow');
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'assignedSkillIds')) {
        if (patch.assignedSkillIds === null) delete next.assignedSkillIds;
        else next.assignedSkillIds = uniqueStrings(patch.assignedSkillIds, 'assignedSkillIds');
      }

      this.#validateOverlay(definition, next, skills);
      const timestamp = this.now();
      const stored = {
        ...next,
        version: (prior.version || 0) + 1,
        createdAt: prior.createdAt || timestamp,
        updatedAt: timestamp,
      };
      const state = {
        ...overlays,
        revision: overlays.revision + 1,
        updatedAt: timestamp,
        agents: { ...overlays.agents, [agentId]: stored },
      };
      writeState(this.overlayFile, state);
      return this.#projectAgent(definition, state, skills, { detail: true });
    });
  }

  assignSkills(agentId, assignedSkillIds = []) {
    return this.updateAgent(agentId, { assignedSkillIds });
  }

  getEffectiveDefinition(agentId) {
    return this.#snapshot((overlays, skills) => this.#effectiveDefinition(
      this.#definition(agentId), overlays, skills,
    ));
  }

  listSkills({ visibility = null } = {}) {
    return this.#snapshot((_overlays, skills) => Object.values(skills.skills)
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((skill) => visibility === null || skill.visibility === visibility)
      .map((skill) => skillProjection(skill)));
  }

  getSkill(skillId) {
    return this.#snapshot((_overlays, skills) => skillProjection(this.#skill(skills, skillId)));
  }

  createSkill(input = {}) {
    assertFields(input, SKILL_CREATE_FIELDS, 'Skill');
    for (const field of SKILL_CREATE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) {
        throw serviceError(`Skill.${field} is required`, 'INVALID_SKILL');
      }
    }
    const id = String(input.id || '').trim();
    if (!SAFE_ID.test(id)) throw serviceError('Skill.id is unsafe', 'INVALID_SKILL');

    return withFileLockSync(this.lockDir, () => {
      const skills = this.#readSkills();
      if (skills.skills[id]) throw serviceError(`Skill already exists: ${id}`, 'SKILL_EXISTS', 409);
      const timestamp = this.now();
      const skill = this.#normalizeSkill({ ...input, id }, {
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const state = {
        ...skills,
        revision: skills.revision + 1,
        updatedAt: timestamp,
        skills: { ...skills.skills, [id]: skill },
      };
      writeState(this.skillFile, state);
      return skillProjection(skill);
    });
  }

  updateSkill(skillId, patch = {}) {
    assertFields(patch, SKILL_UPDATE_FIELDS, 'Skill update');
    return withFileLockSync(this.lockDir, () => {
      const overlays = this.#readOverlays();
      const skills = this.#readSkills();
      const prior = this.#skill(skills, skillId);
      const timestamp = this.now();
      const candidate = this.#normalizeSkill({ ...prior, ...patch, id: prior.id }, {
        version: prior.version + 1,
        createdAt: prior.createdAt,
        updatedAt: timestamp,
      });
      this.#validateSkillAssignments(candidate, overlays);
      const state = {
        ...skills,
        revision: skills.revision + 1,
        updatedAt: timestamp,
        skills: { ...skills.skills, [skillId]: candidate },
      };
      writeState(this.skillFile, state);
      return skillProjection(candidate);
    });
  }

  deleteSkill(skillId) {
    return withFileLockSync(this.lockDir, () => {
      const overlays = this.#readOverlays();
      const skills = this.#readSkills();
      const skill = this.#skill(skills, skillId);
      const assignedAgentIds = Object.entries(overlays.agents)
        .filter(([, overlay]) => (overlay.assignedSkillIds || []).includes(skillId))
        .map(([agentId]) => agentId);
      if (assignedAgentIds.length) {
        throw serviceError(
          `Skill ${skillId} is assigned to: ${assignedAgentIds.join(', ')}`,
          'SKILL_ASSIGNED',
          409,
        );
      }
      const nextSkills = { ...skills.skills };
      delete nextSkills[skillId];
      const timestamp = this.now();
      writeState(this.skillFile, {
        ...skills,
        revision: skills.revision + 1,
        updatedAt: timestamp,
        skills: nextSkills,
      });
      return skillProjection(skill);
    });
  }

  #snapshot(fn) {
    return withFileLockSync(this.lockDir, () => fn(this.#readOverlays(), this.#readSkills()));
  }

  #readOverlays() {
    return readState(this.overlayFile, defaultOverlayState, AGENT_OVERLAY_SCHEMA_VERSION, 'agents');
  }

  #readSkills() {
    return readState(this.skillFile, defaultSkillState, SKILL_REGISTRY_SCHEMA_VERSION, 'skills');
  }

  #definition(agentId) {
    const definition = this.definitions.get(agentId);
    if (!definition) throw serviceError(`unknown Agent definition: ${agentId}`, 'AGENT_NOT_FOUND', 404);
    return definition;
  }

  #skill(skills, skillId) {
    const skill = skills.skills[skillId];
    if (!skill) throw serviceError(`Skill not found: ${skillId}`, 'SKILL_NOT_FOUND', 404);
    return skill;
  }

  #normalizeSkill(value, metadata) {
    const name = optionalText(value.name, 'Skill.name', { max: 200 });
    const description = optionalText(value.description, 'Skill.description', { max: 4000, allowEmpty: true });
    const instruction = optionalText(value.instruction, 'Skill.instruction');
    const visibility = optionalText(value.visibility, 'Skill.visibility', { max: 40 });
    if ([name, description, instruction, visibility].some((field) => field === null)) {
      throw serviceError('Skill text fields cannot be null', 'INVALID_SKILL');
    }
    const toolIds = uniqueStrings(value.toolIds, 'Skill.toolIds');
    if (!SAFE_VISIBILITY.test(visibility.trim())) throw serviceError('Skill.visibility is unsafe', 'INVALID_SKILL');
    const unknownTools = toolIds.filter((toolId) => !this.registry.has(toolId));
    if (unknownTools.length) throw serviceError(`Skill contains unknown tools: ${unknownTools.join(', ')}`, 'UNKNOWN_SKILL_TOOL');
    return {
      id: value.id,
      name: name.trim(),
      description: description.trim(),
      instruction,
      toolIds,
      visibility: visibility.trim(),
      ...metadata,
    };
  }

  #effectiveToolAllow(definition, overlay) {
    try {
      return runtimeToolNames(definition, Object.prototype.hasOwnProperty.call(overlay, 'toolAllow')
        ? { toolAllow: overlay.toolAllow }
        : {});
    } catch (error) {
      throw serviceError(error.message, 'AGENT_TOOL_POLICY_EXPANSION');
    }
  }

  #validateOverlay(definition, overlay, skills) {
    const effectiveTools = this.#effectiveToolAllow(definition, overlay);
    const assignedSkills = (overlay.assignedSkillIds || []).map((skillId) => this.#skill(skills, skillId));
    const effectiveToolSet = new Set(effectiveTools);
    for (const skill of assignedSkills) {
      const disallowed = skill.toolIds.filter((toolId) => !effectiveToolSet.has(toolId));
      if (disallowed.length) {
        throw serviceError(
          `Skill ${skill.id} requires tools outside Agent ${definition.id} effective allow list: ${disallowed.join(', ')}`,
          'SKILL_TOOL_POLICY_VIOLATION',
        );
      }
    }
  }

  #validateSkillAssignments(skill, overlays) {
    for (const [agentId, overlay] of Object.entries(overlays.agents)) {
      if (!(overlay.assignedSkillIds || []).includes(skill.id)) continue;
      const definition = this.#definition(agentId);
      const effectiveToolSet = new Set(this.#effectiveToolAllow(definition, overlay));
      const disallowed = skill.toolIds.filter((toolId) => !effectiveToolSet.has(toolId));
      if (disallowed.length) {
        throw serviceError(
          `Skill ${skill.id} update would exceed Agent ${agentId} effective allow list: ${disallowed.join(', ')}`,
          'SKILL_TOOL_POLICY_VIOLATION',
          409,
        );
      }
    }
  }

  #effectiveDefinition(definition, overlays, skills) {
    const overlay = overlays.agents[definition.id] || {};
    this.#validateOverlay(definition, overlay, skills);
    const assignedSkills = (overlay.assignedSkillIds || []).map((skillId) => this.#skill(skills, skillId));
    const effectiveTools = this.#effectiveToolAllow(definition, overlay);
    const digestInput = {
      schemaVersion: EFFECTIVE_AGENT_CONFIG_SCHEMA_VERSION,
      agentId: definition.id,
      definitionVersion: definition.version,
      overlayVersion: overlay.version || 0,
      displayName: overlay.displayName || null,
      purpose: overlay.purpose || null,
      catalogVisibility: overlay.catalogVisibility || null,
      systemPrompt: overlay.systemPrompt || null,
      toolAllow: effectiveTools,
      skills: assignedSkills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        instruction: skill.instruction,
        toolIds: skill.toolIds,
      })),
    };
    const revision = [
      `definition@${definition.version}`,
      `overlay@${overlay.version || 0}`,
      `skills@${assignedSkills.map((skill) => `${skill.id}:${skill.version}`).join(',') || 'none'}`,
    ].join(';');
    const effectiveConfig = {
      schemaVersion: EFFECTIVE_AGENT_CONFIG_SCHEMA_VERSION,
      revision,
      digest: canonicalSha256(digestInput),
      definitionVersion: definition.version,
      overlayVersion: overlay.version || 0,
      skillRevisions: assignedSkills.map((skill) => ({ id: skill.id, version: skill.version })),
    };
    const instructionBlock = skillInstructionBlock(assignedSkills);
    const effectivePrompt = (input = {}) => {
      const generated = promptSystem(definition, input);
      const primarySystem = overlay.systemPrompt || generated.system;
      return {
        ...generated,
        system: instructionBlock ? `${primarySystem}\n\n${instructionBlock}` : primarySystem,
      };
    };
    return defineAgent({
      ...definition,
      displayName: overlay.displayName || titleForAgent(definition.id),
      purpose: overlay.purpose || definition.purpose,
      visibility: {
        ...definition.visibility,
        catalog: overlay.catalogVisibility || definition.visibility.catalog,
        workflows: [...definition.visibility.workflows],
      },
      toolPolicy: {
        ...definition.toolPolicy,
        allow: effectiveTools,
        deny: [...(definition.toolPolicy.deny || [])],
        writeScopes: [...definition.toolPolicy.writeScopes],
      },
      assignedSkills: assignedSkills.map((skill) => skillProjection(skill)),
      effectiveConfig,
      prompt: effectivePrompt,
    }, { registry: this.registry });
  }

  #projectAgent(definition, overlays, skills, { detail }) {
    const overlay = overlays.agents[definition.id] || {};
    const effective = this.#effectiveDefinition(definition, overlays, skills);
    const baseline = promptSystem(definition, PROMPT_PREVIEW_INPUT).system;
    const preview = promptPreview(baseline);
    const projected = {
      id: definition.id,
      version: definition.version,
      domain: definition.domain,
      displayName: effective.displayName,
      description: effective.purpose,
      purpose: effective.purpose,
      source: definition.source || null,
      visibility: clone(effective.visibility),
      catalogVisibility: effective.visibility.catalog,
      executionMode: definition.executionMode,
      contractToolAllow: [...definition.toolPolicy.allow],
      toolPolicy: clone(effective.toolPolicy),
      modelPolicy: clone(definition.modelPolicy),
      runPolicy: clone(definition.runPolicy),
      completionPolicy: clone(definition.completionPolicy),
      artifactAuthority: definition.artifactAuthority,
      outputPaths: [...definition.outputPaths],
      workflowNodeBindings: workflowBindingsFor(definition.id, this.workflowSpec),
      assignedSkillIds: effective.assignedSkills.map((skill) => skill.id),
      assignedSkills: effective.assignedSkills.map((skill) => skillProjection(skill, { includeInstruction: detail })),
      baselineSystemPromptPreview: preview.text,
      baselineSystemPromptTruncated: preview.truncated,
      effectiveConfig: clone(effective.effectiveConfig),
    };
    if (detail) {
      projected.editableSystemPrompt = overlay.systemPrompt || baseline;
      projected.effectiveSystemPrompt = effective.prompt(PROMPT_PREVIEW_INPUT).system;
      projected.overlay = {
        version: overlay.version || 0,
        displayName: overlay.displayName ?? null,
        description: overlay.purpose ?? null,
        catalogVisibility: overlay.catalogVisibility ?? null,
        systemPrompt: overlay.systemPrompt ?? null,
        toolAllow: overlay.toolAllow ? [...overlay.toolAllow] : null,
        assignedSkillIds: overlay.assignedSkillIds ? [...overlay.assignedSkillIds] : [],
        createdAt: overlay.createdAt || null,
        updatedAt: overlay.updatedAt || null,
      };
    }
    return projected;
  }
}

export const agentRuntimeService = new AgentRuntimeService();

export function getEffectiveAgentDefinition(agentId) {
  return agentRuntimeService.getEffectiveDefinition(agentId);
}
