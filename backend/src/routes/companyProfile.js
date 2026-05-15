import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { User } from '../models/User.js';
import { CompanyEmployerJoinRequest } from '../models/CompanyEmployerJoinRequest.js';
import { UserNotification } from '../models/UserNotification.js';
import { ensureBdId } from '../services/bdId.js';
import {
  ensurePendingJoinRequestsFromRoster,
  listCompanyEmployees,
} from '../services/companyEmployees.js';
import {
  countCompanyNoticeRecipients,
  resolveCompanyNoticeRecipientIds,
} from '../services/companyNoticeRecipients.js';

const router = Router();

const noticeUploadDir = path.join(process.cwd(), 'uploads', 'notices');
fs.mkdirSync(noticeUploadDir, { recursive: true });

function isAllowedNoticeImage(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  const name = String(file.originalname || '').toLowerCase();
  if (/^image\/(jpeg|jpg|pjpeg|png|x-png|webp|gif)$/i.test(mime)) return true;
  if (mime === 'application/octet-stream' && /\.(jpe?g|png|webp|gif)$/i.test(name)) {
    return true;
  }
  return false;
}

const noticeUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, noticeUploadDir),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'img').replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(isAllowedNoticeImage(file) ? null : new Error('Only JPEG, PNG, WebP, or GIF images are allowed'), isAllowedNoticeImage(file));
  },
});

function mapProfile(doc) {
  return {
    companyDisplayName: doc.companyDisplayName || '',
    legalRegisteredName: doc.legalRegisteredName || '',
    industry: doc.industry || '',
    website: doc.website || '',
    headquarters: doc.headquarters || '',
    companyAddress: doc.companyAddress || '',
    companyPhone: doc.companyPhone || '',
    companyEmailContact: doc.companyEmailContact || '',
    about: doc.about || '',
  };
}

async function ensureCompanyProfile(userId) {
  let profile = await CompanyProfile.findOne({ userId });
  if (!profile) {
    profile = await CompanyProfile.create({ userId });
  }
  return profile;
}

function companyGateMessage(status) {
  if (status === 'suspended') return 'Company account has been suspended. Contact platform support.';
  if (status === 'rejected') return 'Company registration was rejected.';
  return 'Company account pending approval. Please wait for admin approval.';
}

async function assertApprovedCompany(req, res) {
  const user = await User.findById(req.user.id);
  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return null;
  }
  if (user.role !== 'company') {
    res.status(403).json({ message: 'Only company accounts can manage HR' });
    return null;
  }
  if (user.companyStatus !== 'approved') {
    res.status(403).json({ message: companyGateMessage(user.companyStatus) });
    return null;
  }
  return user;
}

function mapRecruiterRow(doc, bdIdStr) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    bdId: bdIdStr,
    role: doc.role,
  };
}

router.use(requireAuth);

router.get('/me', async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  if (user.role !== 'company') {
    return res.status(403).json({ message: 'Company profile is only available for company accounts' });
  }
  const profile = await ensureCompanyProfile(user._id);
  return res.json({ profile: mapProfile(profile) });
});

router.put(
  '/me',
  [
    body('companyDisplayName').optional().isString().trim().isLength({ max: 120 }),
    body('legalRegisteredName').optional().isString().trim().isLength({ max: 180 }),
    body('industry').optional().isString().trim().isLength({ max: 120 }),
    body('website').optional({ values: 'falsy' }).isURL().withMessage('Website must be a valid URL'),
    body('headquarters').optional().isString().trim().isLength({ max: 180 }),
    body('companyAddress').optional().isString().trim().isLength({ max: 250 }),
    body('companyPhone').optional().isString().trim().isLength({ max: 30 }),
    body('companyEmailContact').optional({ values: 'falsy' }).isEmail(),
    body('about').optional().isString().trim().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (user.role !== 'company') {
      return res.status(403).json({ message: 'Company profile is only available for company accounts' });
    }

    const profile = await ensureCompanyProfile(user._id);
    const fields = [
      'companyDisplayName',
      'legalRegisteredName',
      'industry',
      'website',
      'headquarters',
      'companyAddress',
      'companyPhone',
      'companyEmailContact',
      'about',
    ];
    for (const key of fields) {
      if (Object.hasOwn(req.body, key)) {
        profile[key] = req.body[key] ?? '';
      }
    }
    await profile.save();
    return res.json({ profile: mapProfile(profile) });
  }
);

