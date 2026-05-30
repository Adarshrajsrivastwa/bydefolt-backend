import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { JobSeekerProfile } from '../models/JobSeekerProfile.js';
import { relationshipForViewer } from '../services/memberRelationship.js';
import { effectiveConnectionField } from '../util/connectionField.js';
import {
  clearStaleEmployerRequestsForSeeker,
  enrichWorkExperiencesWithVerification,
  syncEmployerJoinRequestsForSeeker,
} from '../services/workExperienceVerification.js';
import mongoose from 'mongoose';
import { canManageOwnJobSeekerProfile } from '../util/memberNetwork.js';
import { connectionStatsForUser } from '../services/memberNetworkStats.js';
import {
  EDUCATION_LEVELS,
  FIELD_OF_STUDY_BY_LEVEL,
} from '../constants/educationOptions.js';
import {
  MAX_PROFICIENCY_LEVEL,
  MIN_PROFICIENCY_LEVEL,
  PROFICIENCY_LABELS,
  normalizeLanguageList,
} from '../constants/languageOptions.js';

const router = Router();

const profileUploadDir = path.join(process.cwd(), 'uploads', 'profiles');
fs.mkdirSync(profileUploadDir, { recursive: true });

function isAllowedProfileImage(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  const name = String(file.originalname || '').toLowerCase();
  if (
    /^image\/(jpeg|jpg|pjpeg|png|x-png|webp|gif|bmp|x-ms-bmp|heic|heif|x-heic|x-heif|avif|tiff|x-tiff)$/i.test(
      mime
    )
  ) {
    return true;
  }
  if (
    mime === 'application/octet-stream' &&
    /\.(jpe?g|png|webp|gif|heic|heif|bmp|avif|tif|tiff)$/i.test(name)
  ) {
    return true;
  }
  return false;
}

const profileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, profileUploadDir),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'photo').replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(
      isAllowedProfileImage(file)
        ? null
        : new Error(
            'Only image files are allowed (JPEG, PNG, WebP, GIF, HEIC, BMP, AVIF, TIFF)'
          ),
      isAllowedProfileImage(file)
    );
  },
});

const MAX_WORK = 24;
const MAX_EDU = 24;
const MAX_SKILLS = 80;
const MAX_LANG = 24;
const MAX_APP = 40;

function mapProfile(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  const aboutRaw = o.about;
  const about =
    typeof aboutRaw === 'string'
      ? aboutRaw
      : String(aboutRaw ?? '').slice(0, 8000);
  const photoRaw = o.profilePhotoUrl;
  const profilePhotoUrl =
    typeof photoRaw === 'string' ? photoRaw : String(photoRaw ?? '');
  return {
    about,
    profilePhotoUrl,
    workExperiences: sanitizeWork(o.workExperiences),
    education: sanitizeEducation(o.education),
    skills: sanitizeSkills(o.skills),
    languages: sanitizeLanguages(o.languages),
    appreciations: sanitizeAppreciations(o.appreciations),
  };
}

