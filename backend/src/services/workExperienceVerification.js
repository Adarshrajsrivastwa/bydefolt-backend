import mongoose from 'mongoose';
import { CompanyEmployerJoinRequest } from '../models/CompanyEmployerJoinRequest.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { User } from '../models/User.js';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trim, collapse spaces, lowercase — matching is never case-sensitive. */
export function normalizeCompanyName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function companyKeysMatch(a, b) {
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.includes(y) || y.includes(x);
}

const STATUS_RANK = { approved: 3, pending: 2, rejected: 1 };

function approvedCompanyFromProfile(profile) {
  const u = profile?.userId;
  if (!u || typeof u !== 'object' || !u._id) return null;
  if (u.role !== 'company' || u.companyStatus !== 'approved') return null;
  return u._id.toString();
}

/**
 * Match an approved company by display / legal / account name (case-insensitive, spacing-insensitive).
 */
export async function resolveCompanyUserIdForName(companyName) {
  const c = String(companyName || '').trim();
  if (!c) return '';

  const key = normalizeCompanyName(c);
  const rxExact = new RegExp(`^${escapeRegex(c)}$`, 'i');

  const nameHitUsers = await User.find({
    role: 'company',
    companyStatus: 'approved',
    name: rxExact,
  })
    .select('_id name')
    .limit(8)
    .lean();

  for (const u of nameHitUsers) {
    if (companyKeysMatch(u.name, c)) return u._id.toString();
  }

  const nameHitIds = nameHitUsers.map((u) => u._id);
  const profileOr = [{ companyDisplayName: rxExact }, { legalRegisteredName: rxExact }];
  if (nameHitIds.length) profileOr.push({ userId: { $in: nameHitIds } });

  let profile = await CompanyProfile.findOne({ $or: profileOr })
    .populate({ path: 'userId', select: 'role companyStatus name' })
    .lean();

  let id = profile ? approvedCompanyFromProfile(profile) : null;
  if (id) return id;

  const rxLoose = new RegExp(escapeRegex(c), 'i');
  const candidates = await CompanyProfile.find({
    $or: [{ companyDisplayName: rxLoose }, { legalRegisteredName: rxLoose }],
  })
    .populate({ path: 'userId', select: 'role companyStatus name' })
    .limit(25)
    .lean();

  for (const p of candidates) {
    const u = p.userId;
    const display = p.companyDisplayName || '';
    const legal = p.legalRegisteredName || '';
    const account = typeof u === 'object' && u ? u.name || '' : '';
    if (
      companyKeysMatch(display, c) ||
      companyKeysMatch(legal, c) ||
      companyKeysMatch(account, c)
    ) {
      id = approvedCompanyFromProfile(p);
      if (id) return id;
    }
  }

  const looseUsers = await User.find({
    role: 'company',
    companyStatus: 'approved',
    name: rxLoose,
  })
    .select('_id name')
    .limit(15)
    .lean();

  for (const u of looseUsers) {
    if (companyKeysMatch(u.name, c)) return u._id.toString();
  }

  return '';
}

function sanitizeCompanyUserId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (!mongoose.Types.ObjectId.isValid(s)) return '';
  return s;
}

/**
 * Attach `verificationStatus` per work row:
 * - verified — company approved the employer request
 * - pending — request awaiting HR / company review
 * - unverified — company on platform, no approval yet
 * - not_registered — company name not linked to an approved company account
 */
