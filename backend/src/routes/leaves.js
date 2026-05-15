import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { EmployeeLeaveRequest } from '../models/EmployeeLeaveRequest.js';
import {
  listCurrentEmployersForSeeker,
  seekerMayRequestLeaveForCompany,
} from '../services/currentEmployer.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { sendLeaveDecisionEmail } from '../services/mail.js';

const router = Router();

function sendValidationError(res, errors) {
  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
}

function parseIsoDate(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

async function getCompanyReviewContext(req) {
  const user = await User.findById(req.user.id);
  if (!user) return { ok: false, status: 404, message: 'User not found' };

  if (user.role === 'company') {
    if (user.companyStatus !== 'approved') {
      return { ok: false, status: 403, message: 'Company account is not approved' };
    }
    return { ok: true, companyUserId: user._id, reviewer: user };
  }

  if (user.role === 'recruiter') {
    if (!user.companyId) {
      return { ok: false, status: 403, message: 'Recruiter is not linked to a company' };
    }
    const company = await User.findById(user.companyId);
    if (!company || company.role !== 'company' || company.companyStatus !== 'approved') {
      return { ok: false, status: 403, message: 'Linked company is not available' };
    }
    return { ok: true, companyUserId: company._id, reviewer: user };
  }

  return { ok: false, status: 403, message: 'Not allowed' };
}

function serializeLeave(doc, seeker, companyNameOverride) {
  const s = doc.seekerId && typeof doc.seekerId === 'object' ? doc.seekerId : seeker;
  return {
    id: doc._id.toString(),
    status: doc.status,
    companyUserId: doc.companyUserId?.toString?.() || '',
    companyName: companyNameOverride || doc.companyName || '',
    jobTitle: doc.jobTitle || '',
    startDate: doc.startDate,
    endDate: doc.endDate,
    singleDay: Boolean(doc.singleDay),
    reason: doc.reason || '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    reviewedAt: doc.reviewedAt,
    reviewNote: doc.reviewNote || '',
    seeker: s
      ? {
          id: s._id?.toString?.() || '',
          name: s.name || '',
          email: s.email || '',
          bdId: s.bdId || '',
        }
      : null,
  };
}

router.use(requireAuth);

/** Job seeker: companies where profile has "current position". */
router.get('/current-employers', async (req, res) => {
  if (req.user.role !== 'jobSeeker') {
    return res.status(403).json({ message: 'Only job seekers can view current employers' });
  }
  const employers = await listCurrentEmployersForSeeker(req.user.id);
  return res.json({ employers });
});

/** Job seeker: my leave requests. */
router.get('/my', async (req, res) => {
  if (req.user.role !== 'jobSeeker') {
    return res.status(403).json({ message: 'Only job seekers can view their leave requests' });
  }
  const seekerOid = new mongoose.Types.ObjectId(req.user.id);
  const rows = await EmployeeLeaveRequest.find({ seekerId: seekerOid })
    .sort({ createdAt: -1 })
    .limit(80)
    .lean();
  const requests = rows.map((r) => serializeLeave(r));
  return res.json({ requests });
});

/** Company / HR: leave requests for this company. */
router.get('/for-company', async (req, res) => {
  const ctx = await getCompanyReviewContext(req);
  if (!ctx.ok) return res.status(ctx.status).json({ message: ctx.message });

  const st = String(req.query.status || 'all').toLowerCase();
  const filter = { companyUserId: ctx.companyUserId };
  if (st === 'pending' || st === 'approved' || st === 'rejected' || st === 'cancelled') {
    filter.status = st;
  }

  const rows = await EmployeeLeaveRequest.find(filter)
    .sort({ createdAt: -1 })
    .limit(120)
    .populate('seekerId', 'name email bdId')
    .lean();

  const prof = await CompanyProfile.findOne({ userId: ctx.companyUserId })
    .select('companyDisplayName legalRegisteredName')
    .lean();
  const companyName =
    prof?.companyDisplayName?.trim() || prof?.legalRegisteredName?.trim() || '';

  const requests = rows.map((r) => serializeLeave(r, r.seekerId, companyName));
  return res.json({ requests });
});

router.post(
  '/',
  [
    body('companyUserId').optional().isMongoId().withMessage('Invalid company id'),
    body('companyName').optional().isString().trim().isLength({ max: 200 }),
    body('jobTitle').optional().isString().trim().isLength({ max: 200 }),
    body('startDate').isString().trim().notEmpty().withMessage('Start date is required'),
    body('endDate').isString().trim().notEmpty().withMessage('End date is required'),
    body('singleDay').optional().isBoolean(),
    body('reason').isString().trim().isLength({ min: 3, max: 2000 }).withMessage('Reason is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    if (req.user.role !== 'jobSeeker') {
      return res.status(403).json({ message: 'Only job seekers can apply for leave' });
    }

    const startDate = parseIsoDate(req.body.startDate);
    const endDate = parseIsoDate(req.body.endDate);
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Dates must be YYYY-MM-DD' });
    }
    if (endDate < startDate) {
      return res.status(400).json({ message: 'End date cannot be before start date' });
    }

    const singleDay = Boolean(req.body.singleDay) || startDate === endDate;
    const employers = await listCurrentEmployersForSeeker(req.user.id);
    if (!employers.length) {
      return res.status(400).json({
        message:
          'Add a current job in Profile → Work experience (check "This is my position now") before applying for leave.',
      });
    }

    let companyUserId = String(req.body.companyUserId || '').trim();
    let companyName = String(req.body.companyName || '').trim();
    let jobTitle = String(req.body.jobTitle || '').trim();

    if (companyUserId && mongoose.Types.ObjectId.isValid(companyUserId)) {
      const hit = employers.find((e) => e.companyUserId === companyUserId);
      if (!hit) {
        return res.status(400).json({
          message: 'You can only request leave for a company where you are currently employed.',
        });
      }
      companyName = hit.companyName || companyName;
      jobTitle = jobTitle || hit.jobTitle || '';
    } else {
      const hit = employers.find((e) => e.companyUserId) || employers[0];
      companyUserId = hit.companyUserId;
      companyName = hit.companyName || companyName;
      jobTitle = jobTitle || hit.jobTitle || '';
      if (!companyUserId) {
        return res.status(400).json({
          message:
            'Your current employer must be a registered company on ByDefolt. Ask HR to register, or link the company in work experience.',
        });
      }
    }

    const allowed = await seekerMayRequestLeaveForCompany(req.user.id, companyUserId);
    if (!allowed) {
      return res.status(400).json({ message: 'Not currently employed at this company' });
    }

    const companyOid = new mongoose.Types.ObjectId(companyUserId);
    const companyUser = await User.findOne({
      _id: companyOid,
      role: 'company',
      companyStatus: 'approved',
    }).lean();
    if (!companyUser) {
      return res.status(404).json({ message: 'Company not found or not active' });
    }

    const seekerOid = new mongoose.Types.ObjectId(req.user.id);
    const dup = await EmployeeLeaveRequest.findOne({
      seekerId: seekerOid,
      companyUserId: companyOid,
      status: 'pending',
      startDate,
      endDate,
    }).lean();
    if (dup) {
      return res.status(409).json({ message: 'You already have a pending leave request for these dates' });
    }

    const doc = await EmployeeLeaveRequest.create({
      seekerId: seekerOid,
      companyUserId: companyOid,
      companyName,
      jobTitle,
      startDate,
      endDate: singleDay ? startDate : endDate,
      singleDay,
      reason: String(req.body.reason).trim(),
      status: 'pending',
    });

    return res.status(201).json({
      request: serializeLeave(doc.toObject()),
    });
  }
);

