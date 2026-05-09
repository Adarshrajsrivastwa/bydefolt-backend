import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { JobSeekerProfile } from '../models/JobSeekerProfile.js';

const router = Router();

const MAX_WORK = 24;
const MAX_EDU = 24;
const MAX_SKILLS = 80;
const MAX_LANG = 24;
const MAX_APP = 40;

function mapProfile(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    about: o.about ?? '',
    workExperiences: o.workExperiences ?? [],
    education: o.education ?? [],
    skills: o.skills ?? [],
    languages: o.languages ?? [],
    appreciations: o.appreciations ?? [],
  };
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

router.get('/me', async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (user.role !== 'jobSeeker') {
    return res.status(403).json({ message: 'Job seeker profile is only for job seeker accounts' });
  }
  let doc = await JobSeekerProfile.findOne({ userId: user._id });
  if (!doc) {
    return res.json({ profile: mapProfile({ about: '', workExperiences: [], education: [], skills: [], languages: [], appreciations: [] }) });
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
  const payload = {
    about: typeof b.about === 'string' ? b.about.slice(0, 8000) : '',
    workExperiences: sanitizeWork(b.workExperiences),
    education: sanitizeEducation(b.education),
    skills: sanitizeSkills(b.skills),
    languages: sanitizeLanguages(b.languages),
    appreciations: sanitizeAppreciations(b.appreciations),
  };

  const doc = await JobSeekerProfile.findOneAndUpdate(
    { userId: user._id },
    { $set: { ...payload, userId: user._id } },
    { upsert: true, new: true }
  );

  return res.json({ profile: mapProfile(doc) });
});

export { router as jobSeekerProfileRouter };
