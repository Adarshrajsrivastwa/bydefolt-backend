import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { sendCompanyApprovedEmail, sendCompanyRejectedEmail } from '../services/mail.js';
import { ensureBdId } from '../services/bdId.js';
import { accountStatuses } from '../models/User.js';

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

router.use(requireAuth, requireOwner);

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

/** Company accounts awaiting review: explicit pending, or legacy docs missing companyStatus. */
const pendingCompanyQuery = {
  role: 'company',
  $or: [
    { companyStatus: 'pending' },
    { companyStatus: { $exists: false } },
    { companyStatus: null },
  ],
};

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

export { router as adminRouter };