router.delete('/:requestId', async (req, res) => {
  const requestId = req.params.requestId;
  if (!mongoose.Types.ObjectId.isValid(requestId)) {
    return res.status(400).json({ message: 'Invalid request id' });
  }

  const doc = await EmployeeLeaveRequest.findById(requestId);
  if (!doc) return res.status(404).json({ message: 'Leave request not found' });

  if (req.user.role === 'jobSeeker') {
    if (!doc.seekerId.equals(req.user.id)) {
      return res.status(403).json({ message: 'Not your leave request' });
    }
    if (doc.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending requests can be cancelled' });
    }
    doc.status = 'cancelled';
    await doc.save();
    return res.json({ request: serializeLeave(doc.toObject()) });
  }

  return res.status(403).json({ message: 'Not allowed' });
});

router.post(
  '/:requestId/decision',
  [
    param('requestId').isMongoId().withMessage('Invalid request id'),
    body('decision').isIn(['approve', 'reject']).withMessage('decision must be approve or reject'),
    body('note').optional().isString().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const ctx = await getCompanyReviewContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ message: ctx.message });

    const doc = await EmployeeLeaveRequest.findById(req.params.requestId);
    if (!doc || !doc.companyUserId.equals(ctx.companyUserId)) {
      return res.status(404).json({ message: 'Leave request not found' });
    }
    if (doc.status !== 'pending') {
      return res.status(400).json({ message: 'This leave request is no longer pending' });
    }

    const approved = req.body.decision === 'approve';
    doc.status = approved ? 'approved' : 'rejected';
    doc.reviewedBy = ctx.reviewer._id;
    doc.reviewedAt = new Date();
    doc.reviewNote = String(req.body.note || '').trim();
    await doc.save();

    const seeker = await User.findById(doc.seekerId).select('name email').lean();
    const prof = await CompanyProfile.findOne({ userId: doc.companyUserId })
      .select('companyDisplayName legalRegisteredName')
      .lean();
    const companyName =
      doc.companyName?.trim() ||
      prof?.companyDisplayName?.trim() ||
      prof?.legalRegisteredName?.trim() ||
      '';

    if (seeker?.email) {
      try {
        await sendLeaveDecisionEmail({
          to: seeker.email,
          seekerName: seeker.name || '',
          approved,
          companyName,
          jobTitle: doc.jobTitle || '',
          startDate: doc.startDate,
          endDate: doc.endDate,
          singleDay: Boolean(doc.singleDay),
          reason: doc.reason || '',
          reviewNote: doc.reviewNote || '',
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[leaves] leave decision email failed:', err?.message || err);
      }
    }

    const populated = await EmployeeLeaveRequest.findById(doc._id)
      .populate('seekerId', 'name email bdId')
      .lean();

    return res.json({
      request: serializeLeave(populated || doc.toObject(), populated?.seekerId, companyName),
    });
  }
);

export { router as leavesRouter };