/** Linked recruiters (HR) for this company — backed by [User.companyId]. */
router.get('/recruiters', async (req, res) => {
  const company = await assertApprovedCompany(req, res);
  if (!company) return;

  const rows = await User.find({ companyId: company._id, role: 'recruiter' })
    .select('name email phone role bdId')
    .sort({ updatedAt: -1 });

  const recruiters = [];
  for (const doc of rows) {
    const bd = await ensureBdId(doc);
    recruiters.push(mapRecruiterRow(doc, bd));
  }
  return res.json({ recruiters });
});

/** Look up a user by BD ID before appointing as company HR (recruiter seat). */
router.post(
  '/recruiters/lookup',
  [body('bdId').trim().notEmpty().withMessage('BD ID is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
    }
    const company = await assertApprovedCompany(req, res);
    if (!company) return;

    const raw = String(req.body.bdId || '').trim().toUpperCase();
    const target = await User.findOne({ bdId: raw });
    if (!target) {
      return res.json({
        found: false,
        appointable: false,
        user: null,
        message: 'No user with this BD ID.',
      });
    }

    const bd = await ensureBdId(target);
    const userJson = mapRecruiterRow(target, bd);
    const companyOid = company._id.toString();

    if (target._id.equals(company._id)) {
      return res.json({
        found: true,
        appointable: false,
        user: userJson,
        message: 'You cannot appoint your own company account.',
      });
    }
    if (target.role === 'owner') {
      return res.json({
        found: true,
        appointable: false,
        user: userJson,
        message: 'This account cannot be assigned as HR.',
      });
    }
    if (target.role === 'company') {
      return res.json({
        found: true,
        appointable: false,
        user: userJson,
        message: 'Company accounts cannot be appointed as HR.',
      });
    }
    if (target.role === 'recruiter') {
      const cid = target.companyId ? String(target.companyId) : '';
      if (cid && cid !== companyOid) {
        return res.json({
          found: true,
          appointable: false,
          user: userJson,
          message: 'This recruiter is already linked to another company.',
        });
      }
      if (cid === companyOid) {
        return res.json({
          found: true,
          appointable: false,
          user: userJson,
          message: 'This user is already HR for your company.',
        });
      }
      return res.json({ found: true, appointable: true, user: userJson, message: '' });
    }
    if (target.role === 'jobSeeker') {
      return res.json({ found: true, appointable: true, user: userJson, message: '' });
    }
    return res.json({
      found: true,
      appointable: false,
      user: userJson,
      message: 'This account cannot be appointed as HR.',
    });
  }
);

/** Promote / link user as recruiter under the authenticated company. */
router.post(
  '/recruiters/appoint',
  [body('bdId').trim().notEmpty().withMessage('BD ID is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
    }
    const company = await assertApprovedCompany(req, res);
    if (!company) return;

    const raw = String(req.body.bdId || '').trim().toUpperCase();
    const target = await User.findOne({ bdId: raw });
    if (!target) {
      return res.status(404).json({ message: 'No user with this BD ID.' });
    }

    const companyOid = company._id.toString();

    if (target._id.equals(company._id)) {
      return res.status(400).json({ message: 'You cannot appoint your own company account.' });
    }
    if (target.role === 'owner' || target.role === 'company') {
      return res.status(400).json({ message: 'This account cannot be appointed as HR.' });
    }

    if (target.role === 'recruiter') {
      const cid = target.companyId ? String(target.companyId) : '';
      if (cid && cid !== companyOid) {
        return res.status(409).json({ message: 'This recruiter is already linked to another company.' });
      }
      if (cid === companyOid) {
        const bd = await ensureBdId(target);
        return res.json({ recruiter: mapRecruiterRow(target, bd), alreadyLinked: true });
      }
      target.companyId = company._id;
      await target.save();
      const bd = await ensureBdId(target);
      return res.json({ recruiter: mapRecruiterRow(target, bd), alreadyLinked: false });
    }

    if (target.role === 'jobSeeker') {
      target.role = 'recruiter';
      target.companyId = company._id;
      await target.save();
      const bd = await ensureBdId(target);
      return res.json({ recruiter: mapRecruiterRow(target, bd), alreadyLinked: false });
    }

    return res.status(400).json({ message: 'This account cannot be appointed as HR.' });
  }
);

