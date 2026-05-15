import mongoose from 'mongoose';
import { CompanyEmployerJoinRequest } from '../models/CompanyEmployerJoinRequest.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { User } from '../models/User.js';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STATUS_RANK = { approved: 3, pending: 2, rejected: 1 };

/**
 * Match an approved company account by display / legal / account name (exact, case-insensitive).
 */
export async function resolveCompanyUserIdForName(companyName) {
  const c = String(companyName || '').trim();
  if (!c) return '';

  const rx = new RegExp(`^${escapeRegex(c)}$`, 'i');

  const nameHitUsers = await User.find({
    role: 'company',
    companyStatus: 'approved',
    name: rx,
  })
    .select('_id')
    .limit(8)
    .lean();
  const nameHitIds = nameHitUsers.map((u) => u._id);

  const profileOr = [{ companyDisplayName: rx }, { legalRegisteredName: rx }];
  if (nameHitIds.length) profileOr.push({ userId: { $in: nameHitIds } });

  const profile = await CompanyProfile.findOne({ $or: profileOr })
    .populate({ path: 'userId', select: 'role companyStatus' })
    .lean();

  const u = profile?.userId;
  if (!u || typeof u !== 'object' || !u._id) return '';
  if (u.role !== 'company' || u.companyStatus !== 'approved') return '';
  return u._id.toString();
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
