import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { User } from '../models/User.js';
import { ensureBdId } from '../services/bdId.js';

const router = Router();

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

/** @returns {Promise<import('mongoose').Document | null>} */
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

export { router as companyProfileRouter };