/** Demote linked recruiter back to job seeker (removes company HR seat). */
router.delete(
  '/recruiters/:recruiterId',
  [param('recruiterId').isMongoId().withMessage('Invalid recruiter id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
    }
    const company = await assertApprovedCompany(req, res);
    if (!company) return;

    const target = await User.findOne({
      _id: req.params.recruiterId,
      role: 'recruiter',
      companyId: company._id,
    });
    if (!target) {
      return res.status(404).json({ message: 'HR user not found for your company.' });
    }

    target.role = 'jobSeeker';
    target.companyId = null;
    await target.save();

    const bd = await ensureBdId(target);
    return res.json({
      message: 'HR removed. User is now a job seeker.',
      user: mapRecruiterRow(target, bd),
    });
  }
);

async function getEmployerReviewContext(req) {
  const user = await User.findById(req.user.id);
  if (!user) {
    return { ok: false, status: 404, message: 'User not found' };
  }
  if (user.role === 'company') {
    if (user.companyStatus !== 'approved') {
      return { ok: false, status: 403, message: companyGateMessage(user.companyStatus) };
    }
    return { ok: true, companyUserId: user._id, reviewer: user };
  }
  if (user.role === 'recruiter') {
    if (!user.companyId) {
      return { ok: false, status: 403, message: 'Recruiter is not linked to a company' };
    }
    const company = await User.findById(user.companyId);
    if (!company || company.role !== 'company') {
      return { ok: false, status: 403, message: 'Invalid company link' };
    }
    if (company.companyStatus !== 'approved') {
      return { ok: false, status: 403, message: companyGateMessage(company.companyStatus) };
    }
    return { ok: true, companyUserId: company._id, reviewer: user };
  }
  return {
    ok: false,
    status: 403,
    message: 'Only company accounts or company HR can manage employer verification requests',
  };
}

async function mapEmployerRequestRow(row, companyName = '') {
  const populated = row.seekerId;
  let seeker = null;
  if (populated && typeof populated === 'object' && populated._id) {
    seeker = {
      id: populated._id.toString(),
      name: populated.name || '',
      email: populated.email || '',
      phone: populated.phone || '',
      bdId: populated.bdId ? String(populated.bdId).trim() : '',
    };
  } else {
    const sid = row.seekerId?._id ?? row.seekerId;
    if (sid) {
      const u = await User.findById(sid).select('name email phone bdId').lean();
      if (u) {
        seeker = {
          id: u._id.toString(),
          name: u.name || '',
          email: u.email || '',
          phone: u.phone || '',
          bdId: u.bdId ? String(u.bdId).trim() : '',
        };
      }
    }
  }
  return {
    id: row._id.toString(),
    status: row.status,
    jobTitle: row.jobTitle || '',
    companyName: String(companyName || '').trim(),
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    seeker,
  };
}

/** Incoming employer-verification requests for this company (company user or linked recruiter). */
router.get('/employer-requests', requireAuth, async (req, res) => {
  const ctx = await getEmployerReviewContext(req);
  if (!ctx.ok) {
    return res.status(ctx.status).json({ message: ctx.message });
  }

  const st = String(req.query.status || 'all').toLowerCase();

  if (st === 'all' || st === 'pending') {
    await ensurePendingJoinRequestsFromRoster(ctx.companyUserId.toString());
  }

  const filter = { companyUserId: ctx.companyUserId };
  if (st === 'pending' || st === 'approved' || st === 'rejected') {
    filter.status = st;
  }

  const rows = await CompanyEmployerJoinRequest.find(filter)
    .sort({ createdAt: -1 })
    .limit(120)
    .populate({ path: 'seekerId', select: 'name email phone bdId' })
    .lean();

  const companyProfile = await CompanyProfile.findOne({ userId: ctx.companyUserId })
    .select('companyDisplayName legalRegisteredName')
    .lean();
  const companyName =
    companyProfile?.companyDisplayName?.trim() ||
    companyProfile?.legalRegisteredName?.trim() ||
    '';

  const requests = [];
  for (const row of rows) {
    requests.push(await mapEmployerRequestRow(row, companyName));
  }
  return res.json({ requests });
});

