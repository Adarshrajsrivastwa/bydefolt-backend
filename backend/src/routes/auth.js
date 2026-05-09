import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { sendOtpEmail, sendWelcomeAfterSignupEmail } from '../services/mail.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, path.join(process.cwd(), 'uploads', 'company')),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'document.pdf').replace(/[^a-zA-Z0-9.\-_]/g, '_');
      const uniq = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${uniq}-${safe}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || String(file.originalname || '').toLowerCase().endsWith('.pdf');
    cb(ok ? null : new Error('Only PDF files are allowed'), ok);
  },
});

function sendValidationError(res, errors) {
  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
}

function buildBdIdBase(name, phone) {
  const firstName = name.trim().split(/\s+/)[0] || '';
  const cleanFirst = firstName.replace(/[^a-zA-Z]/g, '').slice(0, 8).toUpperCase();
  const firstLetter = cleanFirst[0] || 'U';
  const midPhone = phone.slice(5, 8);
  const year = String(new Date().getFullYear());
  return `${cleanFirst}${firstLetter}${midPhone}${year}`;
}

async function generateUniqueBdId(name, phone) {
  const base = buildBdIdBase(name, phone);
  let candidate = base;
  let counter = 1;
  while (await User.exists({ bdId: candidate })) {
    candidate = `${base}${String(counter).padStart(2, '0')}`;
    counter += 1;
  }
  return candidate;
}

function buildLegacyBdIdBase(user) {
  const fromName = (user.name || '')
    .replace(/[^a-zA-Z]/g, '')
    .slice(0, 8)
    .toUpperCase();
  const localEmail = String(user.email || '')
    .split('@')[0]
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase();
  const year = String(new Date().getFullYear());
  return `${fromName || 'USER'}${localEmail || 'ID'}${year}`;
}

async function ensureBdId(user) {
  if (user.bdId && String(user.bdId).trim().length > 0) {
    return user.bdId;
  }
  const base = buildLegacyBdIdBase(user);
  let candidate = base;
  let counter = 1;
  while (await User.exists({ bdId: candidate })) {
    candidate = `${base}${String(counter).padStart(2, '0')}`;
    counter += 1;
  }
  await User.updateOne(
    { _id: user._id, $or: [{ bdId: { $exists: false } }, { bdId: null }, { bdId: '' }] },
    { $set: { bdId: candidate } }
  );
  return candidate;
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

async function saveOtpAndMail(user, purpose) {
  const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const hash = await bcrypt.hash(code, 8);
  user.emailOtpHash = hash;
  user.emailOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  user.emailOtpPurpose = purpose;
  await user.save();
  await sendOtpEmail(user.email, code, purpose);
}

router.post(
  '/signup',
  [
    body('role')
      .optional()
      .isIn(['jobSeeker', 'company', 'recruiter'])
      .withMessage('Role must be jobSeeker, company, or recruiter'),
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Name is required')
      .custom((value, { req }) => {
        const role = req.body.role;
        if (role === 'company') {
          if (value.length > 60) {
            throw new Error('Company name must be at most 60 characters');
          }
          return true;
        }
        if (role === 'recruiter') {
          if (value.length > 120) {
            throw new Error('Name must be at most 120 characters');
          }
          return true;
        }
        if (!/^[A-Za-z]{1,8}$/.test(value)) {
          throw new Error('First name must be letters only and max 8 characters');
        }
        return true;
      }),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('phone').trim().matches(/^\d{10}$/).withMessage('Phone number must be 10 digits'),
    body('companyEmail').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const { name, email, password, phone } = req.body;
    const role = req.body.role === 'company' ? 'company' : req.body.role === 'recruiter' ? 'recruiter' : 'jobSeeker';

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }
    const existingPhone = await User.findOne({ phone });
    if (existingPhone) {
      return res.status(409).json({ message: 'An account with this phone number already exists' });
    }

    const bdId = await generateUniqueBdId(name, phone);

    let companyId = null;
    if (role === 'recruiter' && req.body.companyEmail) {
      const company = await User.findOne({ email: String(req.body.companyEmail).toLowerCase(), role: 'company' });
      companyId = company?._id ?? null;
    }

    const user = await User.create({
      name,
      email,
      password,
      phone,
      bdId,
      role,
      companyId,
      emailVerified: false,
    });
    if (role === 'company') {
      const companyFields = [
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
      const profilePayload = { userId: user._id };
      for (const k of companyFields) {
        if (Object.hasOwn(req.body, k)) {
          profilePayload[k] = req.body[k] ?? '';
        }
      }
      await CompanyProfile.findOneAndUpdate({ userId: user._id }, { $setOnInsert: profilePayload }, { upsert: true, new: true });
    }
    await saveOtpAndMail(user, 'signup');

    const userObj = user.toObject();
    delete userObj.password;

    return res.status(201).json({
      needsOtp: true,
      otpPurpose: 'signup',
      user: {
        id: userObj._id.toString(),
        name: userObj.name,
        email: userObj.email,
        phone: userObj.phone,
        bdId: userObj.bdId,
        role: userObj.role,
        companyStatus: userObj.companyStatus,
      },
      accessToken: '',
      needsApproval: false,
    });
  }
);

// Company signup with verification PDF (multipart/form-data)
router.post(
  '/company-signup',
  upload.single('verificationPdf'),
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 60 }),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('phone').trim().matches(/^\d{10}$/).withMessage('Phone number must be 10 digits'),
    body('companyDisplayName').trim().notEmpty().withMessage('Company display name is required').isLength({ max: 120 }),
    body('industry').optional().isString().trim().isLength({ max: 120 }),
    body('website').optional({ values: 'falsy' }).isURL().withMessage('Website must be a valid URL'),
    body('headquarters').optional().isString().trim().isLength({ max: 180 }),
    body('companyAddress').optional().isString().trim().isLength({ max: 250 }),
    body('about').optional().isString().trim().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const { name, email, password, phone } = req.body;
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'An account with this email already exists' });
    const existingPhone = await User.findOne({ phone });
    if (existingPhone) return res.status(409).json({ message: 'An account with this phone number already exists' });

    const bdId = await generateUniqueBdId(name, phone);
    const user = await User.create({
      name,
      email,
      password,
      phone,
      bdId,
      role: 'company',
      emailVerified: false,
    });

    const file = req.file;
    const storedPath = file ? `/uploads/company/${file.filename}` : '';

    await CompanyProfile.findOneAndUpdate(
      { userId: user._id },
      {
        $setOnInsert: {
          userId: user._id,
          companyDisplayName: req.body.companyDisplayName ?? '',
          legalRegisteredName: req.body.legalRegisteredName ?? '',
          industry: req.body.industry ?? '',
          website: req.body.website ?? '',
          headquarters: req.body.headquarters ?? '',
          companyAddress: req.body.companyAddress ?? '',
          companyPhone: req.body.companyPhone ?? '',
          companyEmailContact: req.body.companyEmailContact ?? '',
          about: req.body.about ?? '',
          verificationPdf: file
            ? {
                originalName: file.originalname || '',
                mimeType: file.mimetype || '',
                sizeBytes: file.size || 0,
                storedPath,
                uploadedAt: new Date(),
              }
            : undefined,
        },
      },
      { upsert: true, new: true }
    );

    await saveOtpAndMail(user, 'signup');

    const userObj = user.toObject();
    delete userObj.password;
    return res.status(201).json({
      needsOtp: true,
      otpPurpose: 'signup',
      user: {
        id: userObj._id.toString(),
        name: userObj.name,
        email: userObj.email,
        phone: userObj.phone,
        bdId: userObj.bdId,
        role: userObj.role,
        companyStatus: userObj.companyStatus,
      },
      accessToken: '',
      needsApproval: false,
    });
  }
);

