import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from '../middleware/auth.js';
import { User, accountStatuses } from '../models/User.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { sendCompanyApprovedEmail, sendCompanyRejectedEmail } from '../services/mail.js';
import { ensureBdId, generateUniqueBdId } from '../services/bdId.js';
import { deleteJobSeekerUserCascade } from '../services/deleteJobSeekerUserCascade.js';
import { JobPost } from '../models/JobPost.js';
import { JobApplication } from '../models/JobApplication.js';
import multer from 'multer';
import { UserNotification } from '../models/UserNotification.js';
import {
  ownerBroadcastScopes,
  resolveOwnerBroadcastRecipients,
} from '../services/platformOwnerBroadcast.js';
import { deleteJobPostCascade } from '../services/deleteJobPostCascade.js';

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
    cb(
      isAllowedNoticeImage(file) ? null : new Error('Only JPEG, PNG, WebP, or GIF images are allowed'),
      isAllowedNoticeImage(file)
    );
  },
});

const router = Router();

function sendValidationError(res, errors) {
  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
}
function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ message: 'Only owner can access this resource' });
  }
  next();
}

function mapCompanyRow(user, profile) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone,
    bdId: user.bdId,
    role: user.role,
    companyStatus: user.companyStatus,
    createdAt: user.createdAt,
    profile: profile
      ? {
          companyDisplayName: profile.companyDisplayName || '',
          legalRegisteredName: profile.legalRegisteredName || '',
          industry: profile.industry || '',
          website: profile.website || '',
          headquarters: profile.headquarters || '',
          companyAddress: profile.companyAddress || '',
          companyPhone: profile.companyPhone || '',
          companyEmailContact: profile.companyEmailContact || '',
          about: profile.about || '',
          verificationPdf: profile.verificationPdf
            ? {
                originalName: profile.verificationPdf.originalName || '',
                mimeType: profile.verificationPdf.mimeType || '',
                sizeBytes: profile.verificationPdf.sizeBytes || 0,
                storedPath: profile.verificationPdf.storedPath || '',
                uploadedAt: profile.verificationPdf.uploadedAt || null,
              }
            : null,
        }
      : null,
  };
}

function mapPlatformAdminRow(doc) {
  const o = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: o._id.toString(),
    name: o.name,
    email: o.email,
    phone: o.phone,
    bdId: o.bdId || '',
    accountStatus: o.accountStatus || 'active',
    createdAt: o.createdAt,
  };
}

router.use(requireAuth, requireOwner);

/** Company accounts awaiting review: explicit pending, or legacy docs missing companyStatus. */
const pendingCompanyQuery = {
  role: 'company',
  $or: [
    { companyStatus: 'pending' },
    { companyStatus: { $exists: false } },
    { companyStatus: null },
  ],
};

/** Aggregated counts for owner dashboard “Platform overview” (MongoDB). */
router.get('/platform-overview', async (_req, res) => {
  const [
    registeredOrgs,
    companiesApproved,
    companiesPendingReview,
    companiesSuspended,
    hrSeats,
    professionalProfiles,
    jobListings,
    jobApplications,
  ] = await Promise.all([
    User.countDocuments({ role: 'company' }),
    User.countDocuments({ role: 'company', companyStatus: 'approved' }),
    User.countDocuments(pendingCompanyQuery),
    User.countDocuments({ role: 'company', companyStatus: 'suspended' }),
    User.countDocuments({ role: 'recruiter' }),
    User.countDocuments({ role: 'jobSeeker' }),
    JobPost.countDocuments({}),
    JobApplication.countDocuments({}),
  ]);
  return res.json({
    registeredOrgs,
    companiesApproved,
    companiesPendingReview,
    companiesSuspended,
    hrSeats,
    professionalProfiles,
    jobListings,
    jobApplications,
    /** Owner-action queue: companies awaiting approval (same filter as GET /companies/pending). */
    moderationQueue: companiesPendingReview,
  });
});

router.get('/platform-admins', async (_req, res) => {
  const admins = await User.find({ role: 'owner' })
    .select('name email phone bdId accountStatus createdAt')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  return res.json({
    admins: admins.map((a) => ({
      id: a._id.toString(),
      name: a.name,
      email: a.email,
      phone: a.phone,
      bdId: a.bdId || '',
      accountStatus: a.accountStatus || 'active',
      createdAt: a.createdAt,
    })),
  });
});

