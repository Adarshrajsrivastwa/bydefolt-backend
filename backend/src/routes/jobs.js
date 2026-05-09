import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { JobPost, jobPostLocationOptions, jobPostTitleOptions, workplaceOptions, employmentTypeOptions } from '../models/JobPost.js';
import { User } from '../models/User.js';
import { CompanyProfile } from '../models/CompanyProfile.js';

const router = Router();

function sendValidationError(res, errors) {
  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
}

function canManageJobs(role) {
  return role === 'recruiter' || role === 'company' || role === 'owner';
}

function mapJob(job) {
  return {
    id: job._id.toString(),
    title: job.title,
    description: job.description,
    jobPosition: job.jobPosition,
    location: job.location,
    workplace: job.workplace,
    employmentType: job.employmentType,
    status: job.status,
    companyName: job.companyName,
    createdBy: job.createdBy?._id?.toString?.() ?? job.createdBy?.toString?.() ?? '',
    createdByName: job.createdBy?.name ?? '',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
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
  '/',
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
      // Re-use auth middleware behavior by calling requireAuth-style check.
      // Simpler path: use dedicated endpoint with requireAuth in future if needed.
      return res.status(400).json({ message: 'Use GET /api/jobs/mine for your own jobs' });
    }

    const jobs = await JobPost.find(q).sort({ createdAt: -1 }).limit(limit);
    return res.json({ jobs: jobs.map(mapJob) });
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
  return res.json({ jobs: jobs.map(mapJob) });
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
