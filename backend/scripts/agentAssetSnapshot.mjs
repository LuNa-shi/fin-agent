import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { parse } from 'espree';

import {
  DIRECT_AGENT_ASSET_CASES,
  RESEARCH_AGENT_ASSET_CASES,
  WORLDVIEW_AGENT_ASSET_CASES,
} from './support/expertAssetCases.js';
import { getAgentDefinition } from '../src/agents/registry.js';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const assetKey = (item) => `${item.agentId}/${item.caseId}`;

function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
    if (Array.isArray(value)) value.forEach((child) => visit(child, callback));
    else if (value && typeof value.type === 'string') visit(value, callback);
  }
}

function propertyName(node) {
  if (!node || node.computed) return null;
  if (node.key?.type === 'Identifier') return node.key.name;
  if (node.key?.type === 'Literal') return String(node.key.value);
  return null;
}

function findExpression(ast, selector) {
  const matches = [];
  visit(ast, (node) => {
    if (selector.kind === 'variable'
      && node.type === 'VariableDeclarator'
      && node.id?.type === 'Identifier'
      && node.id.name === selector.name
      && node.init) {
      matches.push(node.init);
    }
    if (selector.kind === 'property'
      && node.type === 'Property'
      && propertyName(node) === selector.name
      && node.value) {
      matches.push(node.value);
    }
  });
  matches.sort((a, b) => a.range[0] - b.range[0]);
  const expression = matches[selector.occurrence || 0];
  if (!expression) {
    throw new Error(`cannot find ${selector.kind} ${selector.name} occurrence ${selector.occurrence || 0}`);
  }
  return expression;
}

async function renderDirectSystemPrompt(item) {
  const filename = resolve(backendRoot, item.sourceFile);
  const source = await readFile(filename, 'utf8');
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    range: true,
  });
  const expression = findExpression(ast, item.selector);
  const expressionSource = source.slice(expression.range[0], expression.range[1]);
  const context = vm.createContext(clone(item.bindings || {}));
  const value = new vm.Script(`(${expressionSource})`, { filename }).runInContext(context);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${assetKey(item)} System Prompt did not render to a non-empty string`);
  }
  return value;
}

export async function captureResearchAgentAssets() {
  const assets = {};
  for (const item of RESEARCH_AGENT_ASSET_CASES) {
    const contract = getAgentDefinition(item.agentId);
    const rendered = contract.prompt(clone(item.input || {}));
    const systemPrompt = rendered?.system;
    if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) {
      throw new Error(`${assetKey(item)} System Prompt did not render to a non-empty string`);
    }
    assets[assetKey(item)] = {
      agentId: item.agentId,
      caseId: item.caseId,
      systemPrompt,
      systemPromptSha256: digest(systemPrompt),
      toolUse: clone(contract.toolPolicy),
    };
  }
  return { schemaVersion: 1, assets };
}

export async function captureWorldviewAgentAssets() {
  const assets = {};
  for (const item of WORLDVIEW_AGENT_ASSET_CASES) {
    const contract = getAgentDefinition(item.agentId);
    const rendered = contract.prompt(clone(item.input || {}));
    const systemPrompt = rendered?.system;
    if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) throw new Error(`${assetKey(item)} System Prompt did not render to a non-empty string`);
    assets[assetKey(item)] = { agentId: item.agentId, caseId: item.caseId, systemPrompt, systemPromptSha256: digest(systemPrompt), toolUse: { allow: clone(contract.toolPolicy.allow) } };
  }
  return { schemaVersion: 1, assets };
}

export async function captureDirectAgentAssets() {
  const assets = {};
  for (const item of DIRECT_AGENT_ASSET_CASES) {
    const definition = item.definitionInput ? getAgentDefinition(item.agentId) : null;
    const systemPrompt = definition
      ? definition.prompt(clone(item.definitionInput)).system
      : await renderDirectSystemPrompt(item);
    const allow = definition ? [...definition.toolPolicy.allow] : [];
    assets[assetKey(item)] = {
      agentId: item.agentId,
      caseId: item.caseId,
      systemPrompt,
      systemPromptSha256: digest(systemPrompt),
      toolUse: { allow },
    };
  }
  return { schemaVersion: 1, assets };
}
