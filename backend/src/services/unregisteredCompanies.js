import { JobSeekerProfile } from '../models/JobSeekerProfile.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { User } from '../models/User.js';
import { normalizeCompanyName, companyKeysMatch } from './workExperienceVerification.js';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All company account display keys (any status) — names already on the platform. */
async function loadRegisteredCompanyIndex() {
  const companyUsers = await User.find({ role: 'company' })
    .select('_id name companyStatus')
    .lean();
  const companyIds = companyUsers.map((u) => u._id);
  const profiles = companyIds.length
    ? await CompanyProfile.find({ userId: { $in: companyIds } })
        .select('userId companyDisplayName legalRegisteredName')
        .lean()
    : [];

  const profileByUserId = new Map(profiles.map((p) => [p.userId.toString(), p]));
  const registeredUserIds = new Set(companyUsers.map((u) => u._id.toString()));
  const registeredNameKeys = new Set();

  for (const u of companyUsers) {
    const id = u._id.toString();
    const prof = profileByUserId.get(id);
    for (const raw of [
      prof?.companyDisplayName,
      prof?.legalRegisteredName,
      u.name,
    ]) {
      const k = normalizeCompanyName(raw);
      if (k) registeredNameKeys.add(k);
    }
  }

  return { registeredUserIds, registeredNameKeys };
}

function nameMatchesRegistered(companyName, registeredNameKeys) {
  const key = normalizeCompanyName(companyName);
  if (!key) return true;
  if (registeredNameKeys.has(key)) return true;
  for (const rk of registeredNameKeys) {
    if (companyKeysMatch(companyName, rk)) return true;
  }
  return false;
}

/**
 * Company names typed by users (e.g. work experience) that do not match any registered org.
 */
export async function listUnregisteredCompanyNames({ searchQuery = '' } = {}) {
  const { registeredUserIds, registeredNameKeys } = await loadRegisteredCompanyIndex();

  const profiles = await JobSeekerProfile.find({})
    .select('userId workExperiences updatedAt')
    .populate({ path: 'userId', select: 'name email bdId' })
    .lean();

  /** @type {Map<string, { displayName: string, mentionCount: number, userIds: Set<string>, sampleUsers: Array<{name:string,email:string,bdId:string}>, lastSeenAt: Date|null }>} */
  const byKey = new Map();

  for (const sp of profiles) {
    const seeker = sp.userId;
    const seekerId =
      seeker && typeof seeker === 'object' && seeker._id
        ? seeker._id.toString()
        : sp.userId?.toString?.() || '';
    const seekerName =
      seeker && typeof seeker === 'object' ? String(seeker.name || '').trim() : '';
    const seekerEmail =
      seeker && typeof seeker === 'object' ? String(seeker.email || '').trim() : '';
    const seekerBdId =
      seeker && typeof seeker === 'object' ? String(seeker.bdId || '').trim() : '';

    const profileUpdated = sp.updatedAt ? new Date(sp.updatedAt) : null;

    for (const we of sp.workExperiences || []) {
      const company = String(we?.company || '').trim();
      if (!company || company.length < 2) continue;

      const linkedId = String(we?.companyUserId || '').trim();
      if (linkedId && registeredUserIds.has(linkedId)) continue;
      if (nameMatchesRegistered(company, registeredNameKeys)) continue;

      const key = normalizeCompanyName(company);
      if (!key) continue;

      let row = byKey.get(key);
      if (!row) {
        row = {
          displayName: company,
          mentionCount: 0,
          userIds: new Set(),
          sampleUsers: [],
          lastSeenAt: null,
        };
        byKey.set(key, row);
      }

      row.mentionCount += 1;
      if (seekerId) row.userIds.add(seekerId);
      if (profileUpdated && (!row.lastSeenAt || profileUpdated > row.lastSeenAt)) {
        row.lastSeenAt = profileUpdated;
      }
      if (
        seekerName &&
        row.sampleUsers.length < 5 &&
        !row.sampleUsers.some((u) => u.email === seekerEmail && seekerEmail)
      ) {
        row.sampleUsers.push({
          name: seekerName,
          email: seekerEmail,
          bdId: seekerBdId,
        });
      }
    }
  }

  let companies = [...byKey.entries()].map(([normalizedName, row]) => ({
    normalizedName,
    name: row.displayName,
    mentionCount: row.mentionCount,
    userCount: row.userIds.size,
    sources: ['workExperience'],
    lastSeenAt: row.lastSeenAt,
    sampleUsers: row.sampleUsers,
  }));

  const q = String(searchQuery || '').trim();
  if (q.length >= 1) {
    const rx = new RegExp(escapeRegex(q), 'i');
    companies = companies.filter(
      (c) => rx.test(c.name) || rx.test(c.normalizedName)
    );
  }

  companies.sort((a, b) => {
    if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
    return a.name.localeCompare(b.name);
  });

  return companies.slice(0, 500);
}
