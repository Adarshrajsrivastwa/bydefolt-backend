import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { User } from '../models/User.js';

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

export { router as companyProfileRouter };