router.post(
  '/platform-admins',
  [
    body('name').trim().notEmpty().isLength({ max: 120 }),
    body('email').isEmail().normalizeEmail(),
    body('phone').trim().matches(/^\d{10}$/).withMessage('Phone must be 10 digits'),
    body('password').isString().isLength({ min: 6, max: 128 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const email = String(req.body.email || '').toLowerCase().trim();
    const phone = String(req.body.phone || '').trim();
    if (await User.exists({ email })) {
      return res.status(409).json({ message: 'Email already registered' });
    }
    if (await User.exists({ phone })) {
      return res.status(409).json({ message: 'Phone already registered' });
    }
    const bdId = await generateUniqueBdId(req.body.name, phone);
    const doc = await User.create({
      name: String(req.body.name).trim(),
      email,
      phone,
      password: req.body.password,
      role: 'owner',
      companyStatus: 'approved',
      accountStatus: 'active',
      bdId,
    });
    return res.status(201).json({ admin: mapPlatformAdminRow(doc) });
  }
);

router.patch(
  '/platform-admins/:adminId',
  [
    param('adminId').custom((v) => mongoose.Types.ObjectId.isValid(v)),
    body('name').optional().trim().notEmpty().isLength({ max: 120 }),
    body('phone').optional().trim().matches(/^\d{10}$/),
    body('accountStatus').optional().isIn(accountStatuses),
    body('password').optional().isString().isLength({ min: 6, max: 128 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const user = await User.findOne({ _id: req.params.adminId, role: 'owner' });
    if (!user) return res.status(404).json({ message: 'Admin not found' });
    if (Object.hasOwn(req.body, 'phone')) {
      const nextPhone = String(req.body.phone).trim();
      const taken = await User.findOne({
        phone: nextPhone,
        _id: { $ne: user._id },
      });
      if (taken) return res.status(409).json({ message: 'Phone already in use' });
      user.phone = nextPhone;
    }
    if (Object.hasOwn(req.body, 'name')) user.name = String(req.body.name).trim();
    if (Object.hasOwn(req.body, 'accountStatus')) {
      const nextStatus = req.body.accountStatus;
      if (nextStatus !== 'active' && user.accountStatus === 'active') {
        const activeOwners = await User.countDocuments({
          role: 'owner',
          accountStatus: 'active',
        });
        if (activeOwners <= 1) {
          return res.status(400).json({
            message: 'Cannot change status of the last active platform admin.',
          });
        }
      }
      user.accountStatus = nextStatus;
    }
    if (
      Object.hasOwn(req.body, 'password') &&
      typeof req.body.password === 'string' &&
      req.body.password.length >= 6
    ) {
      user.password = req.body.password;
    }
    await user.save();
    return res.json({ admin: mapPlatformAdminRow(user) });
  }
);

router.delete(
  '/platform-admins/:adminId',
  [param('adminId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    if (req.user.id === req.params.adminId) {
      return res.status(400).json({ message: 'You cannot delete your own account.' });
    }
    const ownerCount = await User.countDocuments({ role: 'owner' });
    if (ownerCount <= 1) {
      return res.status(400).json({ message: 'Cannot delete the only platform admin.' });
    }
    const user = await User.findOne({ _id: req.params.adminId, role: 'owner' });
    if (!user) return res.status(404).json({ message: 'Admin not found' });
    await User.deleteOne({ _id: user._id });
    return res.json({ ok: true });
  }
);

router.get('/companies/approved', async (_req, res) => {
  const companies = await User.find({ role: 'company', companyStatus: 'approved' }).sort({ createdAt: -1 }).limit(500);
  const ids = companies.map((c) => c._id);
  const profiles = await CompanyProfile.find({ userId: { $in: ids } });
  const byId = new Map(profiles.map((p) => [p.userId.toString(), p]));
  return res.json({ companies: companies.map((c) => mapCompanyRow(c, byId.get(c._id.toString()))) });
});

router.get('/companies/suspended', async (_req, res) => {
  const companies = await User.find({ role: 'company', companyStatus: 'suspended' }).sort({ createdAt: -1 }).limit(500);
  const ids = companies.map((c) => c._id);
  const profiles = await CompanyProfile.find({ userId: { $in: ids } });
  const byId = new Map(profiles.map((p) => [p.userId.toString(), p]));
  return res.json({ companies: companies.map((c) => mapCompanyRow(c, byId.get(c._id.toString()))) });
});

router.get('/companies/pending', async (_req, res) => {
  const companies = await User.find(pendingCompanyQuery).sort({ createdAt: -1 }).limit(500);
  const ids = companies.map((c) => c._id);
  const profiles = await CompanyProfile.find({ userId: { $in: ids } });
  const byId = new Map(profiles.map((p) => [p.userId.toString(), p]));
  return res.json({ companies: companies.map((c) => mapCompanyRow(c, byId.get(c._id.toString()))) });
});

router.get(
  '/companies/:companyId',
  [param('companyId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const company = await User.findOne({ _id: req.params.companyId, role: 'company' });
    if (!company) return res.status(404).json({ message: 'Company not found' });
    const profile = await CompanyProfile.findOne({ userId: company._id });
    return res.json({ company: mapCompanyRow(company, profile) });
  }
);

router.post(
  '/companies/:companyId/suspend',
  [param('companyId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const company = await User.findOne({ _id: req.params.companyId, role: 'company' });
    if (!company) return res.status(404).json({ message: 'Company not found' });
    if (company.companyStatus !== 'approved') {
      return res.status(400).json({ message: 'Only approved companies can be suspended.' });
    }
    company.companyStatus = 'suspended';
    await company.save();
    const profile = await CompanyProfile.findOne({ userId: company._id });
    return res.json({ company: mapCompanyRow(company, profile) });
  }
);

router.post(
  '/companies/:companyId/unsuspend',
  [param('companyId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const company = await User.findOne({ _id: req.params.companyId, role: 'company' });
    if (!company) return res.status(404).json({ message: 'Company not found' });
    if (company.companyStatus !== 'suspended') {
      return res.status(400).json({ message: 'Company is not suspended.' });
    }
    company.companyStatus = 'approved';
    await company.save();
    const profile = await CompanyProfile.findOne({ userId: company._id });
    return res.json({ company: mapCompanyRow(company, profile) });
  }
);

router.post(
  '/companies/:companyId/approve',
  [param('companyId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const company = await User.findOne({ _id: req.params.companyId, role: 'company' });
    if (!company) return res.status(404).json({ message: 'Company not found' });
    company.companyStatus = 'approved';
    await company.save();
    try {
      await sendCompanyApprovedEmail(company.email, company.name);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mail] company approved notification failed:', err?.message || err);
    }
    const profile = await CompanyProfile.findOne({ userId: company._id });
    return res.json({ company: mapCompanyRow(company, profile) });
  }
);

router.post(
  '/companies/:companyId/reject',
  [param('companyId').custom((v) => mongoose.Types.ObjectId.isValid(v)), body('reason').optional().isString().trim().isLength({ max: 300 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const company = await User.findOne({ _id: req.params.companyId, role: 'company' });
    if (!company) return res.status(404).json({ message: 'Company not found' });
    company.companyStatus = 'rejected';
    await company.save();
    try {
      await sendCompanyRejectedEmail(company.email, company.name, req.body.reason || '');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mail] company rejected notification failed:', err?.message || err);
    }
    const profile = await CompanyProfile.findOne({ userId: company._id });
    return res.json({ company: mapCompanyRow(company, profile) });
  }
);

router.delete(
  '/companies/:companyId',
  [
    param('companyId').custom((v) => mongoose.Types.ObjectId.isValid(v)),
    body('reason').optional().isString().trim().isLength({ max: 300 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const company = await User.findOne({ _id: req.params.companyId, role: 'company' });
    if (!company) return res.status(404).json({ message: 'Company not found' });

    const profile = await CompanyProfile.findOne({ userId: company._id });
    const pdfPath = profile?.verificationPdf?.storedPath ? String(profile.verificationPdf.storedPath) : '';

    // Notify first (best-effort).
    try {
      await sendCompanyRejectedEmail(company.email, company.name, req.body.reason || '');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mail] company rejection notification failed:', err?.message || err);
    }

    // Detach recruiters linked to this company (avoid dangling companyId).
    await User.updateMany({ role: 'recruiter', companyId: company._id }, { $set: { companyId: null } });

    await CompanyProfile.deleteOne({ userId: company._id });
    await User.deleteOne({ _id: company._id });

    // Best-effort: delete uploaded PDF from local disk (if present).
    if (pdfPath.startsWith('/uploads/')) {
      const uploadsRoot = path.join(process.cwd(), 'uploads');
      const abs = path.join(uploadsRoot, pdfPath.replace(/^\/uploads\//, ''));
      fs.promises.unlink(abs).catch(() => {});
    }

    return res.json({
      ok: true,
      message: 'Company rejected and deleted. They can register again.',
    });
  }
);

function mapRecruiterRow(user, companyUser, companyProfile) {
  const companyName =
    companyProfile?.companyDisplayName?.trim() ||
    companyUser?.name?.trim() ||
    '';
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone,
    bdId: user.bdId,
    role: user.role,
    accountStatus: user.accountStatus || 'active',
    companyId: user.companyId ? user.companyId.toString() : '',
    companyName,
    createdAt: user.createdAt,
  };
}

/** All platform recruiters (HR seats). */
router.get('/recruiters', async (_req, res) => {
  const recruiters = await User.find({ role: 'recruiter' }).sort({ createdAt: -1 }).limit(500);
  const companyIds = [
    ...new Set(
      recruiters
        .map((r) => (r.companyId ? r.companyId.toString() : ''))
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
    ),
  ];
  const companyOids = companyIds.map((id) => new mongoose.Types.ObjectId(id));
  const [companyUsers, profiles] = await Promise.all([
    companyOids.length
      ? User.find({ _id: { $in: companyOids }, role: 'company' }).select('name')
      : [],
    companyOids.length ? CompanyProfile.find({ userId: { $in: companyOids } }) : [],
  ]);
  const companyById = new Map(companyUsers.map((c) => [c._id.toString(), c]));
  const profileById = new Map(profiles.map((p) => [p.userId.toString(), p]));

  const rows = [];
  for (const doc of recruiters) {
    const bd = await ensureBdId(doc);
    if (bd) doc.bdId = bd;
    const cid = doc.companyId ? doc.companyId.toString() : '';
    rows.push(
      mapRecruiterRow(doc, cid ? companyById.get(cid) : null, cid ? profileById.get(cid) : null)
    );
  }

  return res.json({ recruiters: rows });
});

router.patch(
  '/recruiters/:recruiterId',
  [
    param('recruiterId').custom((v) => mongoose.Types.ObjectId.isValid(v)),
    body('name').optional().trim().notEmpty().isLength({ max: 120 }),
    body('phone').optional().trim().matches(/^\d{10}$/).withMessage('Phone must be 10 digits'),
    body('accountStatus').optional().isIn(accountStatuses),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const user = await User.findOne({ _id: req.params.recruiterId, role: 'recruiter' });
    if (!user) return res.status(404).json({ message: 'HR user not found' });

    if (Object.hasOwn(req.body, 'name')) user.name = req.body.name;
    if (Object.hasOwn(req.body, 'phone')) user.phone = req.body.phone;
    if (Object.hasOwn(req.body, 'accountStatus')) user.accountStatus = req.body.accountStatus;

    await user.save();

    let companyUser = null;
    let profile = null;
    if (user.companyId) {
      companyUser = await User.findById(user.companyId);
      profile = await CompanyProfile.findOne({ userId: user.companyId });
    }
    const bd = await ensureBdId(user);
    return res.json({ recruiter: mapRecruiterRow(user, companyUser, profile) });
  }
);

router.post(
  '/recruiters/:recruiterId/suspend',
  [param('recruiterId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const user = await User.findOne({ _id: req.params.recruiterId, role: 'recruiter' });
    if (!user) return res.status(404).json({ message: 'HR user not found' });
    user.accountStatus = 'suspended';
    await user.save();
    let companyUser = null;
    let profile = null;
    if (user.companyId) {
      companyUser = await User.findById(user.companyId);
      profile = await CompanyProfile.findOne({ userId: user.companyId });
    }
    return res.json({ recruiter: mapRecruiterRow(user, companyUser, profile) });
  }
);

router.post(
  '/recruiters/:recruiterId/freeze',
  [param('recruiterId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const user = await User.findOne({ _id: req.params.recruiterId, role: 'recruiter' });
    if (!user) return res.status(404).json({ message: 'HR user not found' });
    user.accountStatus = 'frozen';
    await user.save();
    let companyUser = null;
    let profile = null;
    if (user.companyId) {
      companyUser = await User.findById(user.companyId);
      profile = await CompanyProfile.findOne({ userId: user.companyId });
    }
    return res.json({ recruiter: mapRecruiterRow(user, companyUser, profile) });
  }
);

router.post(
  '/recruiters/:recruiterId/activate',
  [param('recruiterId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const user = await User.findOne({ _id: req.params.recruiterId, role: 'recruiter' });
    if (!user) return res.status(404).json({ message: 'HR user not found' });
    user.accountStatus = 'active';
    await user.save();
    let companyUser = null;
    let profile = null;
    if (user.companyId) {
      companyUser = await User.findById(user.companyId);
      profile = await CompanyProfile.findOne({ userId: user.companyId });
    }
    return res.json({ recruiter: mapRecruiterRow(user, companyUser, profile) });
  }
);

/** Demote HR seat to job seeker; clears company link (same as company "remove HR"). */
router.delete(
  '/recruiters/:recruiterId',
  [param('recruiterId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const user = await User.findOne({ _id: req.params.recruiterId, role: 'recruiter' });
    if (!user) return res.status(404).json({ message: 'HR user not found' });

    user.role = 'jobSeeker';
    user.companyId = null;
    user.accountStatus = 'active';
    await user.save();
    await ensureBdId(user);

    return res.json({
      message: 'HR seat removed. User is now a job seeker.',
      removed: true,
    });
  }
);

function mapJobSeekerRow(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone,
    bdId: user.bdId,
    headline: String(user.headline || '').trim(),
    connectionField: String(user.connectionField || '').trim(),
    accountStatus: user.accountStatus || 'active',
    createdAt: user.createdAt,
  };
}

/** All job seekers (“professionals”). */
router.get('/job-seekers', async (_req, res) => {
  const users = await User.find({ role: 'jobSeeker' }).sort({ createdAt: -1 }).limit(500);
  const rows = [];
  for (const doc of users) {
    const bd = await ensureBdId(doc);
    if (bd) doc.bdId = bd;
    rows.push(mapJobSeekerRow(doc));
  }
  return res.json({ jobSeekers: rows });
});

router.post(
  '/job-seekers/:userId/suspend',
  [param('userId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const user = await User.findOne({ _id: req.params.userId, role: 'jobSeeker' });
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.accountStatus = 'suspended';
    await user.save();
    await ensureBdId(user);
    return res.json({ jobSeeker: mapJobSeekerRow(user) });
  }
);

router.post(
  '/job-seekers/:userId/activate',
  [param('userId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);
    const user = await User.findOne({ _id: req.params.userId, role: 'jobSeeker' });
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.accountStatus = 'active';
    await user.save();
    await ensureBdId(user);
    return res.json({ jobSeeker: mapJobSeekerRow(user) });
  }
);

/** Hard delete account + linked data from DB (owner tool). Irreversible. */
router.delete(
  '/job-seekers/:userId',
  [param('userId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const user = await User.findOne({ _id: req.params.userId, role: 'jobSeeker' });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const ok = await deleteJobSeekerUserCascade(user._id);
    if (!ok) {
      return res.status(500).json({ message: 'Could not delete user.' });
    }
    return res.json({ ok: true, message: 'User and related data deleted.' });
  }
);

function mapJobPostAdminRow(j, applicationCount = 0) {
  const o = j && typeof j.toObject === 'function' ? j.toObject() : j;
  const cb = o.createdBy;
  const createdByName =
    cb && typeof cb === 'object' && cb.name != null ? String(cb.name) : '';
  return {
    id: o._id.toString(),
    title: o.title,
    description: o.description ?? '',
    jobPosition: o.jobPosition,
    location: o.location,
    workplace: o.workplace,
    employmentType: o.employmentType,
    status: o.status,
    companyName: o.companyName ?? '',
    createdByName,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    applicationCount,
  };
}

/** All job posts (owner moderation). */
router.get('/jobs', async (_req, res) => {
  const jobs = await JobPost.find({})
    .sort({ createdAt: -1 })
    .limit(200)
    .populate({ path: 'createdBy', select: 'name role companyId' })
    .lean();

  const jobIds = jobs.map((j) => j._id);
  let countByJob = {};
  if (jobIds.length > 0) {
    const countRows = await JobApplication.aggregate([
      { $match: { jobPostId: { $in: jobIds } } },
      { $group: { _id: '$jobPostId', applicationCount: { $sum: 1 } } },
    ]);
    countByJob = Object.fromEntries(
      countRows.map((r) => [r._id.toString(), r.applicationCount])
    );
  }

  return res.json({
    jobs: jobs.map((j) =>
      mapJobPostAdminRow(j, countByJob[j._id.toString()] || 0)
    ),
  });
});

router.post(
  '/jobs/:jobId/suspend',
  [param('jobId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const job = await JobPost.findById(req.params.jobId);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    job.status = 'suspended';
    await job.save();
    const populated = await JobPost.findById(job._id).populate({
      path: 'createdBy',
      select: 'name role companyId',
    });
    const n = await JobApplication.countDocuments({ jobPostId: job._id });
    return res.json({ job: mapJobPostAdminRow(populated ?? job, n) });
  }
);

router.post(
  '/jobs/:jobId/publish',
  [param('jobId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const job = await JobPost.findById(req.params.jobId);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    job.status = 'published';
    await job.save();
    const populated = await JobPost.findById(job._id).populate({
      path: 'createdBy',
      select: 'name role companyId',
    });
    const n = await JobApplication.countDocuments({ jobPostId: job._id });
    return res.json({ job: mapJobPostAdminRow(populated ?? job, n) });
  }
);

router.delete(
  '/jobs/:jobId',
  [param('jobId').custom((v) => mongoose.Types.ObjectId.isValid(v))],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const job = await JobPost.findById(req.params.jobId);
    if (!job) return res.status(404).json({ message: 'Job not found' });

    const ok = await deleteJobPostCascade(job._id);
    if (!ok) {
      return res.status(500).json({ message: 'Could not delete job.' });
    }
    return res.json({ ok: true, message: 'Job and related applications/saves deleted.' });
  }
);

router.get(
  '/broadcast/recipient-count',
  [
    query('scope').isIn(ownerBroadcastScopes).withMessage('Invalid scope'),
    query('companyUserId').optional().isString().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const scope = String(req.query.scope || '').toLowerCase();
    const companyUserId = String(req.query.companyUserId || '').trim();
    if (scope.startsWith('company_')) {
      if (!mongoose.Types.ObjectId.isValid(companyUserId)) {
        return res.status(400).json({ message: 'companyUserId is required for this scope' });
      }
    }

    const recipientIds = await resolveOwnerBroadcastRecipients(scope, companyUserId);
    return res.json({ count: recipientIds.length, scope });
  }
);

router.post(
  '/broadcast',
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
    body('scope').isIn(ownerBroadcastScopes).withMessage('Invalid scope'),
    body('companyUserId').optional().isString().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const scope = String(req.body.scope || '').toLowerCase();
    const companyUserId = String(req.body.companyUserId || '').trim();
    if (scope.startsWith('company_')) {
      if (!mongoose.Types.ObjectId.isValid(companyUserId)) {
        return res.status(400).json({ message: 'companyUserId is required for this scope' });
      }
    }

    const recipientIds = await resolveOwnerBroadcastRecipients(scope, companyUserId);
    if (!recipientIds.length) {
      return res.status(400).json({
        message:
          'No recipients for this selection. Check company approval / linked HR & employees.',
      });
    }

    const maxRecipients = 10000;
    if (recipientIds.length > maxRecipients) {
      return res.status(400).json({
        message: `Too many recipients (${recipientIds.length}). Maximum is ${maxRecipients}. Narrow the audience.`,
      });
    }

    let imageUrl = '';
    if (req.file?.filename) {
      imageUrl = `/uploads/notices/${req.file.filename}`;
    }

    const title = String(req.body.title).trim();
    const bodyText = String(req.body.body).trim();
    const ownerOid = new mongoose.Types.ObjectId(req.user.id);

    const docs = recipientIds.map((rid) => ({
      recipientId: new mongoose.Types.ObjectId(rid),
      companyUserId: ownerOid,
      sentBy: ownerOid,
      audience: 'all',
      title,
      body: bodyText,
      imageUrl,
      isPlatformBroadcast: true,
    }));

    const chunk = 500;
    for (let i = 0; i < docs.length; i += chunk) {
      await UserNotification.insertMany(docs.slice(i, i + chunk), { ordered: false });
    }

    return res.status(201).json({
      sentCount: recipientIds.length,
      scope,
      title,
    });
  }
);

export { router as adminRouter };

