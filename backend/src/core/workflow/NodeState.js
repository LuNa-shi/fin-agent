export const NODE_STATES = Object.freeze({
  PENDING: 'PENDING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED_TRANSIENT: 'FAILED_TRANSIENT',
  FAILED_BUSINESS: 'FAILED_BUSINESS',
  FAILED_SCHEMA: 'FAILED_SCHEMA',
  FAILED_PERMISSION: 'FAILED_PERMISSION',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
});

export const FAILURE_NODE_STATES = Object.freeze([
  NODE_STATES.FAILED_TRANSIENT,
  NODE_STATES.FAILED_BUSINESS,
  NODE_STATES.FAILED_SCHEMA,
  NODE_STATES.FAILED_PERMISSION,
]);

const KNOWN_STATES = new Set(Object.values(NODE_STATES));
const FAILURE_STATES = new Set(FAILURE_NODE_STATES);
const TRANSITIONS = new Map([
  [NODE_STATES.PENDING, new Set([NODE_STATES.READY, NODE_STATES.BLOCKED, NODE_STATES.CANCELLED])],
  [NODE_STATES.READY, new Set([NODE_STATES.RUNNING, NODE_STATES.BLOCKED, NODE_STATES.CANCELLED])],
  [NODE_STATES.RUNNING, new Set([
    NODE_STATES.SUCCEEDED,
    ...FAILURE_NODE_STATES,
    NODE_STATES.BLOCKED,
    NODE_STATES.CANCELLED,
  ])],
  [NODE_STATES.FAILED_TRANSIENT, new Set([NODE_STATES.READY, NODE_STATES.BLOCKED, NODE_STATES.CANCELLED])],
  [NODE_STATES.FAILED_BUSINESS, new Set([NODE_STATES.READY, NODE_STATES.BLOCKED, NODE_STATES.CANCELLED])],
  [NODE_STATES.FAILED_SCHEMA, new Set([NODE_STATES.READY, NODE_STATES.BLOCKED, NODE_STATES.CANCELLED])],
  [NODE_STATES.FAILED_PERMISSION, new Set([NODE_STATES.READY, NODE_STATES.BLOCKED, NODE_STATES.CANCELLED])],
  [NODE_STATES.BLOCKED, new Set([NODE_STATES.READY, NODE_STATES.CANCELLED])],
  [NODE_STATES.CANCELLED, new Set([NODE_STATES.READY])],
  [NODE_STATES.SUCCEEDED, new Set()],
]);

export function assertNodeState(value, label = 'node state') {
  if (!KNOWN_STATES.has(value)) throw new TypeError(`${label} is invalid: ${value}`);
  return value;
}

export function canTransitionNodeState(from, to) {
  assertNodeState(from, 'from node state');
  assertNodeState(to, 'to node state');
  return TRANSITIONS.get(from).has(to);
}

export function transitionNodeState(record, to, patch = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('node record is required');
  }
  const from = assertNodeState(record.status);
  assertNodeState(to);
  if (!canTransitionNodeState(from, to)) {
    throw new Error(`invalid node state transition: ${from} -> ${to}`);
  }
  return { ...record, ...patch, status: to };
}

export function isFailureNodeState(value) {
  return FAILURE_STATES.has(value);
}

export function isTerminalNodeState(value) {
  assertNodeState(value);
  return value === NODE_STATES.SUCCEEDED
    || value === NODE_STATES.BLOCKED
    || value === NODE_STATES.CANCELLED
    || FAILURE_STATES.has(value);
}
