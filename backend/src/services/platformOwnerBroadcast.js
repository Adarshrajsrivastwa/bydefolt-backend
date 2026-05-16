import mongoose from 'mongoose';
import { User } from '../models/User.js';
import {
  ensurePendingJoinRequestsFromRoster,
  listCompanyEmployees,
} from './companyEmployees.js';
import { resolveCompanyNoticeRecipientIds } from './companyNoticeRecipients.js';

/** Allowed [scope] values for [GET/POST /api/admin/broadcast*]. */
export const ownerBroadcastScopes = [
  'everyone',
  'all_hr',
  'all_employees',
  'company_all',
  'company_hr',
  'company_employees',
];

/**
 * Resolve distinct recipient user ids for an owner broadcast.
 * @param {string} scope — one of [ownerBroadcastScopes]
 * @param {string} [companyUserId] — required when scope starts with `company_`
 */
export async function resolveOwnerBroadcastRecipients(scope, companyUserId = '') {
  const s = String(scope || '').toLowerCase();
  if (!ownerBroadcastScopes.includes(s)) return [];

  if (s === 'everyone') {
    const rows = await User.find({
      role: { $in: ['jobSeeker', 'recruiter', 'company'] },
    })
      .select('_id')
      .lean();
    return [...new Set(rows.map((u) => u._id.toString()))];
  }

  if (s === 'all_hr') {
    const rows = await User.find({ role: 'recruiter' }).select('_id').lean();
    return [...new Set(rows.map((u) => u._id.toString()))];
  }

  if (s === 'all_employees') {
    const companies = await User.find({
      role: 'company',
      companyStatus: 'approved',
    })
      .select('_id')
      .lean();
    const set = new Set();
    for (const c of companies) {
      const cid = c._id.toString();
      await ensurePendingJoinRequestsFromRoster(cid);
      const employees = await listCompanyEmployees(cid);
      for (const e of employees) {
        if (e.seekerId) set.add(String(e.seekerId));
      }
    }
    return [...set];
  }

  const cid = String(companyUserId || '').trim();
  if (!cid || !mongoose.Types.ObjectId.isValid(cid)) {
    return [];
  }

  const company = await User.findOne({
    _id: cid,
    role: 'company',
    companyStatus: 'approved',
  })
    .select('_id')
    .lean();
  if (!company) return [];

  const companyOid = company._id.toString();

  if (s === 'company_all') {
    return resolveCompanyNoticeRecipientIds(companyOid, 'all');
  }
  if (s === 'company_hr') {
    return resolveCompanyNoticeRecipientIds(companyOid, 'hr');
  }
  if (s === 'company_employees') {
    return resolveCompanyNoticeRecipientIds(companyOid, 'employee');
  }

  return [];
}
