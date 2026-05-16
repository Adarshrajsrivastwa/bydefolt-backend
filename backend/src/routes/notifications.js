import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { UserNotification } from '../models/UserNotification.js';
import { User } from '../models/User.js';
import { CompanyProfile } from '../models/CompanyProfile.js';

const router = Router();

router.use(requireAuth);

/** Inbox for the signed-in user (job seeker, HR, company, etc.). */
router.get('/my', async (req, res) => {
  const recipientOid = req.user.id;
  const rows = await UserNotification.find({ recipientId: recipientOid })
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

  const notifications = rows.map((r) => {
    const cid = r.companyUserId?.toString?.() || '';
    const isPlatform = Boolean(r.isPlatformBroadcast);
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
    };
  });

  const unreadCount = notifications.filter((n) => !n.readAt).length;
  return res.json({ notifications, unreadCount });
});

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

export { router as notificationsRouter };
