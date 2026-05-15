import mongoose from 'mongoose';
import { JobSeekerProfile } from '../models/JobSeekerProfile.js';
import { CompanyEmployerJoinRequest } from '../models/CompanyEmployerJoinRequest.js';
import { User } from '../models/User.js';
import { resolveCompanyUserIdForName } from './workExperienceVerification.js';

/**
 * All people linked to this company: approved employer verification and/or
 * current-position work experience on their profile.
 */
export async function listCompanyEmployees(companyUserId) {
  const companyOid = new mongoose.Types.ObjectId(companyUserId);
  const bySeeker = new Map();

  const approvedRows = await CompanyEmployerJoinRequest.find({
    companyUserId: companyOid,
    status: 'approved',
  })
    .select('seekerId jobTitle')
    .lean();

  for (const r of approvedRows) {
    const sid = r.seekerId?.toString?.() || '';
    if (!sid) continue;
    bySeeker.set(sid, {
      seekerId: sid,
      name: '',
      email: '',
      bdId: '',
      jobTitle: String(r.jobTitle || '').trim(),
      profilePhotoUrl: '',
      verified: true,
      currentPosition: false,
    });
  }

  const profiles = await JobSeekerProfile.find({
    workExperiences: { $elemMatch: { currentPosition: true } },
  })
    .select('userId workExperiences profilePhotoUrl')
    .lean();

  for (const p of profiles) {
    const sid = p.userId?.toString?.() || '';
    if (!sid) continue;
    const work = Array.isArray(p.workExperiences) ? p.workExperiences : [];
    let hitTitle = '';
    for (const w of work) {
      if (!w?.currentPosition) continue;
      let cid = String(w.companyUserId || '').trim();
      if (!cid || !mongoose.Types.ObjectId.isValid(cid)) {
        cid = await resolveCompanyUserIdForName(w.company);
      }
      if (cid !== companyUserId) continue;
      hitTitle = String(w.jobTitle || '').trim() || hitTitle;
    }
    if (!hitTitle && !bySeeker.has(sid)) continue;

    const photo = String(p.profilePhotoUrl || '').trim();
    const existing = bySeeker.get(sid);
    if (existing) {
      existing.currentPosition = true;
      if (!existing.jobTitle && hitTitle) existing.jobTitle = hitTitle;
      if (!existing.profilePhotoUrl && photo) existing.profilePhotoUrl = photo;
    } else {
      bySeeker.set(sid, {
        seekerId: sid,
        name: '',
        email: '',
        bdId: '',
        jobTitle: hitTitle,
        profilePhotoUrl: photo,
        verified: false,
        currentPosition: true,
      });
    }
  }

  const ids = [...bySeeker.keys()].map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return [];

  const users = await User.find({ _id: { $in: ids } })
    .select('name email bdId')
    .lean();
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  const missingPhotoIds = ids.filter((oid) => {
    const row = bySeeker.get(oid.toString());
    return row && !row.profilePhotoUrl;
  });
  if (missingPhotoIds.length) {
    const extraProfiles = await JobSeekerProfile.find({ userId: { $in: missingPhotoIds } })
      .select('userId profilePhotoUrl')
      .lean();
    for (const p of extraProfiles) {
      const sid = p.userId?.toString?.() || '';
      const row = bySeeker.get(sid);
      if (row && !row.profilePhotoUrl) {
        row.profilePhotoUrl = String(p.profilePhotoUrl || '').trim();
      }
    }
  }

  const out = [];
  for (const [sid, row] of bySeeker) {
    const u = userById.get(sid);
    if (!u) continue;
    out.push({
      seekerId: sid,
      name: String(u.name || '').trim(),
      email: String(u.email || '').trim(),
      bdId: String(u.bdId || '').trim(),
      jobTitle: row.jobTitle || '',
      profilePhotoUrl: row.profilePhotoUrl || '',
      verified: Boolean(row.verified),
      currentPosition: Boolean(row.currentPosition),
    });
  }

  out.sort((a, b) => {
    const na = (a.name || a.email || a.bdId || '').toLowerCase();
    const nb = (b.name || b.email || b.bdId || '').toLowerCase();
    return na.localeCompare(nb);
  });

  return out;
}

/**
 * Same roster as [listCompanyEmployees]: anyone not yet verified gets a
 * pending employer-verification row so the HR queue matches "All employees".
 */
export async function ensurePendingJoinRequestsFromRoster(companyUserId) {
  const employees = await listCompanyEmployees(companyUserId);
  const companyOid = new mongoose.Types.ObjectId(companyUserId);

  for (const emp of employees) {
    if (emp.verified) continue;

    const seekerOid = new mongoose.Types.ObjectId(emp.seekerId);
    const approved = await CompanyEmployerJoinRequest.findOne({
      seekerId: seekerOid,
      companyUserId: companyOid,
      status: 'approved',
    }).lean();
    if (approved) continue;

    const pending = await CompanyEmployerJoinRequest.findOne({
      seekerId: seekerOid,
      companyUserId: companyOid,
      status: 'pending',
    }).lean();
    if (pending) continue;

    try {
      await CompanyEmployerJoinRequest.create({
        seekerId: seekerOid,
        companyUserId: companyOid,
        jobTitle: String(emp.jobTitle || '').trim(),
        status: 'pending',
      });
    } catch {
      // duplicate pending — ignore
    }
  }
}