export async function enrichWorkExperiencesWithVerification(workExperiences, seekerId) {
  if (!Array.isArray(workExperiences) || workExperiences.length === 0) {
    return [];
  }

  const seekerOid = new mongoose.Types.ObjectId(seekerId);
  const requests = await CompanyEmployerJoinRequest.find({ seekerId: seekerOid })
    .select('companyUserId status')
    .lean();

  const requestByCompany = new Map();
  for (const r of requests) {
    const cid = r.companyUserId?.toString?.() || '';
    if (!cid) continue;
    const prev = requestByCompany.get(cid);
    const prevRank = prev ? STATUS_RANK[prev.status] || 0 : 0;
    const nextRank = STATUS_RANK[r.status] || 0;
    if (!prev || nextRank > prevRank) {
      requestByCompany.set(cid, r);
    }
  }

  const out = [];
  for (const w of workExperiences) {
    let companyUserId = sanitizeCompanyUserId(w.companyUserId);
    if (!companyUserId) {
      companyUserId = await resolveCompanyUserIdForName(w.company);
    }

    let verificationStatus = 'not_registered';
    if (companyUserId) {
      const req = requestByCompany.get(companyUserId);
      if (req?.status === 'approved') {
        verificationStatus = 'verified';
      } else if (req?.status === 'pending') {
        verificationStatus = 'pending';
      } else {
        verificationStatus = 'unverified';
      }
    }

    out.push({
      ...w,
      companyUserId,
      verificationStatus,
    });
  }
  return out;
}

async function companyIdsFromWorkRows(rows) {
  const ids = new Set();
  if (!Array.isArray(rows)) return ids;
  for (const w of rows) {
    let companyUserId = sanitizeCompanyUserId(w.companyUserId);
    if (!companyUserId) {
      companyUserId = await resolveCompanyUserIdForName(w.company);
    }
    if (companyUserId) ids.add(companyUserId);
  }
  return ids;
}

/**
 * When work experience rows are removed or the company changes, drop employer
 * verification requests for companies no longer on the profile.
 */
export async function clearStaleEmployerRequestsForSeeker(seekerId, previousWork, newWork) {
  const prevIds = await companyIdsFromWorkRows(previousWork);
  const newIds = await companyIdsFromWorkRows(newWork);
  const removed = [...prevIds].filter((id) => !newIds.has(id));
  if (!removed.length) return 0;

  const seekerOid = new mongoose.Types.ObjectId(seekerId);
  const result = await CompanyEmployerJoinRequest.deleteMany({
    seekerId: seekerOid,
    companyUserId: { $in: removed.map((id) => new mongoose.Types.ObjectId(id)) },
  });
  return result.deletedCount ?? 0;
}

/**
 * Ensure a pending employer-verification row exists for each work experience
 * tied to a registered company (so HR queue matches profile "pending" state).
 */
export async function syncEmployerJoinRequestsForSeeker(seekerId, workRows) {
  if (!Array.isArray(workRows) || !workRows.length) return;

  const seekerOid = new mongoose.Types.ObjectId(seekerId);

  for (const w of workRows) {
    const company = String(w.company || '').trim();
    if (!company) continue;

    let companyUserId = sanitizeCompanyUserId(w.companyUserId);
    if (!companyUserId) {
      companyUserId = await resolveCompanyUserIdForName(company);
    }
    if (!companyUserId || !mongoose.Types.ObjectId.isValid(companyUserId)) continue;

    const companyOid = new mongoose.Types.ObjectId(companyUserId);
    const companyUser = await User.findOne({
      _id: companyOid,
      role: 'company',
      companyStatus: 'approved',
    }).lean();
    if (!companyUser) continue;

    const pendingDup = await CompanyEmployerJoinRequest.findOne({
      seekerId: seekerOid,
      companyUserId: companyOid,
      status: 'pending',
    }).lean();
    if (pendingDup) continue;

    const approved = await CompanyEmployerJoinRequest.findOne({
      seekerId: seekerOid,
      companyUserId: companyOid,
      status: 'approved',
    }).lean();
    if (approved) continue;

    try {
      await CompanyEmployerJoinRequest.create({
        seekerId: seekerOid,
        companyUserId: companyOid,
        jobTitle: String(w.jobTitle || '').trim(),
        status: 'pending',
      });
    } catch {
      // duplicate pending — ignore
    }
  }
}
