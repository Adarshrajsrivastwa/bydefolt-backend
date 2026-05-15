import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { CompanyEmployerJoinRequest } from '../models/CompanyEmployerJoinRequest.js';
import { resolveCompanyUserIdForName } from '../services/workExperienceVerification.js';

const router = Router();

function sendValidationError(res, errors) {
  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Approved companies matching [q] on display name, legal name, or company account name (min 2 chars; case-insensitive). */
router.get(
  '/search',
  requireAuth,
  [query('q').trim().isLength({ min: 2, max: 80 }).withMessage('Query must be 2–80 characters')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const raw = String(req.query.q || '').trim();
    const rx = new RegExp(escapeRegex(raw), 'i');

    const nameHitUsers = await User.find({
      role: 'company',
      companyStatus: 'approved',
      name: rx,
    })
      .select('_id')
      .limit(50)
      .lean();
    const nameHitIds = nameHitUsers.map((u) => u._id);

    const profileOr = [{ companyDisplayName: rx }, { legalRegisteredName: rx }];
    if (nameHitIds.length) profileOr.push({ userId: { $in: nameHitIds } });

    const profiles = await CompanyProfile.find({ $or: profileOr })
      .limit(25)
      .populate({ path: 'userId', select: 'role companyStatus name email' })
      .lean();

    const companies = profiles
      .map((p) => {
        const u = p.userId;
        if (!u || typeof u !== 'object' || !u._id) return null;
        if (u.role !== 'company') return null;
        if (u.companyStatus !== 'approved') return null;
        const display = String(p.companyDisplayName || '').trim() || u.name;
        return {
          companyUserId: u._id.toString(),
          displayName: display,
          legalName: String(p.legalRegisteredName || '').trim(),
          headquarters: String(p.headquarters || '').trim(),
        };
      })
      .filter(Boolean);

    return res.json({ companies });
  }
);

/** Job seeker's employer verification requests (all statuses). */
router.get('/my-employer-requests', requireAuth, async (req, res) => {
  if (req.user.role !== 'jobSeeker') {
    return res.status(403).json({ message: 'Only job seekers can view these requests' });
  }

  const seekerOid = new mongoose.Types.ObjectId(req.user.id);
  const rows = await CompanyEmployerJoinRequest.find({ seekerId: seekerOid })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  const companyIds = [
    ...new Set(
      rows
        .map((r) => r.companyUserId?.toString?.() || '')
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const profiles = companyIds.length
    ? await CompanyProfile.find({ userId: { $in: companyIds } })
        .select('userId companyDisplayName legalRegisteredName')
        .lean()
    : [];
  const users = companyIds.length
    ? await User.find({ _id: { $in: companyIds } }).select('name').lean()
    : [];

  const profileByUser = new Map(profiles.map((p) => [p.userId.toString(), p]));
  const userNameById = new Map(users.map((u) => [u._id.toString(), u.name]));

  const requests = rows.map((r) => {
    const cid = r.companyUserId?.toString?.() || '';
    const prof = profileByUser.get(cid);
    let companyName = '';
    if (prof) {
      companyName =
        String(prof.companyDisplayName || '').trim() ||
        String(prof.legalRegisteredName || '').trim();
    }
    if (!companyName) companyName = String(userNameById.get(cid) || '').trim();

    return {
      id: r._id.toString(),
      status: r.status,
      jobTitle: String(r.jobTitle || '').trim(),
      companyUserId: cid,
      companyName,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
    };
  });

  return res.json({ requests });
});

/** Remove this seeker's verification rows for one company (e.g. work experience company changed). */
router.delete('/my-employer-requests/for-company/:companyUserId', requireAuth, async (req, res) => {
  if (req.user.role !== 'jobSeeker') {
    return res.status(403).json({ message: 'Only job seekers can clear these requests' });
  }

  const companyUserId = String(req.params.companyUserId || '').trim();
  if (!mongoose.Types.ObjectId.isValid(companyUserId)) {
    return res.status(400).json({ message: 'Invalid company id' });
  }

  const seekerOid = new mongoose.Types.ObjectId(req.user.id);
  const companyOid = new mongoose.Types.ObjectId(companyUserId);

  const result = await CompanyEmployerJoinRequest.deleteMany({
    seekerId: seekerOid,
    companyUserId: companyOid,
  });

  return res.json({
    deletedCount: result.deletedCount ?? 0,
  });
});

/** Job seeker asks an approved company to verify their employer (work experience). */
router.post(
  '/employer-requests',
  requireAuth,
  [
    body('companyUserId').optional().isMongoId().withMessage('Invalid company id'),
    body('companyName').optional().isString().trim().isLength({ min: 1, max: 200 }),
    body('jobTitle').optional().isString().trim().isLength({ max: 200 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    if (req.user.role !== 'jobSeeker') {
      return res.status(403).json({ message: 'Only job seekers can submit this request' });
    }

    const seekerOid = new mongoose.Types.ObjectId(req.user.id);
    const rawId = String(req.body.companyUserId || '').trim();
    const rawName = String(req.body.companyName || '').trim();

    let companyOid = null;
    if (rawId && mongoose.Types.ObjectId.isValid(rawId)) {
      companyOid = new mongoose.Types.ObjectId(rawId);
    } else if (rawName) {
      const resolved = await resolveCompanyUserIdForName(rawName);
      if (!resolved) {
        return res.status(404).json({
          message:
            'Company not registered on ByDefolt. HR must register the company, or match the exact registered name.',
        });
      }
      companyOid = new mongoose.Types.ObjectId(resolved);
    } else {
      return res.status(400).json({ message: 'Company id or company name is required' });
    }

    const companyUser = await User.findOne({
      _id: companyOid,
      role: 'company',
      companyStatus: 'approved',
    }).lean();

    if (!companyUser) {
      return res.status(404).json({ message: 'Company not found or not open for requests' });
    }

    const dup = await CompanyEmployerJoinRequest.findOne({
      seekerId: seekerOid,
      companyUserId: companyOid,
      status: 'pending',
    }).lean();

    if (dup) {
      return res.status(409).json({ message: 'You already have a pending request for this company' });
    }

    const doc = await CompanyEmployerJoinRequest.create({
      seekerId: seekerOid,
      companyUserId: companyOid,
      jobTitle: String(req.body.jobTitle || '').trim(),
      status: 'pending',
    });

    return res.status(201).json({
      request: {
        id: doc._id.toString(),
        status: doc.status,
        companyUserId: companyOid.toString(),
      },
    });
  }
);

export { router as companiesRouter };
