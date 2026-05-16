/** Roles that use feed, connections inbox, and member messaging APIs. */
export const MEMBER_NETWORK_ROLES = new Set(['jobSeeker', 'recruiter', 'company', 'owner']);

/** BD ID targets for connection requests (Follow). */
export const CONNECTION_TARGET_ROLES = new Set(['jobSeeker', 'recruiter']);

export function isConnectionTargetRole(role) {
  return CONNECTION_TARGET_ROLES.has(role);
}

/** Job seeker CV API (also for recruiters who filled profile as members). */
export function canManageOwnJobSeekerProfile(user) {
  return Boolean(user && (user.role === 'jobSeeker' || user.role === 'recruiter'));
}

/** Whether [meRole] may DM [partnerRole] when connection is accepted. */
export function isDmPartner(meRole, partnerRole) {
  if (meRole === 'jobSeeker') {
    return partnerRole === 'jobSeeker' || partnerRole === 'recruiter';
  }
  if (meRole === 'recruiter' || meRole === 'company' || meRole === 'owner') {
    return partnerRole === 'jobSeeker';
  }
  return false;
}

/**
 * @param {{ _id: unknown, role: string }} me
 * @param {{ from: object, to: object }} doc lean connection
 * @returns {{ doc: object, partner: object } | null}
 */
export function pickConnectionPartner(me, doc) {
  const meStr = String(me._id);
  const from = doc.from;
  const to = doc.to;
  if (!from || !to) return null;
  const fromId = typeof from === 'object' && from._id ? String(from._id) : String(from);
  const partner = fromId === meStr ? to : from;
  if (!partner || typeof partner !== 'object') return null;
  if (!isDmPartner(me.role, partner.role)) return null;
  return { doc, partner };
}