/** Company / HR: roster — name, job title (post), profile photo. */
router.get('/employees', requireAuth, async (req, res) => {
  const ctx = await getEmployerReviewContext(req);
  if (!ctx.ok) {
    return res.status(ctx.status).json({ message: ctx.message });
  }

  await ensurePendingJoinRequestsFromRoster(ctx.companyUserId.toString());
  const employees = await listCompanyEmployees(ctx.companyUserId.toString());
  return res.json({ employees, count: employees.length });
});

/** How many users will receive a notice for this audience (company / HR). */
router.get(
  '/notices/recipient-count',
  requireAuth,
  [query('audience').isIn(['all', 'hr', 'employee']).withMessage('Invalid audience')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
    }
    const ctx = await getEmployerReviewContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ message: ctx.message });

    const audience = String(req.query.audience).toLowerCase();
    const count = await countCompanyNoticeRecipients(ctx.companyUserId.toString(), audience);
    return res.json({ count, audience });
  }
);

/** Send in-app notice to company-linked HR and/or employees. */
router.post(
  '/notices',
  requireAuth,
  (req, res, next) => {
    noticeUpload.single('image')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || 'Invalid upload' });
      }
      next();
    });
  },
  [
    body('title').isString().trim().isLength({ min: 1, max: 200 }),
    body('body').isString().trim().isLength({ min: 1, max: 4000 }),
    body('audience').isIn(['all', 'hr', 'employee']).withMessage('Invalid audience'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
    }

    const ctx = await getEmployerReviewContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ message: ctx.message });

    const audience = String(req.body.audience).toLowerCase();
    const companyUserId = ctx.companyUserId.toString();
    const recipientIds = await resolveCompanyNoticeRecipientIds(companyUserId, audience);

    if (!recipientIds.length) {
      return res.status(400).json({
        message:
          audience === 'hr'
            ? 'No HR recruiters linked to your company. Appoint HR first.'
            : audience === 'employee'
              ? 'No employees linked to your company yet.'
              : 'No HR or employees linked to your company yet.',
      });
    }

    let imageUrl = '';
    if (req.file?.filename) {
      imageUrl = `/uploads/notices/${req.file.filename}`;
    }

    const title = String(req.body.title).trim();
    const bodyText = String(req.body.body).trim();
    const companyOid = ctx.companyUserId;
    const sentBy = ctx.reviewer._id;

    const docs = recipientIds.map((rid) => ({
      recipientId: rid,
      companyUserId: companyOid,
      sentBy,
      audience,
      title,
      body: bodyText,
      imageUrl,
    }));

    await UserNotification.insertMany(docs, { ordered: false });

    return res.status(201).json({
      sentCount: recipientIds.length,
      audience,
      title,
    });
  }
);

router.post(
  '/employer-requests/:requestId/decision',
  requireAuth,
  [
    param('requestId').isMongoId().withMessage('Invalid request id'),
    body('decision').isIn(['approve', 'reject']).withMessage('decision must be approve or reject'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
    }

    const ctx = await getEmployerReviewContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({ message: ctx.message });
    }

    const doc = await CompanyEmployerJoinRequest.findById(req.params.requestId);
    if (!doc || !doc.companyUserId.equals(ctx.companyUserId)) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (doc.status !== 'pending') {
      return res.status(400).json({ message: 'This request is no longer pending' });
    }

    doc.status = req.body.decision === 'approve' ? 'approved' : 'rejected';
    doc.reviewedBy = ctx.reviewer._id;
    doc.reviewedAt = new Date();
    await doc.save();

    return res.json({
      request: {
        id: doc._id.toString(),
        status: doc.status,
      },
    });
  }
);

export { router as companyProfileRouter };
