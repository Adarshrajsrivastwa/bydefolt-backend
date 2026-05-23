import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { UserNotification } from '../models/UserNotification.js';
import { User } from '../models/User.js';
import { CompanyProfile } from '../models/CompanyProfile.js';

const router = Router();

router.use(requireAuth);

function sendValidationError(res, errors) {
  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
}

async function companyNamesForIds(companyIds) {
  const profiles = companyIds.length
    ? await CompanyProfile.find({ userId: { $in: companyIds } })
        .select('userId companyDisplayName legalRegisteredName')
        .lean()
    : [];
  const users = companyIds.length
    ? await User.find({ _id: { $in: companyIds } }).select('name').lean()
    : [];

  const nameByCompany = new Map();
  for (const p of profiles) {
    const id = p.userId?.toString?.() || '';
    const n =
      String(p.companyDisplayName || '').trim() ||
      String(p.legalRegisteredName || '').trim();
    if (id && n) nameByCompany.set(id, n);
  }
  for (const u of users) {
    const id = u._id.toString();
    if (!nameByCompany.has(id) && u.name) {
      nameByCompany.set(id, String(u.name).trim());
    }
  }
  return nameByCompany;
}

function mapNotificationRow(r, nameByCompany, userId) {
  const cid = r.companyUserId?.toString?.() || '';
  const isPlatform = Boolean(r.isPlatformBroadcast);
  const sentBy = r.sentBy?.toString?.() || '';
  const batchId = r.noticeBatchId?.toString?.() || '';
  const sentByMe = sentBy.length > 0 && sentBy === userId;
  return {
    id: r._id.toString(),
    title: r.title || '',
    body: r.body || '',
    imageUrl: r.imageUrl || '',
    audience: r.audience || 'all',
    companyUserId: cid,
    companyName: isPlatform ? 'ByDefolt' : nameByCompany.get(cid) || '',
    isPlatformBroadcast: isPlatform,
    readAt: r.readAt,
    createdAt: r.createdAt,
    sentBy,
    sentByMe,
    noticeBatchId: batchId,
    canEdit: sentByMe && batchId.length > 0,
  };
}

/** Inbox for the signed-in user (job seeker, HR, company, owner, etc.). */
router.get('/my', async (req, res) => {
  const userId = req.user.id;
  const rows = await UserNotification.find({ recipientId: userId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const companyIds = [
    ...new Set(
      rows
        .map((r) => r.companyUserId?.toString?.() || '')
        .filter((id) => id.length > 0)
    ),
  ];

  const nameByCompany = await companyNamesForIds(companyIds);

  const notifications = rows.map((r) => mapNotificationRow(r, nameByCompany, userId));

  const unreadCount = notifications.filter((n) => !n.readAt).length;
  return res.json({ notifications, unreadCount });
});

router.get(
  '/:notificationId',
  [param('notificationId').isMongoId().withMessage('Invalid notification id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const row = await UserNotification.findOne({
      _id: req.params.notificationId,
      recipientId: req.user.id,
    }).lean();
    if (!row) return res.status(404).json({ message: 'Notification not found' });

    const cid = row.companyUserId?.toString?.() || '';
    const nameByCompany = await companyNamesForIds(cid ? [cid] : []);
    return res.json({
      notification: mapNotificationRow(row, nameByCompany, req.user.id),
    });
  }
);

router.patch('/:notificationId/read', async (req, res) => {
  const doc = await UserNotification.findOne({
    _id: req.params.notificationId,
    recipientId: req.user.id,
  });
  if (!doc) return res.status(404).json({ message: 'Notification not found' });
  if (!doc.readAt) {
    doc.readAt = new Date();
    await doc.save();
  }
  return res.json({ ok: true });
});

/** Update all copies of a notice the current user sent (same noticeBatchId). */
router.patch(
  '/batch/:batchId',
  [
    param('batchId').isMongoId().withMessage('Invalid batch id'),
    body('title').optional().isString().trim().isLength({ min: 1, max: 200 }),
    body('body').optional().isString().trim().isLength({ min: 1, max: 4000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const batchId = req.params.batchId;
    const title = req.body.title != null ? String(req.body.title).trim() : '';
    const bodyText = req.body.body != null ? String(req.body.body).trim() : '';
    if (!title && !bodyText) {
      return res.status(400).json({ message: 'Provide title and/or body to update' });
    }

    const owned = await UserNotification.findOne({
      noticeBatchId: batchId,
      sentBy: req.user.id,
    }).lean();
    if (!owned) {
      return res.status(403).json({ message: 'You can only update notices you sent' });
    }

    const update = {};
    if (title) update.title = title;
    if (bodyText) update.body = bodyText;

    const result = await UserNotification.updateMany(
      { noticeBatchId: batchId, sentBy: req.user.id },
      { $set: update }
    );

    const sample = await UserNotification.findOne({
      recipientId: req.user.id,
      noticeBatchId: batchId,
    }).lean();

    let notification = null;
    if (sample) {
      const cid = sample.companyUserId?.toString?.() || '';
      const nameByCompany = await companyNamesForIds(cid ? [cid] : []);
      notification = mapNotificationRow(sample, nameByCompany, req.user.id);
    }

    return res.json({
      updatedCount: result.modifiedCount ?? 0,
      notification,
    });
  }
);

export { router as notificationsRouter };
