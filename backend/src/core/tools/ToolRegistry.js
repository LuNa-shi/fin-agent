// Domain-neutral tool registration. Agent permission policies intentionally live elsewhere.

function validateRegistration(name, definition) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('tool name must be a non-empty string');
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError(`tool definition must be an object: ${name}`);
  }
  if (typeof definition.run !== 'function') throw new TypeError(`tool run must be a function: ${name}`);
}

export class ToolRegistry {
  #tools = new Map();

  constructor(entries = []) {
    for (const [name, definition] of entries) this.register(name, definition);
  }

  register(name, definition) {
    validateRegistration(name, definition);
    if (this.#tools.has(name)) throw new Error(`duplicate tool: ${name}`);
    const registered = Object.freeze({ ...definition });
    this.#tools.set(name, registered);
    return registered;
  }

  has(name) {
    return this.#tools.has(name);
  }

  get(name) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool;
  }

  ids() {
    return [...this.#tools.keys()];
  }

  entries() {
    return [...this.#tools.entries()];
  }

  list() {
    return this.entries().map(([name, tool]) => ({ name, ...tool }));
  }

  async execute(name, args = {}) {
    return this.get(name).run(args);
  }

  toObject() {
    return Object.freeze(Object.fromEntries(this.#tools));
  }

  get size() {
    return this.#tools.size;
  }
}
