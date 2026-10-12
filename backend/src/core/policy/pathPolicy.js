function escapeRegexChar(char) {
  return /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char;
}

export function normalizeSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return null;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

export function matchesPathPattern(value, pattern) {
  if (typeof value !== 'string' || typeof pattern !== 'string' || !pattern) return false;
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegexChar(char);
    }
  }
  return new RegExp(`${source}$`, 'u').test(value);
}

export function matchesAnyPathPattern(value, patterns = []) {
  return Array.isArray(patterns) && patterns.some((pattern) => matchesPathPattern(value, pattern));
}
