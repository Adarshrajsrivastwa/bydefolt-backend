import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { JobSeekerProfile } from '../models/JobSeekerProfile.js';

const router = Router();

const profileUploadDir = path.join(process.cwd(), 'uploads', 'profiles');
fs.mkdirSync(profileUploadDir, { recursive: true });

const profileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, profileUploadDir),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'photo').replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/i.test(file.mimetype || '');
    cb(ok ? null : new Error('Only JPEG, PNG, or WebP images are allowed'), ok);
  },
});

const MAX_WORK = 24;
const MAX_EDU = 24;
const MAX_SKILLS = 80;
const MAX_LANG = 24;
const MAX_APP = 40;

function mapProfile(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    about: o.about ?? '',
    profilePhotoUrl: o.profilePhotoUrl ?? '',
    workExperiences: o.workExperiences ?? [],
    education: o.education ?? [],
    skills: o.skills ?? [],
    languages: o.languages ?? [],
    appreciations: o.appreciations ?? [],
  };
}

function sanitizeProfilePhotoUrl(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().slice(0, 500);
  if (s === '') return '';
  if (s.startsWith('/uploads/profiles/')) return s;
  return '';
}

function unlinkProfilePhotoIfOwned(urlPath) {
  if (!urlPath || typeof urlPath !== 'string') return;
  if (!urlPath.startsWith('/uploads/profiles/')) return;
  const rel = urlPath.replace(/^\//, '');
  const full = path.join(process.cwd(), rel);
  if (!full.startsWith(profileUploadDir)) return;
  try {
    fs.unlinkSync(full);
  } catch {
    // ignore
  }
}

function sanitizeWork(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_WORK).map((x) => ({
    jobTitle: String(x.jobTitle ?? '').slice(0, 200),
    company: String(x.company ?? '').slice(0, 200),
    startDate: String(x.startDate ?? '').slice(0, 40),
    endDate: String(x.endDate ?? '').slice(0, 40),
    description: String(x.description ?? '').slice(0, 4000),
    currentPosition: Boolean(x.currentPosition),
  }));
}

function sanitizeEducation(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_EDU).map((x) => ({
    level: String(x.level ?? '').slice(0, 120),
    institution: String(x.institution ?? '').slice(0, 200),
    fieldOfStudy: String(x.fieldOfStudy ?? '').slice(0, 200),
    startDate: String(x.startDate ?? '').slice(0, 40),
    endDate: String(x.endDate ?? '').slice(0, 40),
    description: String(x.description ?? '').slice(0, 4000),
    currentlyStudying: Boolean(x.currentlyStudying),
  }));
}

function sanitizeSkills(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    const t = String(s ?? '').trim().slice(0, 120);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

function sanitizeLanguages(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_LANG).map((x) => ({
    name: String(x.name ?? '').trim().slice(0, 80) || 'Language',
    flagEmoji: String(x.flagEmoji ?? '🌐').slice(0, 8),
    oralLevel: Math.min(10, Math.max(0, Number(x.oralLevel) || 0)),
    writtenLevel: Math.min(10, Math.max(0, Number(x.writtenLevel) || 0)),
    isFirstLanguage: Boolean(x.isFirstLanguage),
  }));
}

function sanitizeAppreciations(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_APP).map((x) => ({
    title: String(x.title ?? '').slice(0, 200),
    subtitle: String(x.subtitle ?? '').slice(0, 500),
    timeLabel: String(x.timeLabel ?? '').slice(0, 80),
  }));
}

router.use(requireAuth);

router.get('/by-bd-id/:bdId', async (req, res) => {
  const bdId = String(req.params.bdId || '').trim();
  if (!bdId) return res.status(400).json({ message: 'BD ID is required' });

  const user = await User.findOne({ bdId }).select('_id role');
  if (!user || user.role !== 'jobSeeker') {
    return res.status(404).json({ message: 'Profile not found' });
  }

  const doc = await JobSeekerProfile.findOne({ userId: user._id });
  return res.json({
    profile: mapProfile(
      doc || {
        about: '',
        profilePhotoUrl: '',
        workExperiences: [],
        education: [],
        skills: [],
        languages: [],
        appreciations: [],
      }
    ),
  });
});

router.get('/me', async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (user.role !== 'jobSeeker') {
    return res.status(403).json({ message: 'Job seeker profile is only for job seeker accounts' });
  }
  let doc = await JobSeekerProfile.findOne({ userId: user._id });
  if (!doc) {
    return res.json({
      profile: mapProfile({
        about: '',
        profilePhotoUrl: '',
        workExperiences: [],
        education: [],
        skills: [],
        languages: [],
        appreciations: [],
      }),
    });
  }
  return res.json({ profile: mapProfile(doc) });
});

router.put('/me', async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (user.role !== 'jobSeeker') {
    return res.status(403).json({ message: 'Job seeker profile is only for job seeker accounts' });
  }

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const prev = await JobSeekerProfile.findOne({ userId: user._id }).lean();
  const prevPhoto = prev?.profilePhotoUrl;

  let photoUpdate;
  if (Object.prototype.hasOwnProperty.call(b, 'profilePhotoUrl')) {
    const sanitized = sanitizeProfilePhotoUrl(b.profilePhotoUrl);
    if (sanitized !== undefined) {
      photoUpdate = sanitized;
      if (sanitized === '' && prevPhoto) {
        unlinkProfilePhotoIfOwned(prevPhoto);
      }
    }
  }

  const payload = {
    about: typeof b.about === 'string' ? b.about.slice(0, 8000) : '',
    workExperiences: sanitizeWork(b.workExperiences),
    education: sanitizeEducation(b.education),
    skills: sanitizeSkills(b.skills),
    languages: sanitizeLanguages(b.languages),
    appreciations: sanitizeAppreciations(b.appreciations),
  };
  if (photoUpdate !== undefined) {
    payload.profilePhotoUrl = photoUpdate;
  }

  const doc = await JobSeekerProfile.findOneAndUpdate(
    { userId: user._id },
    { $set: { ...payload, userId: user._id } },
    { upsert: true, new: true }
  );

  return res.json({ profile: mapProfile(doc) });
});

router.post('/me/photo', profileUpload.single('photo'), async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role !== 'jobSeeker') {
      return res.status(403).json({ message: 'Job seeker profile is only for job seeker accounts' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Missing image file (field name: photo)' });
    }

    const publicUrl = `/uploads/profiles/${req.file.filename}`;
    const prev = await JobSeekerProfile.findOne({ userId: user._id });
    const prevPhoto = prev?.profilePhotoUrl;

    const doc = await JobSeekerProfile.findOneAndUpdate(
      { userId: user._id },
      { $set: { profilePhotoUrl: publicUrl, userId: user._id } },
      { upsert: true, new: true }
    );

    if (prevPhoto && prevPhoto !== publicUrl) {
      unlinkProfilePhotoIfOwned(prevPhoto);
    }

    return res.json({ profile: mapProfile(doc) });
  } catch (e) {
    return res.status(400).json({ message: e?.message || 'Upload failed' });
  }
});

export { router as jobSeekerProfileRouter };