async function mapProfileForSeeker(doc, seekerUserId) {
  const base = mapProfile(doc);
  base.workExperiences = await enrichWorkExperiencesWithVerification(
    base.workExperiences,
    seekerUserId
  );
  return base;
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
  return list.slice(0, MAX_WORK).map((x) => {
    let companyUserId = String(x.companyUserId ?? '').trim();
    if (companyUserId && !mongoose.Types.ObjectId.isValid(companyUserId)) {
      companyUserId = '';
    }
    return {
      jobTitle: String(x.jobTitle ?? '').slice(0, 200),
      company: String(x.company ?? '').slice(0, 200),
      startDate: String(x.startDate ?? '').slice(0, 40),
      endDate: String(x.endDate ?? '').slice(0, 40),
      description: String(x.description ?? '').slice(0, 4000),
      currentPosition: Boolean(x.currentPosition),
      companyUserId,
    };
  });
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
  return normalizeLanguageList(list, MAX_LANG);
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

/** Dropdown options for education form (levels + courses per level). */
router.get('/education-options', (_req, res) => {
  res.json({
    levels: EDUCATION_LEVELS,
    coursesByLevel: FIELD_OF_STUDY_BY_LEVEL,
  });
});

/** Language form schema: 5-star proficiency + native flag (no separate oral/written). */
router.get('/language-options', (_req, res) => {
  res.json({
    minProficiencyLevel: MIN_PROFICIENCY_LEVEL,
    maxProficiencyLevel: MAX_PROFICIENCY_LEVEL,
    proficiencyLabels: PROFICIENCY_LABELS,
    fields: ['name', 'flagEmoji', 'proficiencyLevel', 'isNative'],
    deprecatedFields: ['oralLevel', 'writtenLevel', 'isFirstLanguage'],
  });
});

/**
 * Rich public profile payload for Connect / request cards (member + CV + relationship).
 */
router.get('/view/:bdId', async (req, res) => {
  const bdId = String(req.params.bdId || '').trim().toUpperCase();
  if (!bdId) return res.status(400).json({ message: 'BD ID is required' });

  const viewer = await User.findById(req.user.id).select('_id role');
  if (!viewer) return res.status(404).json({ message: 'User not found' });

  const target = await User.findOne({ bdId }).select(
    'name bdId headline connectionField role'
  );
  if (!target) return res.status(404).json({ message: 'Member not found' });

  const emptyProfile = {
    about: '',
    profilePhotoUrl: '',
    workExperiences: [],
    education: [],
    skills: [],
    languages: [],
    appreciations: [],
  };
  const doc = await JobSeekerProfile.findOne({ userId: target._id });
  const profile = await mapProfileForSeeker(
    doc || emptyProfile,
    target._id.toString()
  );
  const profilePhotoUrl = profile.profilePhotoUrl || '';

  const relationship = await relationshipForViewer(viewer._id, target._id);
  const { connectedCount, followingCount } = await connectionStatsForUser(target._id);

  return res.json({
    member: {
      id: target._id.toString(),
      name: target.name,
      bdId: target.bdId || bdId,
      headline: target.headline || '',
      field: effectiveConnectionField(target),
      role: target.role || 'jobSeeker',
      profilePhotoUrl,
      connectedCount,
      followingCount,
    },
    profile,
    relationship,
  });
});

router.get('/by-bd-id/:bdId', async (req, res) => {
  const bdId = String(req.params.bdId || '').trim().toUpperCase();
  if (!bdId) return res.status(400).json({ message: 'BD ID is required' });

  const user = await User.findOne({ bdId }).select('_id role');
  if (!user || user.role !== 'jobSeeker') {
    return res.status(404).json({ message: 'Profile not found' });
  }

  const doc = await JobSeekerProfile.findOne({ userId: user._id });
  const profile = await mapProfileForSeeker(
    doc || {
      about: '',
      profilePhotoUrl: '',
      workExperiences: [],
      education: [],
      skills: [],
      languages: [],
      appreciations: [],
    },
    user._id.toString()
  );
  return res.json({ profile });
});

router.get('/me', async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (!canManageOwnJobSeekerProfile(user)) {
    return res.status(403).json({ message: 'Profile is not available for this account' });
  }
  let doc = await JobSeekerProfile.findOne({ userId: user._id });
  if (!doc) {
    return res.json({
      profile: await mapProfileForSeeker(
        {
          about: '',
          profilePhotoUrl: '',
          workExperiences: [],
          education: [],
          skills: [],
          languages: [],
          appreciations: [],
        },
        user._id.toString()
      ),
    });
  }
  return res.json({ profile: await mapProfileForSeeker(doc, user._id.toString()) });
});

