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
import { ensureBdId, generateUniqueBdId } from '../services/bdId.js';
import { CONNECTION_FIELDS, effectiveConnectionField, inferConnectionField } from '../util/connectionField.js';
import { OWNER_LOGIN_REQUIRES_OTP } from '../constants/platformAdminLogin.js';
import {
  EMAIL_NORM_OPTS,
  findUserByAuthEmail,
  normalizeAuthEmail,
} from '../util/normalizeAuthEmail.js';

const router = Router();
const emailField = () =>
  body('email').isEmail().normalizeEmail(EMAIL_NORM_OPTS).withMessage('Valid email is required');

function companyAccountBlockedMessage(status) {
  if (status === 'suspended') return 'Company account has been suspended. Contact platform support.';
  if (status === 'rejected') return 'Company registration was rejected.';
  return 'Company account pending approval. Please wait for admin approval.';
}

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

function publicUserPayload(user, bdId) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone,
    bdId,
    role: user.role,
    companyStatus: user.companyStatus,
    headline: user.headline || '',
    connectionField: effectiveConnectionField(user),
  };
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
  try {
    await sendOtpEmail(user.email, code, purpose);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth] OTP email send failed (code still valid in DB / server log):', err?.message || err);
  }
  return code;
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
    emailField(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('phone').trim().matches(/^\d{10}$/).withMessage('Phone number must be 10 digits'),
    body('companyEmail').optional({ values: 'falsy' }).isEmail().normalizeEmail(EMAIL_NORM_OPTS),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const { name, email, password, phone } = req.body;
    const role = req.body.role === 'company' ? 'company' : req.body.role === 'recruiter' ? 'recruiter' : 'jobSeeker';

    const emailNorm = normalizeAuthEmail(email);
    const existing = await User.findOne({ email: emailNorm });
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
      ...(role === 'jobSeeker' ? { connectionField: inferConnectionField(bdId) } : {}),
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
      user: publicUserPayload(user, userObj.bdId),
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
    emailField(),
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
    const emailNorm = normalizeAuthEmail(email);
    const existing = await User.findOne({ email: emailNorm });
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
      user: publicUserPayload(user, userObj.bdId),
      accessToken: '',
      needsApproval: false,
    });
  }
);

