export function runtimeToolNames(contract, runtime = {}) {
  const declared = Array.isArray(contract?.toolPolicy?.allow) ? contract.toolPolicy.allow : [];
  if (!Object.prototype.hasOwnProperty.call(runtime, 'toolAllow')) return [...declared];
  if (!Array.isArray(runtime.toolAllow)) throw new TypeError('runtime.toolAllow must be an array');
  const declaredSet = new Set(declared);
  const narrowed = [...new Set(runtime.toolAllow.map((name) => String(name || '').trim()).filter(Boolean))];
  const expanded = narrowed.filter((name) => !declaredSet.has(name));
  if (expanded.length) {
    const error = new TypeError(`runtime.toolAllow cannot expand contract Tool Use: ${expanded.join(', ')}`);
    error.code = 'RUNTIME_TOOL_POLICY_EXPANSION';
    throw error;
  }
  return narrowed;
}
