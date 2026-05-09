import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { sendCompanyApprovedEmail, sendCompanyRejectedEmail } from '../services/mail.js';

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
        }
      : null,
  };
}

router.use(requireAuth, requireOwner);

router.get('/companies/pending', async (_req, res) => {
  const companies = await User.find({ role: 'company', companyStatus: 'pending' }).sort({ createdAt: -1 }).limit(200);
  const ids = companies.map((c) => c._id);
  const profiles = await CompanyProfile.find({ userId: { $in: ids } });
  const byId = new Map(profiles.map((p) => [p.userId.toString(), p]));
  return res.json({ companies: companies.map((c) => mapCompanyRow(c, byId.get(c._id.toString()))) });
});

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

export { router as adminRouter };

