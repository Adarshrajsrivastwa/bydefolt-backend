import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  JobPost,
  jobPostLocationOptions,
  jobPostTitleOptions,
  workplaceOptions,
  employmentTypeOptions,
} from '../models/JobPost.js';
import { User } from '../models/User.js';
import { CompanyProfile } from '../models/CompanyProfile.js';
import { JobSave } from '../models/JobSave.js';
import { JobApplication } from '../models/JobApplication.js';

const router = Router();

function sendValidationError(res, errors) {
  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
}

function canManageJobs(role) {
  return role === 'recruiter' || role === 'company' || role === 'owner';
}

function mapJob(job, extras = {}) {
  const j = job.toObject?.() ? job : job;
  const id = j._id?.toString?.() ?? '';
  return {
    id,
    title: j.title,
    description: j.description,
    jobPosition: j.jobPosition,
    location: j.location,
    workplace: j.workplace,
    employmentType: j.employmentType,
    status: j.status,
    companyName: j.companyName,
    createdBy: j.createdBy?._id?.toString?.() ?? j.createdBy?.toString?.() ?? '',
    createdByName: j.createdBy?.name ?? '',
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    savedByMe: extras.savedByMe === true,
    appliedByMe: extras.appliedByMe === true,
  };
}

router.get('/meta', (_req, res) => {
  return res.json({
    dropdowns: {
      titles: jobPostTitleOptions,
      locations: jobPostLocationOptions,
      workplaces: workplaceOptions,
      employmentTypes: employmentTypeOptions,
    },
  });
});

router.get(
  '/me/activity',
  requireAuth,
  async (req, res) => {
    if (req.user.role !== 'jobSeeker') {
      return res.status(403).json({ message: 'Only job seekers can access this' });
    }
    const uid = new mongoose.Types.ObjectId(req.user.id);
    const [saves, apps] = await Promise.all([
      JobSave.find({ userId: uid }).select('jobPostId').lean(),
      JobApplication.find({ userId: uid }).select('jobPostId').lean(),
    ]);
    return res.json({
      savedJobIds: saves.map((s) => s.jobPostId.toString()),
      appliedJobIds: apps.map((a) => a.jobPostId.toString()),
    });
  }
);

router.get(
  '/me/applications',
  requireAuth,
  async (req, res) => {
    if (req.user.role !== 'jobSeeker') {
      return res.status(403).json({ message: 'Only job seekers can access this' });
    }
    const uid = new mongoose.Types.ObjectId(req.user.id);
    const apps = await JobApplication.find({ userId: uid })
      .sort({ createdAt: -1 })
      .limit(80)
      .populate({ path: 'jobPostId' })
      .lean();

    const applications = apps
      .map((a) => {
        const j = a.jobPostId;
        if (!j || typeof j !== 'object' || !j._id) return null;
        if (j.status !== 'published') return null;
        return {
          appliedAt: a.createdAt,
          job: mapJob(j),
        };
      })
      .filter(Boolean);

    return res.json({ applications });
  }
);

