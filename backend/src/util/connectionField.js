/** @type {readonly string[]} */
export const CONNECTION_FIELDS = Object.freeze([
  'Software',
  'Design',
  'Data',
  'Marketing',
  'HR',
]);

/**
 * Deterministic field bucket from BD ID (matches app fallback).
 * @param {string} bdId
 */
export function inferConnectionField(bdId) {
  const s = String(bdId || '').trim();
  if (!s) return CONNECTION_FIELDS[2];
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h + s.charCodeAt(i)) % CONNECTION_FIELDS.length;
  }
  return CONNECTION_FIELDS[h];
}

/**
 * @param {{ bdId?: string; connectionField?: string | null }} user
 */
export function effectiveConnectionField(user) {
  const raw = user.connectionField && String(user.connectionField).trim();
  if (raw && CONNECTION_FIELDS.includes(raw)) return raw;
  return inferConnectionField(user.bdId || '');
}
