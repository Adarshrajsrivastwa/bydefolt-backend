import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { Connection } from '../models/Connection.js';
import { effectiveConnectionField } from '../util/connectionField.js';
import { ensureBdId } from '../services/bdId.js';

const router = Router();

function sendValidationError(res, errors) {
  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
}

function requireJobSeeker(req, res, next) {
  if (req.user.role !== 'jobSeeker') {
    return res.status(403).json({ message: 'Connections are available for job seekers only' });
  }
  return next();
}

function userCard(u) {
  if (!u) return null;
  const o = typeof u.toObject === 'function' ? u.toObject() : u;
  return {
    bdId: o.bdId,
    name: o.name,
    headline: o.headline || '',
    field: effectiveConnectionField(o),
  };
}

async function excludedPartnerIds(meId) {
  const edges = await Connection.find({
    $or: [{ from: meId }, { to: meId }],
    status: { $in: ['pending', 'accepted'] },
  })
    .select('from to')
    .lean();

  const out = new Set();
  const mid = String(meId);
  for (const e of edges) {
    const a = String(e.from);
    const b = String(e.to);
    out.add(a === mid ? b : a);
  }
  return out;
}

router.use(requireAuth, requireJobSeeker);

router.get('/', async (req, res) => {
  const me = await User.findById(req.user.id);
  if (!me) return res.status(404).json({ message: 'User not found' });
  const bdId = await ensureBdId(me);

  const incomingDocs = await Connection.find({ to: me._id, status: 'pending' })
    .populate('from', 'name bdId headline connectionField role')
    .sort({ createdAt: -1 })
    .lean();

  const incoming = incomingDocs
    .map((d) => {
      const from = d.from;
      if (!from || from.role !== 'jobSeeker') return null;
      const card = userCard(from);
      return card ? { requestId: String(d._id), ...card } : null;
    })
    .filter(Boolean);

  const outgoingDocs = await Connection.find({ from: me._id, status: 'pending' })
    .populate('to', 'name bdId headline connectionField role')
    .sort({ createdAt: -1 })
    .lean();

  const outgoing = outgoingDocs
    .map((d) => {
      const to = d.to;
      if (!to || to.role !== 'jobSeeker') return null;
      const card = userCard(to);
      return card ? { requestId: String(d._id), ...card } : null;
    })
    .filter(Boolean);

  const acceptedCount = await Connection.countDocuments({
    $or: [{ from: me._id }, { to: me._id }],
    status: 'accepted',
  });

  return res.json({
    bdId,
    headline: me.headline || '',
    connectionField: effectiveConnectionField(me),
    connectedCount: acceptedCount,
    incoming,
    outgoing,
  });
});

router.get('/suggestions', async (req, res) => {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });
    await ensureBdId(me);

    const myField = effectiveConnectionField(me);
    let limit = Number.parseInt(String(req.query.limit ?? '12'), 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 12;
    if (limit > 50) limit = 50;

    const excluded = await excludedPartnerIds(me._id);

    const candidates = await User.find({
      role: 'jobSeeker',
      _id: { $ne: me._id },
    })
      .select('name bdId headline connectionField')
      .limit(600)
      .lean();

    const suggestions = [];
    for (const u of candidates) {
      if (excluded.has(String(u._id))) continue;
      if (effectiveConnectionField(u) !== myField) continue;
      suggestions.push({
        bdId: u.bdId,
        name: u.name,
        headline: u.headline || '',
        field: effectiveConnectionField(u),
      });
      if (suggestions.length >= limit) break;
    }

    return res.json({ field: myField, suggestions });
});

router.post(
  '/request',
  [body('targetBdId').trim().notEmpty().withMessage('targetBdId is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });
    await ensureBdId(me);

    const targetBd = String(req.body.targetBdId).toUpperCase().trim();
    const target = await User.findOne({ bdId: targetBd });
    if (!target || target.role !== 'jobSeeker') {
      return res.status(404).json({ message: 'No job seeker found with that BD ID' });
    }
    if (String(target._id) === String(me._id)) {
      return res.status(400).json({ message: 'You cannot connect with yourself' });
    }

    const connected = await Connection.exists({
      status: 'accepted',
      $or: [
        { from: me._id, to: target._id },
        { from: target._id, to: me._id },
      ],
    });
    if (connected) {
      return res.status(409).json({ message: 'You are already connected' });
    }

    const themToMePending = await Connection.findOne({
      from: target._id,
      to: me._id,
      status: 'pending',
    });
    if (themToMePending) {
      return res.status(409).json({
        message: 'This person already sent you a request — accept it from your inbox',
      });
    }

    let doc = await Connection.findOne({ from: me._id, to: target._id });
    if (doc) {
      if (doc.status === 'pending') {
        return res.status(409).json({ message: 'Request already sent' });
      }
      if (doc.status === 'accepted') {
        return res.status(409).json({ message: 'You are already connected' });
      }
      doc.status = 'pending';
      await doc.save();
      return res.status(201).json({ ok: true, message: 'Connection request sent' });
    }

    await Connection.create({ from: me._id, to: target._id, status: 'pending' });
    return res.status(201).json({ ok: true, message: 'Connection request sent' });
  }
);

router.post(
  '/:requestId/withdraw',
  [param('requestId').isMongoId().withMessage('Invalid request id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const doc = await Connection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.requestId),
      from: me._id,
      status: 'pending',
    });

    if (!doc) {
      return res.status(404).json({ message: 'Request not found' });
    }

    await Connection.deleteOne({ _id: doc._id });
    return res.json({ ok: true, message: 'Request withdrawn' });
  }
);

router.post(
  '/:requestId/accept',
  [param('requestId').isMongoId().withMessage('Invalid request id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const doc = await Connection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.requestId),
      to: me._id,
      status: 'pending',
    });

    if (!doc) {
      return res.status(404).json({ message: 'Request not found' });
    }

    doc.status = 'accepted';
    await doc.save();
    return res.json({ ok: true, message: 'Connected' });
  }
);

router.post(
  '/:requestId/ignore',
  [param('requestId').isMongoId().withMessage('Invalid request id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const doc = await Connection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.requestId),
      to: me._id,
      status: 'pending',
    });

    if (!doc) {
      return res.status(404).json({ message: 'Request not found' });
    }

    doc.status = 'ignored';
    await doc.save();
    return res.json({ ok: true, message: 'Rejected' });
  }
);

router.post(
  '/:requestId/reject',
  [param('requestId').isMongoId().withMessage('Invalid request id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const doc = await Connection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.requestId),
      to: me._id,
      status: 'pending',
    });

    if (!doc) {
      return res.status(404).json({ message: 'Request not found' });
    }

    doc.status = 'ignored';
    await doc.save();
    return res.json({ ok: true, message: 'Rejected' });
  }
);

export { router as connectionsRouter };