router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    const bdId = await ensureBdId(user);
    if (user.emailVerified === false) {
      return res.status(403).json({
        message:
          'Please verify your email first. Enter the 4-digit code we sent when you registered.',
      });
    }
    if (user.role === 'company' && user.companyStatus !== 'approved') {
      return res.status(403).json({ message: 'Company account pending approval. Please wait for admin approval.' });
    }
    await saveOtpAndMail(user, 'login');
    return res.json({
      needsOtp: true,
      otpPurpose: 'login',
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone,
        bdId,
        role: user.role,
        companyStatus: user.companyStatus,
      },
      accessToken: '',
    });
  }
);

router.post(
  '/verify-otp',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('otp').matches(/^\d{4}$/).withMessage('OTP must be 4 digits'),
    body('purpose').isIn(['signup', 'login']).withMessage('Invalid purpose'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const email = String(req.body.email).toLowerCase();
    const { otp, purpose } = req.body;

    const user = await User.findOne({ email }).select('+emailOtpHash');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (!user.emailOtpHash || user.emailOtpPurpose !== purpose) {
      return res.status(400).json({
        message: 'No active verification code. Try again or request a new code.',
      });
    }
    if (!user.emailOtpExpiresAt || user.emailOtpExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: 'Verification code expired. Request a new one.' });
    }
    const match = await bcrypt.compare(otp, user.emailOtpHash);
    if (!match) {
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    user.emailOtpHash = null;
    user.emailOtpExpiresAt = null;
    user.emailOtpPurpose = null;
    if (purpose === 'signup') {
      user.emailVerified = true;
    }
    await user.save();

    const bdId = await ensureBdId(user);

    if (purpose === 'signup') {
      const companyPendingReview = user.role === 'company' && user.companyStatus !== 'approved';
      try {
        await sendWelcomeAfterSignupEmail(user.email, user.name, companyPendingReview);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[mail] welcome after signup failed:', err?.message || err);
      }
    }

    if (user.role === 'company' && user.companyStatus !== 'approved') {
      return res.json({
        needsOtp: false,
        otpPurpose: null,
        needsApproval: true,
        accessToken: '',
        user: {
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          phone: user.phone,
          bdId,
          role: user.role,
          companyStatus: user.companyStatus,
        },
      });
    }

    const accessToken = signToken(user);
    return res.json({
      needsOtp: false,
      otpPurpose: null,
      needsApproval: false,
      accessToken,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone,
        bdId,
        role: user.role,
        companyStatus: user.companyStatus,
      },
    });
  }
);

router.post(
  '/resend-otp',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
    body('purpose').isIn(['signup', 'login']).withMessage('Invalid purpose'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const email = String(req.body.email).toLowerCase();
    const { password, purpose } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (purpose === 'signup') {
      if (user.emailVerified !== false) {
        return res.status(400).json({ message: 'Email is already verified. You can sign in.' });
      }
    } else if (purpose === 'login') {
      if (user.emailVerified === false) {
        return res.status(403).json({
          message: 'Verify your email first using the signup code we sent.',
        });
      }
      if (user.role === 'company' && user.companyStatus !== 'approved') {
        return res.status(403).json({ message: 'Company account pending approval. Please wait for admin approval.' });
      }
    }

    await saveOtpAndMail(user, purpose);
    return res.json({ ok: true, message: 'A new code was sent to your email.' });
  }
);

router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  const bdId = await ensureBdId(user);
  return res.json({
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      bdId,
      role: user.role,
      companyStatus: user.companyStatus,
    },
  });
});

export { router as authRouter };