router.put('/me', async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (!canManageOwnJobSeekerProfile(user)) {
    return res.status(403).json({ message: 'Profile is not available for this account' });
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

  const payload = { userId: user._id };
  if (typeof b.about === 'string') {
    payload.about = b.about.slice(0, 8000);
  } else if (!prev) {
    payload.about = '';
  }
  if (Object.prototype.hasOwnProperty.call(b, 'workExperiences')) {
    payload.workExperiences = sanitizeWork(b.workExperiences);
  } else if (!prev) {
    payload.workExperiences = [];
  }
  if (Object.prototype.hasOwnProperty.call(b, 'education')) {
    payload.education = sanitizeEducation(b.education);
  } else if (!prev) {
    payload.education = [];
  }
  if (Object.prototype.hasOwnProperty.call(b, 'skills')) {
    payload.skills = sanitizeSkills(b.skills);
  } else if (!prev) {
    payload.skills = [];
  }
  if (Object.prototype.hasOwnProperty.call(b, 'languages')) {
    payload.languages = sanitizeLanguages(b.languages);
  } else if (!prev) {
    payload.languages = [];
  }
  if (Object.prototype.hasOwnProperty.call(b, 'appreciations')) {
    payload.appreciations = sanitizeAppreciations(b.appreciations);
  } else if (!prev) {
    payload.appreciations = [];
  }
  if (photoUpdate !== undefined) {
    payload.profilePhotoUrl = photoUpdate;
  }

  const doc = await JobSeekerProfile.findOneAndUpdate(
    { userId: user._id },
    { $set: payload },
    { upsert: true, new: true }
  );

  if (Object.prototype.hasOwnProperty.call(b, 'workExperiences')) {
    const nextWork = payload.workExperiences ?? sanitizeWork(doc.workExperiences);
    await clearStaleEmployerRequestsForSeeker(
      user._id.toString(),
      sanitizeWork(prev?.workExperiences ?? []),
      nextWork
    );
    await syncEmployerJoinRequestsForSeeker(user._id.toString(), nextWork);
  }

  return res.json({ profile: await mapProfileForSeeker(doc, user._id.toString()) });
});

function parseProfileIndex(raw, label) {
  const index = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(index) || index < 0) {
    return { error: `Invalid ${label} index` };
  }
  return { index };
}

/** Remove one work experience row; clears employer verification for removed companies. */
router.delete('/me/work-experiences/:index', async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (!canManageOwnJobSeekerProfile(user)) {
    return res.status(403).json({ message: 'Profile is not available for this account' });
  }

  const parsed = parseProfileIndex(req.params.index, 'work experience');
  if (parsed.error) return res.status(400).json({ message: parsed.error });

  const doc = await JobSeekerProfile.findOne({ userId: user._id });
  const previous = sanitizeWork(doc?.workExperiences ?? []);
  if (parsed.index >= previous.length) {
    return res.status(404).json({ message: 'Work experience entry not found' });
  }

  const next = [...previous];
  next.splice(parsed.index, 1);

  const updated = await JobSeekerProfile.findOneAndUpdate(
    { userId: user._id },
    { $set: { workExperiences: next, userId: user._id } },
    { upsert: true, new: true }
  );

  await clearStaleEmployerRequestsForSeeker(
    user._id.toString(),
    previous,
    next
  );
  await syncEmployerJoinRequestsForSeeker(user._id.toString(), next);

  return res.json({ profile: await mapProfileForSeeker(updated, user._id.toString()) });
});

/** Remove one education row by index (0-based, same order as stored on profile). */
router.delete('/me/education/:index', async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (!canManageOwnJobSeekerProfile(user)) {
    return res.status(403).json({ message: 'Profile is not available for this account' });
  }

  const parsed = parseProfileIndex(req.params.index, 'education');
  if (parsed.error) return res.status(400).json({ message: parsed.error });

  const doc = await JobSeekerProfile.findOne({ userId: user._id });
  const current = sanitizeEducation(doc?.education ?? []);
  if (parsed.index >= current.length) {
    return res.status(404).json({ message: 'Education entry not found' });
  }

  current.splice(parsed.index, 1);

  const updated = await JobSeekerProfile.findOneAndUpdate(
    { userId: user._id },
    { $set: { education: current, userId: user._id } },
    { upsert: true, new: true }
  );

  return res.json({ profile: await mapProfileForSeeker(updated, user._id.toString()) });
});

router.post('/me/photo', profileUpload.single('photo'), async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!canManageOwnJobSeekerProfile(user)) {
      return res.status(403).json({ message: 'Profile is not available for this account' });
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

    return res.json({ profile: await mapProfileForSeeker(doc, user._id.toString()) });
  } catch (e) {
    return res.status(400).json({ message: e?.message || 'Upload failed' });
  }
});

export { router as jobSeekerProfileRouter };
