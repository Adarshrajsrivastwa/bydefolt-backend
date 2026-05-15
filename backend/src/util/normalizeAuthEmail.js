/** Must match [EMAIL_NORM_OPTS] on express-validator email fields in auth routes. */
export const EMAIL_NORM_OPTS = {
  gmail_remove_dots: false,
  gmail_remove_subaddress: false,
};

export function normalizeAuthEmail(input) {
  return String(input || '').trim().toLowerCase();
}

/** Find user by email with fallbacks for legacy rows. */
export async function findUserByAuthEmail(User, emailInput, select = '') {
  const normalized = normalizeAuthEmail(emailInput);
  const candidates = [...new Set([normalized, String(emailInput || '').trim().toLowerCase()].filter(Boolean))];

  for (const email of candidates) {
    const q = User.findOne({ email });
    const user = select ? await q.select(select) : await q;
    if (user) return user;
  }
  return null;
}
