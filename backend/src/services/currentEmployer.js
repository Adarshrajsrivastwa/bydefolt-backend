import mongoose from 'mongoose';
import { JobSeekerProfile } from '../models/JobSeekerProfile.js';
import { CompanyEmployerJoinRequest } from '../models/CompanyEmployerJoinRequest.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { User } from '../models/User.js';
import { resolveCompanyUserIdForName } from './workExperienceVerification.js';

async function companyDisplayName(companyUserId) {
  const cid = String(companyUserId || '').trim();
  if (!cid || !mongoose.Types.ObjectId.isValid(cid)) return '';

  const prof = await CompanyProfile.findOne({
    userId: new mongoose.Types.ObjectId(cid),
  })
    .select('companyDisplayName legalRegisteredName')
    .lean();
  if (prof) {
    const n =
      String(prof.companyDisplayName || '').trim() ||
      String(prof.legalRegisteredName || '').trim();
    if (n) return n;
  }
  const u = await User.findById(cid).select('name').lean();
  return String(u?.name || '').trim();
}

/**
 * Companies where the seeker marked a work row as current position.
 * Prefer rows linked to an approved employer-verification request.
 */
export async function listCurrentEmployersForSeeker(seekerId) {
  const seekerOid = new mongoose.Types.ObjectId(seekerId);
  const profile = await JobSeekerProfile.findOne({ userId: seekerOid }).lean();
  const work = Array.isArray(profile?.workExperiences) ? profile.workExperiences : [];

  const approvedRows = await CompanyEmployerJoinRequest.find({
    seekerId: seekerOid,
    status: 'approved',
  })
    .select('companyUserId jobTitle')
    .lean();
  const approvedByCompany = new Map();
  for (const r of approvedRows) {
    const cid = r.companyUserId?.toString?.() || '';
    if (cid) approvedByCompany.set(cid, r);
  }

  const byCompany = new Map();

  for (const w of work) {
    if (!w?.currentPosition) continue;
    const nameFromRow = String(w.company || '').trim();
    if (!nameFromRow) continue;

    let cid = String(w.companyUserId || '').trim();
    if (!cid || !mongoose.Types.ObjectId.isValid(cid)) {
      cid = await resolveCompanyUserIdForName(nameFromRow);
    }
    if (!cid) {
      const key = `name:${nameFromRow.toLowerCase()}`;
      if (!byCompany.has(key)) {
        byCompany.set(key, {
          companyUserId: '',
          companyName: nameFromRow,
          jobTitle: String(w.jobTitle || '').trim(),
          verified: false,
          currentPosition: true,
        });
      }
      continue;
    }

    const approved = approvedByCompany.get(cid);
    const display =
      nameFromRow ||
      (await companyDisplayName(cid)) ||
      'Company';
    byCompany.set(cid, {
      companyUserId: cid,
      companyName: display,
      jobTitle: String(w.jobTitle || approved?.jobTitle || '').trim(),
      verified: Boolean(approved),
      currentPosition: true,
    });
  }

  return [...byCompany.values()].sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.companyName.localeCompare(b.companyName);
  });
}

export async function seekerMayRequestLeaveForCompany(seekerId, companyUserId) {
  const employers = await listCurrentEmployersForSeeker(seekerId);
  const cid = String(companyUserId || '').trim();
  if (!cid) {
    return employers.some((e) => e.currentPosition && e.companyName);
  }
  return employers.some((e) => e.companyUserId === cid);
}
