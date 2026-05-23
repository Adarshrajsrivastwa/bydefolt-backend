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

import { JobApplication, applicationStages } from '../models/JobApplication.js';
import { CompanyEmployerJoinRequest } from '../models/CompanyEmployerJoinRequest.js';

/** Job seeker board: applications, saves, apply (also HR in personal member view). */
function canUseJobSeekerJobFeatures(role) {
  return role === 'jobSeeker' || role === 'recruiter';
}

const router = Router();



function sendValidationError(res, errors) {

  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });

}



function canManageJobs(role) {

  return role === 'recruiter' || role === 'company' || role === 'owner';

}



/** Whether [reqUser] may manage hiring for this job post (same rules as PATCH job). */

async function userOwnsOrCompanyOwnsJob(reqUser, job) {

  if (reqUser.role === 'owner') return true;

  if (String(job.createdBy) === reqUser.id) return true;

  if (reqUser.role === 'company') {

    return User.exists({ _id: job.createdBy, role: 'recruiter', companyId: reqUser.id });

  }

  if (reqUser.role === 'recruiter') {

    const me = await User.findById(reqUser.id).select('companyId').lean();

    if (!me?.companyId) return false;

    const companyOid = me.companyId;

    if (String(job.createdBy) === String(companyOid)) return true;

    return User.exists({ _id: job.createdBy, role: 'recruiter', companyId: companyOid });

  }

  return false;

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

    applicationStages,

  });

});