router.get(
  '/',
  optionalAuth,
  [query('mine').optional().isIn(['true', 'false']), query('limit').optional().isInt({ min: 1, max: 100 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const limit = Number.parseInt(req.query.limit || '30', 10);
    const mine = req.query.mine === 'true';
    const q = { status: 'published' };

    if (mine) {
      const auth = req.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) {
        return res.status(401).json({ message: 'Authentication required for mine=true' });
      }
      return res.status(400).json({ message: 'Use GET /api/jobs/mine for your own jobs' });
    }

    const jobs = await JobPost.find(q).sort({ createdAt: -1 }).limit(limit).lean();

    let savedSet = new Set();
    let appliedSet = new Set();
    if (req.user?.role === 'jobSeeker' && jobs.length > 0) {
      const ids = jobs.map((j) => j._id);
      const uid = new mongoose.Types.ObjectId(req.user.id);
      const [saves, apps] = await Promise.all([
        JobSave.find({ userId: uid, jobPostId: { $in: ids } }).lean(),
        JobApplication.find({ userId: uid, jobPostId: { $in: ids } }).lean(),
      ]);
      savedSet = new Set(saves.map((s) => s.jobPostId.toString()));
      appliedSet = new Set(apps.map((a) => a.jobPostId.toString()));
    }

    return res.json({
      jobs: jobs.map((j) =>
        mapJob(j, {
          savedByMe: savedSet.has(j._id.toString()),
          appliedByMe: appliedSet.has(j._id.toString()),
        })
      ),
    });
  }
);

router.get('/mine', requireAuth, async (req, res) => {
  if (!canManageJobs(req.user.role)) {
    return res.status(403).json({ message: 'Only recruiter/company/owner can access posted jobs' });
  }

  const q = {};
  if (req.user.role === 'company') {
    const recruiters = await User.find({ role: 'recruiter', companyId: req.user.id }).select('_id');
    const ids = [req.user.id, ...recruiters.map((u) => u._id.toString())];
    q.createdBy = { $in: ids };
  } else if (req.user.role === 'owner') {
    // owner can see everything
  } else {
    q.createdBy = req.user.id;
  }

  const jobs = await JobPost.find(q)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate({ path: 'createdBy', select: 'name role companyId' });
  return res.json({ jobs: jobs.map((j) => mapJob(j)) });
});

router.post(
  '/',
  requireAuth,
  [
    body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 140 }),
    body('description').optional().trim().isLength({ max: 4000 }),
    body('jobPosition').trim().notEmpty().withMessage('Job position is required').isLength({ max: 140 }),
    body('location').trim().notEmpty().withMessage('Location is required').isLength({ max: 180 }),
    body('workplace').optional().isIn(workplaceOptions),
    body('employmentType').optional().isIn(employmentTypeOptions),
  ],
  async (req, res) => {
    if (!canManageJobs(req.user.role)) {
      return res.status(403).json({ message: 'Only recruiter/company/owner can post jobs' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const user = await User.findById(req.user.id);
    let companyName = user?.name || '';

    if (user?.role === 'company') {
      const companyProfile = await CompanyProfile.findOne({ userId: user._id });
      companyName = companyProfile?.companyDisplayName?.trim() || user.name;
    } else if (user?.role === 'recruiter' && user.companyId) {
      const companyUser = await User.findById(user.companyId);
      const companyProfile = companyUser
        ? await CompanyProfile.findOne({ userId: companyUser._id })
        : null;
      companyName = companyProfile?.companyDisplayName?.trim() || companyUser?.name || companyName;
    }

    const job = await JobPost.create({
      title: req.body.title,
      description: req.body.description || '',
      jobPosition: req.body.jobPosition,
      location: req.body.location,
      workplace: req.body.workplace || 'Hybrid',
      employmentType: req.body.employmentType || 'Full-time',
      createdBy: req.user.id,
      companyName,
    });

    const populated = await JobPost.findById(job._id).populate({ path: 'createdBy', select: 'name role companyId' });
    return res.status(201).json({ job: mapJob(populated ?? job) });
  }
);

router.post(
  '/:jobId/saved',
  requireAuth,
  [
    param('jobId').custom((value) => mongoose.Types.ObjectId.isValid(value)),
    body('saved').isBoolean(),
  ],
  async (req, res) => {
    if (req.user.role !== 'jobSeeker') {
      return res.status(403).json({ message: 'Only job seekers can save jobs' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const job = await JobPost.findById(req.params.jobId);
    if (!job || job.status !== 'published') {
      return res.status(404).json({ message: 'Job not found' });
    }

    const uid = new mongoose.Types.ObjectId(req.user.id);
    const wantSave = req.body.saved === true;

    if (wantSave) {
      await JobSave.findOneAndUpdate(
        { userId: uid, jobPostId: job._id },
        { userId: uid, jobPostId: job._id },
        { upsert: true }
      );
    } else {
      await JobSave.deleteOne({ userId: uid, jobPostId: job._id });
    }

    return res.json({ ok: true, saved: wantSave });
  }
);

router.post(
  '/:jobId/apply',
  requireAuth,
  [param('jobId').custom((value) => mongoose.Types.ObjectId.isValid(value))],
  async (req, res) => {
    if (req.user.role !== 'jobSeeker') {
      return res.status(403).json({ message: 'Only job seekers can apply to jobs' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const job = await JobPost.findById(req.params.jobId);
    if (!job || job.status !== 'published') {
      return res.status(404).json({ message: 'Job not found' });
    }

    const uid = new mongoose.Types.ObjectId(req.user.id);
    const existing = await JobApplication.findOne({ userId: uid, jobPostId: job._id });
    if (existing) {
      return res.status(200).json({ ok: true, alreadyApplied: true });
    }

    await JobApplication.create({ userId: uid, jobPostId: job._id });
    return res.status(201).json({ ok: true, alreadyApplied: false });
  }
);

router.patch(
  '/:jobId',
  requireAuth,
  [
    param('jobId').custom((value) => mongoose.Types.ObjectId.isValid(value)),
    body('title').optional().trim().notEmpty().isLength({ max: 140 }),
    body('description').optional().trim().isLength({ max: 4000 }),
    body('jobPosition').optional().trim().notEmpty().isLength({ max: 140 }),
    body('location').optional().trim().notEmpty().isLength({ max: 180 }),
    body('workplace').optional().isIn(workplaceOptions),
    body('employmentType').optional().isIn(employmentTypeOptions),
    body('status').optional().isIn(['published', 'closed']),
  ],
  async (req, res) => {
    if (!canManageJobs(req.user.role)) {
      return res.status(403).json({ message: 'Only recruiter/company/owner can update jobs' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const job = await JobPost.findById(req.params.jobId);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.createdBy.toString() !== req.user.id && req.user.role !== 'owner') {
      if (req.user.role === 'company') {
        const ok = await User.exists({ _id: job.createdBy, role: 'recruiter', companyId: req.user.id });
        if (!ok) {
          return res.status(403).json({ message: 'You can only edit jobs posted by your team' });
        }
      } else {
        return res.status(403).json({ message: 'You can only edit your own jobs' });
      }
    }

    const fields = ['title', 'description', 'jobPosition', 'location', 'workplace', 'employmentType', 'status'];
    for (const f of fields) {
      if (Object.hasOwn(req.body, f)) {
        job[f] = req.body[f];
      }
    }
    await job.save();
    const populated = await JobPost.findById(job._id).populate({ path: 'createdBy', select: 'name role companyId' });
    return res.json({ job: mapJob(populated ?? job) });
  }
);

export { router as jobsRouter };
