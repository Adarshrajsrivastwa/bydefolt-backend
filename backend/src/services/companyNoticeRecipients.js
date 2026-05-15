import mongoose from 'mongoose';
import { User } from '../models/User.js';
import {
  ensurePendingJoinRequestsFromRoster,
  listCompanyEmployees,
} from './companyEmployees.js';

/**
 * Resolve user ids that should receive a company notice.
 * - employee: roster (current job + verified employees)
 * - hr: recruiters linked via User.companyId
 * - all: union of both
 */
export async function resolveCompanyNoticeRecipientIds(companyUserId, audience) {
  const aud = String(audience || 'all').toLowerCase();
  if (!['all', 'hr', 'employee'].includes(aud)) return [];

  const companyOid = new mongoose.Types.ObjectId(companyUserId);
  const ids = new Set();

  if (aud === 'hr' || aud === 'all') {
    const recruiters = await User.find({
      companyId: companyOid,
      role: 'recruiter',
    })
      .select('_id')
      .lean();
    for (const r of recruiters) {
      ids.add(r._id.toString());
    }
  }

  if (aud === 'employee' || aud === 'all') {
    await ensurePendingJoinRequestsFromRoster(companyUserId);
    const employees = await listCompanyEmployees(companyUserId);
    for (const e of employees) {
      if (e.seekerId) ids.add(e.seekerId);
    }
  }

  return [...ids];
}

export async function countCompanyNoticeRecipients(companyUserId, audience) {
  const ids = await resolveCompanyNoticeRecipientIds(companyUserId, audience);
  return ids.length;
}