router.get(

  '/me/activity',

  requireAuth,

  async (req, res) => {

    if (!canUseJobSeekerJobFeatures(req.user.role)) {

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

    if (!canUseJobSeekerJobFeatures(req.user.role)) {

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

  '/me/saved',

  requireAuth,

  async (req, res) => {

    if (!canUseJobSeekerJobFeatures(req.user.role)) {

      return res.status(403).json({ message: 'Only job seekers can access this' });

    }

    const uid = new mongoose.Types.ObjectId(req.user.id);

    const saves = await JobSave.find({ userId: uid })

      .sort({ createdAt: -1 })

      .limit(100)

      .populate({ path: 'jobPostId' })

      .lean();



    const savesOut = saves

      .map((s) => {

        const j = s.jobPostId;

        if (!j || typeof j !== 'object' || !j._id) return null;

        if (j.status !== 'published') return null;

        return {

          savedAt: s.createdAt,

          job: mapJob(j),

        };

      })

      .filter(Boolean);



    return res.json({ saves: savesOut });

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

    if (req.user && canUseJobSeekerJobFeatures(req.user.role) && jobs.length > 0) {

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

  const jobIds = jobs.map((j) => j._id);
  let countByJob = {};
  if (jobIds.length > 0) {
    const countRows = await JobApplication.aggregate([
      { $match: { jobPostId: { $in: jobIds } } },
      { $group: { _id: '$jobPostId', applicationCount: { $sum: 1 } } },
    ]);
    countByJob = Object.fromEntries(
      countRows.map((r) => [r._id.toString(), r.applicationCount])
    );
  }

  return res.json({
    jobs: jobs.map((j) => ({
      ...mapJob(j),
      applicationCount: countByJob[j._id.toString()] || 0,
    })),
  });

});



/** Aggregated hiring KPIs for jobs the caller manages (company + its recruiters, or self).
 *  [candidatesReviewed] = total job applications received (all stages); interview/hired from [stage]. */

router.get('/mine/hiring-stats', requireAuth, async (req, res) => {

  if (!canManageJobs(req.user.role)) {

    return res.status(403).json({ message: 'Only recruiter/company/owner can access this' });

  }



  const q = {};

  if (req.user.role === 'company') {

    const recruiters = await User.find({ role: 'recruiter', companyId: req.user.id }).select('_id');

    const ids = [req.user.id, ...recruiters.map((u) => u._id.toString())];

    q.createdBy = { $in: ids };

  } else if (req.user.role === 'owner') {

    // all jobs

  } else {

    q.createdBy = req.user.id;

  }



  const jobPosts = await JobPost.find(q).select('_id').lean();

  const jobIds = jobPosts.map((j) => j._id);

  const jobsPosted = jobIds.length;



  if (jobIds.length === 0) {

    return res.json({

      jobsPosted: 0,

      candidatesReviewed: 0,

      interviewsScheduled: 0,

      hiredCandidates: 0,

    });

  }



  const agg = await JobApplication.aggregate([

    { $match: { jobPostId: { $in: jobIds } } },

    {

      $addFields: {

        stageNorm: { $ifNull: ['$stage', 'applied'] },

      },

    },

    {

      $group: {

        _id: null,

        candidatesReviewed: { $sum: 1 },

        interviewsScheduled: {

          $sum: { $cond: [{ $eq: ['$stageNorm', 'interview'] }, 1, 0] },

        },

        hiredCandidates: {

          $sum: { $cond: [{ $eq: ['$stageNorm', 'hired'] }, 1, 0] },

        },

      },

    },

  ]);



  const row = agg[0] || {};

  const candidatesReviewed = row.candidatesReviewed || 0;
  const interviewsScheduled = row.interviewsScheduled || 0;
  const hiredCandidates = row.hiredCandidates || 0;

  return res.json({
    jobsPosted,
    candidatesReviewed,
    interviewsScheduled,
    hiredCandidates,
  });

});



/** List applicants for a job post (company / recruiter / owner). */
router.get(
  '/:jobId/applications',
  requireAuth,
  [param('jobId').custom((value) => mongoose.Types.ObjectId.isValid(value))],
  async (req, res) => {
    if (!canManageJobs(req.user.role)) {
      return res.status(403).json({ message: 'Only recruiter/company/owner can view applications' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const job = await JobPost.findById(req.params.jobId);
    if (!job) return res.status(404).json({ message: 'Job not found' });

    const allowed = await userOwnsOrCompanyOwnsJob(req.user, job);
    if (!allowed) {
      return res.status(403).json({ message: 'You can only view applications for your jobs' });
    }

    const apps = await JobApplication.find({ jobPostId: job._id })
      .sort({ createdAt: -1 })
      .populate({ path: 'userId', select: 'name email phone bdId' })
      .lean();

    const applications = apps
      .filter((a) => a.userId && typeof a.userId === 'object' && a.userId._id)
      .map((a) => {
        const u = a.userId;
        return {
          id: a._id.toString(),
          userId: u._id.toString(),
          applicantName: u.name || '',
          applicantEmail: u.email || '',
          applicantPhone: u.phone || '',
          bdId: u.bdId || '',
          stage: a.stage || 'applied',
          appliedAt: a.createdAt,
        };
      });

    return res.json({
      job: mapJob(job),
      applications,
      stages: applicationStages,
    });
  }
);

router.patch(

  '/:jobId/applications/:userId/stage',

  requireAuth,

  [

    param('jobId').custom((value) => mongoose.Types.ObjectId.isValid(value)),

    param('userId').custom((value) => mongoose.Types.ObjectId.isValid(value)),

    body('stage').isIn(applicationStages),

  ],

  async (req, res) => {

    if (!canManageJobs(req.user.role)) {

      return res.status(403).json({ message: 'Only recruiter/company/owner can update applications' });

    }

    const errors = validationResult(req);

    if (!errors.isEmpty()) return sendValidationError(res, errors);



    const job = await JobPost.findById(req.params.jobId);

    if (!job) return res.status(404).json({ message: 'Job not found' });



    const allowed = await userOwnsOrCompanyOwnsJob(req.user, job);

    if (!allowed) {

      return res.status(403).json({ message: 'You can only manage applications for your jobs' });

    }



    const seekerId = new mongoose.Types.ObjectId(req.params.userId);

    const appDoc = await JobApplication.findOne({ jobPostId: job._id, userId: seekerId });

    if (!appDoc) return res.status(404).json({ message: 'Application not found' });



    appDoc.stage = req.body.stage;

    await appDoc.save();

    return res.json({ ok: true, stage: appDoc.stage });

  }

);



router.post(

  '/',

  requireAuth,

  [

    body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 140 }),

    body('description').optional().trim().isLength({ max: 4000 }),

    body('jobPosition').trim().notEmpty().withMessage('Job position is required').isLength({ max: 140 }),

    body('location').trim().notEmpty().withMessage('Location is required').isLength({ max: 180 }),

    body('workplace').optional().trim().isLength({ max: 80 }),

    body('employmentType').optional().trim().isLength({ max: 80 }),

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

    if (!canUseJobSeekerJobFeatures(req.user.role)) {

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

    if (!canUseJobSeekerJobFeatures(req.user.role)) {

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

    body('workplace').optional().trim().isLength({ max: 80 }),

    body('employmentType').optional().trim().isLength({ max: 80 }),

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