router.post(
  '/login',
  [emailField(), body('password').notEmpty().withMessage('Password is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const { password } = req.body;
    const emailNorm = normalizeAuthEmail(req.body.email);
    const user = await findUserByAuthEmail(User, emailNorm, '+password');
    if (!user) {
      return res.status(401).json({
        message:
          'No account found for this email. Register first, or use Forgot password if you already signed up.',
      });
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
    if (user.role === 'company') {
      if (user.companyStatus === 'suspended' || user.companyStatus === 'rejected') {
        return res.status(403).json({ message: companyAccountBlockedMessage(user.companyStatus) });
      }
      if (user.companyStatus !== 'approved') {
        return res.status(403).json({ message: companyAccountBlockedMessage(user.companyStatus) });
      }
    }

    const accountStatus = user.accountStatus || 'active';
    if (user.role === 'recruiter' || user.role === 'jobSeeker') {
      if (accountStatus === 'suspended') {
        return res.status(403).json({
          message: 'Your account has been suspended. Contact platform support.',
        });
      }
      if (accountStatus === 'frozen') {
        return res.status(403).json({
          message: 'Your account is frozen. Contact platform support.',
        });
      }
    }

    // Platform owner: password-only login unless listed in OWNER_LOGIN_REQUIRES_OTP (seeded admin).
    if (user.role === 'owner' && !OWNER_LOGIN_REQUIRES_OTP.has(user.email)) {
      const accessToken = signToken(user);
      return res.json({
        needsOtp: false,
        otpPurpose: null,
        needsApproval: false,
        accessToken,
        user: publicUserPayload(user, bdId),
      });
    }

    const otpCode = await saveOtpAndMail(user, 'login');
    const payload = {
      needsOtp: true,
      otpPurpose: 'login',
      user: publicUserPayload(user, bdId),
      accessToken: '',
      message: 'Enter the 4-digit code sent to your email to finish signing in.',
    };
    if (process.env.NODE_ENV === 'development' && process.env.AUTH_DEV_EXPOSE_OTP === 'true') {
      payload.devOtp = otpCode;
    }
    return res.json(payload);
  }
);

router.post(
  '/forgot-password',
  [emailField()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const email = normalizeAuthEmail(req.body.email);
    const user = await User.findOne({ email });
    if (user) {
      await saveOtpAndMail(user, 'passwordReset');
    }
    return res.json({
      ok: true,
      message: 'If an account exists for this email, we sent a 4-digit code.',
    });
  }
);

router.post(
  '/reset-password',
  [
    emailField(),
    body('otp').matches(/^\d{4}$/).withMessage('OTP must be 4 digits'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const email = normalizeAuthEmail(req.body.email);
    const otp = String(req.body.otp);
    const { newPassword } = req.body;

    const user = await User.findOne({ email }).select('+password +emailOtpHash');
    if (!user || !user.emailOtpHash || user.emailOtpPurpose !== 'passwordReset') {
      return res.status(400).json({
        message: 'Invalid or expired code. Request a new code from Forgot password.',
      });
    }
    if (!user.emailOtpExpiresAt || user.emailOtpExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: 'Code expired. Request a new password reset.' });
    }
    const match = await bcrypt.compare(otp, user.emailOtpHash);
    if (!match) {
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    user.password = newPassword;
    user.emailOtpHash = null;
    user.emailOtpExpiresAt = null;
    user.emailOtpPurpose = null;
    await user.save();

    return res.json({ ok: true, message: 'Password updated. You can sign in now.' });
  }
);

router.post(
  '/verify-otp',
  [
    emailField(),
    body('otp').matches(/^\d{4}$/).withMessage('OTP must be 4 digits'),
    body('purpose').isIn(['signup', 'login']).withMessage('Invalid purpose'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const email = normalizeAuthEmail(req.body.email);
    const { otp, purpose } = req.body;

    const user = await findUserByAuthEmail(User, email, '+emailOtpHash');
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
    const fresh = (await User.findById(user._id)) || user;

    if (purpose === 'signup') {
      const companyPendingReview = user.role === 'company' && user.companyStatus !== 'approved';
      try {
        await sendWelcomeAfterSignupEmail(user.email, user.name, companyPendingReview);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[mail] welcome after signup failed:', err?.message || err);
      }
    }

    if (user.role === 'company') {
      if (user.companyStatus === 'suspended' || user.companyStatus === 'rejected') {
        return res.status(403).json({ message: companyAccountBlockedMessage(user.companyStatus) });
      }
      if (user.companyStatus !== 'approved') {
        return res.json({
          needsOtp: false,
          otpPurpose: null,
          needsApproval: true,
          accessToken: '',
          user: publicUserPayload(fresh, bdId),
        });
      }
    }

    const accessToken = signToken(user);
    return res.json({
      needsOtp: false,
      otpPurpose: null,
      needsApproval: false,
      accessToken,
      user: publicUserPayload(fresh, bdId),
    });
  }
);

router.post(
  '/resend-otp',
  [
    emailField(),
    body('password').notEmpty().withMessage('Password is required'),
    body('purpose').isIn(['signup', 'login']).withMessage('Invalid purpose'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const email = normalizeAuthEmail(req.body.email);
    const { password, purpose } = req.body;

    const user = await findUserByAuthEmail(User, email, '+password');
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
      if (user.role === 'company') {
        if (user.companyStatus === 'suspended' || user.companyStatus === 'rejected') {
          return res.status(403).json({ message: companyAccountBlockedMessage(user.companyStatus) });
        }
        if (user.companyStatus !== 'approved') {
          return res.status(403).json({ message: companyAccountBlockedMessage(user.companyStatus) });
        }
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
  const fresh = await User.findById(req.user.id);
  return res.json({
    user: publicUserPayload(fresh, bdId),
  });
});

router.patch(
  '/me/profile',
  requireAuth,
  [
    body('headline').optional().isString().trim().isLength({ max: 200 }),
    body('connectionField')
      .optional()
      .custom((v) => v == null || v === '' || CONNECTION_FIELDS.includes(String(v)))
      .withMessage(`connectionField must be one of: ${CONNECTION_FIELDS.join(', ')}`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const updates = {};
    if (req.body.headline !== undefined) {
      updates.headline = String(req.body.headline).slice(0, 200);
    }
    if (req.body.connectionField !== undefined) {
      const v = req.body.connectionField;
      updates.connectionField = v === '' || v == null ? '' : String(v).trim();
    }

    if (Object.keys(updates).length) {
      await User.updateOne({ _id: user._id }, { $set: updates });
    }

    const fresh = await User.findById(user._id);
    const bdId = await ensureBdId(fresh);
    return res.json({
      user: publicUserPayload(fresh, bdId),
    });
  }
);

export { router as authRouter };
