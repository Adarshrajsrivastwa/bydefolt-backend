/**
 * Language proficiency (1–5 stars) and native flag.
 * Kept in sync with App language form (JobSeekerLanguage).
 */

export const MIN_PROFICIENCY_LEVEL = 1;
export const MAX_PROFICIENCY_LEVEL = 5;

export const PROFICIENCY_LABELS = {
  1: 'Beginner',
  2: 'Elementary',
  3: 'Intermediate',
  4: 'Advanced',
  5: 'Fluent / Professional',
};

/** Derive 1–5 stars from new or legacy oral/written fields. */
export function proficiencyFromRaw(x) {
  const p = Number(x?.proficiencyLevel);
  if (p >= MIN_PROFICIENCY_LEVEL && p <= MAX_PROFICIENCY_LEVEL) {
    return Math.round(p);
  }
  const oral = Number(x?.oralLevel) || 0;
  const written = Number(x?.writtenLevel) || oral;
  const avg = oral || written ? (oral + written) / 2 : 3;
  if (avg <= MAX_PROFICIENCY_LEVEL) {
    return Math.min(MAX_PROFICIENCY_LEVEL, Math.max(MIN_PROFICIENCY_LEVEL, Math.round(avg)));
  }
  return Math.min(
    MAX_PROFICIENCY_LEVEL,
    Math.max(MIN_PROFICIENCY_LEVEL, Math.round(avg / 2))
  );
}

/**
 * @param {unknown} x
 * @returns {{
 *   name: string;
 *   flagEmoji: string;
 *   proficiencyLevel: number;
 *   isNative: boolean;
 *   oralLevel: number;
 *   writtenLevel: number;
 *   isFirstLanguage: boolean;
 * }}
 */
export function normalizeLanguageEntry(x) {
  const proficiencyLevel = proficiencyFromRaw(x);
  const isNative = Boolean(x?.isNative ?? x?.isFirstLanguage);
  return {
    name: String(x?.name ?? '').trim().slice(0, 80) || 'Language',
    flagEmoji: String(x?.flagEmoji ?? '🌐').slice(0, 8),
    proficiencyLevel,
    isNative,
    /** Legacy mirrors — same 1–5 scale for old clients */
    oralLevel: proficiencyLevel,
    writtenLevel: proficiencyLevel,
    isFirstLanguage: isNative,
  };
}

/**
 * @param {unknown} list
 * @param {number} maxCount
 */
export function normalizeLanguageList(list, maxCount = 24) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, maxCount).map(normalizeLanguageEntry);
}
