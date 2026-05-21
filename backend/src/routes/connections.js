import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { body, param, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { Connection } from '../models/Connection.js';
import { CompanyFollow } from '../models/CompanyFollow.js';
import { ChatMessage } from '../models/ChatMessage.js';
import { JobSeekerProfile } from '../models/JobSeekerProfile.js';
import { effectiveConnectionField } from '../util/connectionField.js';
import {
  CONNECTION_TARGET_ROLES,
  FOLLOW_TARGET_ROLES,
  isConnectionTargetRole,
  isDmPartner,
  isFollowTargetRole,
  MEMBER_NETWORK_ROLES,
  pickConnectionPartner,
} from '../util/memberNetwork.js';
import { ensureBdId } from '../services/bdId.js';
import {
  connectionStatsForUser,
  countCompanyFollows,
  countProfessionalConnections,
} from '../services/memberNetworkStats.js';

const router = Router();
const chatUploadDir = path.join(process.cwd(), 'uploads', 'chat');
fs.mkdirSync(chatUploadDir, { recursive: true });

const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, chatUploadDir),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'attachment').replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`);
    },
  }),
  // Allow most common documents/media while keeping a sane cap.
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function sendValidationError(res, errors) {
  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
}

function requireConnectionsAccess(req, res, next) {
  if (!MEMBER_NETWORK_ROLES.has(req.user.role)) {
    return res.status(403).json({ message: 'Connections are not available for this account' });
  }
  return next();
}

async function partnerPhotoMap(partnerRows) {
  const seekerIds = partnerRows
    .filter(
      ({ partner }) =>
        partner &&
        typeof partner === 'object' &&
        partner._id &&
        partner.role === 'jobSeeker'
    )
    .map(({ partner }) => partner._id);
  if (seekerIds.length === 0) return new Map();
  const profiles = await JobSeekerProfile.find({ userId: { $in: seekerIds } })
    .select('userId profilePhotoUrl')
    .lean();
  return new Map(profiles.map((p) => [String(p.userId), p.profilePhotoUrl || '']));
}

function displayUserName(u) {
  if (!u) return '';
  const o = typeof u.toObject === 'function' ? u.toObject() : u;
  const name = String(o.name ?? '').trim();
  if (name) return name;
  const email = String(o.email ?? '').trim().toLowerCase();
  if (email.includes('@')) {
    const local = email.split('@')[0]?.trim();
    if (local) return local.charAt(0).toUpperCase() + local.slice(1);
  }
  const bdId = String(o.bdId ?? '').trim();
  return bdId;
}

function userCard(u) {
  if (!u) return null;
  const o = typeof u.toObject === 'function' ? u.toObject() : u;
  const bdId = String(o.bdId ?? '').trim();
  if (!bdId) return null;
  const name = displayUserName(o);
  return {
    bdId,
    name: name || bdId,
    headline: o.headline || '',
    field: effectiveConnectionField(o),
  };
}

function cardFromStoredPreview(preview) {
  if (!preview) return null;
  const bdId = String(preview.bdId ?? '').trim();
  if (!bdId) return null;
  const name = String(preview.name ?? '').trim() || bdId;
  return {
    bdId,
    name,
    headline: preview.headline || '',
    field: preview.field || '',
  };
}

async function memberPreviewForUser(u, photoMap) {
  const card = userCard(u);
  if (!card || !u) return null;
  const id = String(u._id ?? '');
  const photo =
    u.role === 'jobSeeker' && id ? photoMap.get(id) || '' : '';
  return {
    ...card,
    role: u.role || 'jobSeeker',
    profilePhotoUrl: photo,
  };
}

async function listFollowingForUser(userId) {
  const rows = await CompanyFollow.find({ follower: userId })
    .sort({ createdAt: -1 })
    .lean();
  if (rows.length === 0) return [];

  const companyIds = rows.map((r) => r.company);
  const companies = await User.find({
    _id: { $in: companyIds },
    role: 'company',
  })
    .select('name bdId headline connectionField role companyStatus')
    .lean();
  const byId = new Map(companies.map((c) => [String(c._id), c]));

  return rows
    .map((row) => {
      const company = byId.get(String(row.company));
      if (!company) return null;
      const card = userCard(company);
      if (!card) return null;
      return {
        followId: String(row._id),
        ...card,
        role: 'company',
        profilePhotoUrl: '',
      };
    })
    .filter(Boolean);
}

async function buildMemberPreviews(me, target) {
  const photoMap = await partnerPhotoMap([
    { partner: me },
    { partner: target },
  ]);
  const fromPreview = await memberPreviewForUser(me, photoMap);
  const toPreview = await memberPreviewForUser(target, photoMap);
  return { fromPreview, toPreview };
}

async function usersByObjectIds(ids) {
  const unique = [
    ...new Set(
      ids
        .map((id) => String(id ?? '').trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];
  if (unique.length === 0) return new Map();
  const users = await User.find({ _id: { $in: unique } })
    .select('name bdId headline connectionField role email')
    .lean();
  return new Map(users.map((u) => [String(u._id), u]));
}

function resolvePartnerUser(partnerRef, userMap) {
  if (!partnerRef) return null;
  if (typeof partnerRef === 'object' && partnerRef._id) {
    const id = String(partnerRef._id);
    const fromMap = userMap.get(id);
    if (fromMap) return fromMap;
    if (partnerRef.bdId) return partnerRef;
  }
  const id = String(partnerRef);
  if (mongoose.Types.ObjectId.isValid(id)) return userMap.get(id) ?? null;
  return null;
}

function mapPendingConnectionRow(d, me, direction, userMap, photoMap) {
  const partnerRef = direction === 'incoming' ? d.from : d.to;
  const storedPreview = direction === 'incoming' ? d.fromPreview : d.toPreview;
  const partner = resolvePartnerUser(partnerRef, userMap);
  if (!partner || !isDmPartner(me.role, partner.role)) return null;

  let card = cardFromStoredPreview(storedPreview);
  let role = storedPreview?.role || partner.role || 'jobSeeker';
  let profilePhotoUrl = storedPreview?.profilePhotoUrl || '';

  if (!card) {
    card = userCard(partner);
    if (!card) return null;
    role = partner.role || 'jobSeeker';
    profilePhotoUrl =
      partner.role === 'jobSeeker'
        ? photoMap.get(String(partner._id)) || ''
        : '';
    const previewField = direction === 'incoming' ? 'fromPreview' : 'toPreview';
    void Connection.updateOne(
      { _id: d._id },
      {
        $set: {
          [previewField]: {
            ...card,
            role,
            profilePhotoUrl,
          },
        },
      }
    ).catch(() => {});
  }

  return {
    requestId: String(d._id),
    ...card,
    role,
    profilePhotoUrl,
  };
}

function mapChatMessage(doc, meId) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(o._id),
    connectionId: String(o.connection),
    senderId: String(o.sender),
    isMine: String(o.sender) === String(meId),
    text: o.text || '',
    attachments: (o.attachments || []).map((a) => ({
      url: a.url || '',
      name: a.name || '',
      mimeType: a.mimeType || '',
      size: a.size || 0,
      kind: a.kind || 'file',
    })),
    createdAt: o.createdAt,
  };
}

async function findAcceptedConnectionForMe(connectionId, meId) {
  if (!mongoose.Types.ObjectId.isValid(connectionId)) return null;
  return Connection.findOne({
    _id: new mongoose.Types.ObjectId(connectionId),
    status: 'accepted',
    $or: [{ from: meId }, { to: meId }],
  });
}

/** Fisher–Yates shuffle (copy). */
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

router.use(requireAuth, requireConnectionsAccess);

router.get('/member-stats/:bdId', async (req, res) => {
  const bdId = String(req.params.bdId || '').trim().toUpperCase();
  if (!bdId) return res.status(400).json({ message: 'BD ID is required' });

  const target = await User.findOne({ bdId }).select('_id role');
  if (!target) return res.status(404).json({ message: 'Member not found' });

  const stats = await connectionStatsForUser(target._id);
  return res.json({ bdId, ...stats });
});

router.get('/', async (req, res) => {
  const me = await User.findById(req.user.id);
  if (!me) return res.status(404).json({ message: 'User not found' });
  const bdId = await ensureBdId(me);

  const incomingDocs = await Connection.find({ to: me._id, status: 'pending' })
    .populate('from', 'name bdId headline connectionField role email')
    .sort({ createdAt: -1 })
    .lean();

  const outgoingDocs = await Connection.find({ from: me._id, status: 'pending' })
    .populate('to', 'name bdId headline connectionField role email')
    .sort({ createdAt: -1 })
    .lean();

  const partnerIds = [
    ...incomingDocs.map((d) => d.from?._id ?? d.from),
    ...outgoingDocs.map((d) => d.to?._id ?? d.to),
  ];
  const userMap = await usersByObjectIds(partnerIds);

  const incomingPhotoMap = await partnerPhotoMap(
    incomingDocs
      .map((d) => ({ partner: resolvePartnerUser(d.from, userMap) }))
      .filter((x) => x.partner)
  );
  const outgoingPhotoMap = await partnerPhotoMap(
    outgoingDocs
      .map((d) => ({ partner: resolvePartnerUser(d.to, userMap) }))
      .filter((x) => x.partner)
  );

  const incoming = incomingDocs
    .map((d) => mapPendingConnectionRow(d, me, 'incoming', userMap, incomingPhotoMap))
    .filter(Boolean);

  const outgoing = outgoingDocs
    .map((d) => mapPendingConnectionRow(d, me, 'outgoing', userMap, outgoingPhotoMap))
    .filter(Boolean);

  const [connectedCount, followingCount, following] = await Promise.all([
    countProfessionalConnections(me._id),
    countCompanyFollows(me._id),
    listFollowingForUser(me._id),
  ]);

  return res.json({
    bdId,
    headline: me.headline || '',
    connectionField: effectiveConnectionField(me),
    connectedCount,
    followingCount,
    following,
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
      role: { $in: [...CONNECTION_TARGET_ROLES] },
      _id: { $ne: me._id },
    })
      .select('name bdId headline connectionField role email')
      .limit(600)
      .lean();

    const suggestions = [];
    const seenIds = new Set();

    for (const u of candidates) {
      if (excluded.has(String(u._id))) continue;
      if (effectiveConnectionField(u) !== myField) continue;
      const label = displayUserName(u);
      suggestions.push({
        bdId: u.bdId,
        name: label || u.bdId,
        headline: u.headline || '',
        field: effectiveConnectionField(u),
        role: u.role || 'jobSeeker',
      });
      seenIds.add(String(u._id));
      if (suggestions.length >= limit) break;
    }

    let discoverFallback = false;
    if (suggestions.length < limit) {
      const rest = candidates.filter((u) => !excluded.has(String(u._id)) && !seenIds.has(String(u._id)));
      const shuffled = shuffleArray(rest);
      for (const u of shuffled) {
        if (suggestions.length >= limit) break;
        const label = displayUserName(u);
        suggestions.push({
          bdId: u.bdId,
          name: label || u.bdId,
          headline: u.headline || '',
          field: effectiveConnectionField(u),
          role: u.role || 'jobSeeker',
        });
        seenIds.add(String(u._id));
        discoverFallback = true;
      }
    }

    const suggestionUsers = candidates.filter((u) =>
      suggestions.some((s) => s.bdId === u.bdId)
    );
    const sugPhotoMap = await partnerPhotoMap(
      suggestionUsers.map((u) => ({ partner: u }))
    );
    const enrichedSuggestions = suggestions.map((s) => {
      const u = suggestionUsers.find((c) => c.bdId === s.bdId);
      const photo =
        u && u.role === 'jobSeeker'
          ? sugPhotoMap.get(String(u._id)) || ''
          : '';
      return { ...s, profilePhotoUrl: photo };
    });

    return res.json({
      field: myField,
      suggestions: enrichedSuggestions,
      discoverFallback,
    });
});

router.get('/accepted', async (req, res) => {
  const me = await User.findById(req.user.id);
  if (!me) return res.status(404).json({ message: 'User not found' });

  const docs = await Connection.find({
    status: 'accepted',
    $or: [{ from: me._id }, { to: me._id }],
  })
    .populate('from', 'name bdId headline connectionField role')
    .populate('to', 'name bdId headline connectionField role')
    .sort({ updatedAt: -1 })
    .lean();

  const rows = [];
  for (const d of docs) {
    const picked = pickConnectionPartner(me, d);
    if (picked) rows.push(picked);
  }

  const photoByUser = await partnerPhotoMap(rows);

  const connections = rows.map(({ doc, partner }) => {
    const o = partner;
    const id = String(o._id);
    return {
      connectionId: String(doc._id),
      bdId: o.bdId,
      name: displayUserName(o),
      headline: o.headline || '',
      field: effectiveConnectionField(o),
      profilePhotoUrl: photoByUser.get(id) || '',
    };
  });

  return res.json({ connections });
});

function previewFromChatMessage(msg) {
  if (!msg) return '';
  const t = String(msg.text || '').trim();
  if (t) return t.slice(0, 240);
  const att = (msg.attachments || [])[0];
  if (att?.name) return `Attachment: ${String(att.name).slice(0, 120)}`;
  return 'Sent an attachment';
}

function lastReadAtForUser(connectionDoc, meId) {
  const meStr = String(meId);
  const fromId = String(connectionDoc.from?._id ?? connectionDoc.from);
  const toId = String(connectionDoc.to?._id ?? connectionDoc.to);
  if (meStr === fromId) return connectionDoc.lastReadAtFrom ?? null;
  if (meStr === toId) return connectionDoc.lastReadAtTo ?? null;
  return null;
}

async function unreadCountForConnection(connectionDoc, meId) {
  const connectionId = connectionDoc._id;
  const lastRead = lastReadAtForUser(connectionDoc, meId);
  const query = {
    connection: connectionId,
    sender: { $ne: meId },
  };
  if (lastRead) {
    query.createdAt = { $gt: lastRead };
  }
  return ChatMessage.countDocuments(query);
}

router.get('/inbox', async (req, res) => {
  const me = await User.findById(req.user.id);
  if (!me) return res.status(404).json({ message: 'User not found' });

  const docs = await Connection.find({
    status: 'accepted',
    $or: [{ from: me._id }, { to: me._id }],
  })
    .populate('from', 'name bdId headline connectionField role')
    .populate('to', 'name bdId headline connectionField role')
    .sort({ updatedAt: -1 })
    .lean();

  const rows = [];
  for (const d of docs) {
    const picked = pickConnectionPartner(me, d);
    if (picked) rows.push(picked);
  }

  const photoByUser = await partnerPhotoMap(rows);

  const threads = await Promise.all(
    rows.map(async ({ doc, partner }) => {
      const id = String(partner._id);
      const connectionId = doc._id;
      const lastMsg = await ChatMessage.findOne({ connection: connectionId })
        .sort({ createdAt: -1, _id: -1 })
        .lean();
      const unreadCount = await unreadCountForConnection(doc, me._id);
      let preview = previewFromChatMessage(lastMsg);
      if (!preview) {
        const headline = partner.headline || '';
        const field = effectiveConnectionField(partner);
        preview = headline.trim() || (field ? `Connected · ${field}` : 'Start a conversation');
      }
      return {
        connectionId: String(connectionId),
        bdId: partner.bdId,
        name: displayUserName(partner),
        headline: partner.headline || '',
        field: effectiveConnectionField(partner),
        profilePhotoUrl: photoByUser.get(id) || '',
        preview,
        lastMessageAt: lastMsg?.createdAt ?? doc.updatedAt ?? doc.createdAt,
        unreadCount,
      };
    })
  );

  threads.sort((a, b) => {
    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return tb - ta;
  });

  return res.json({ threads });
});

router.post(
  '/:connectionId/mark-read',
  [param('connectionId').isMongoId().withMessage('Invalid connection id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const connection = await findAcceptedConnectionForMe(req.params.connectionId, me._id);
    if (!connection) return res.status(404).json({ message: 'Connection not found' });

    const now = new Date();
    const meStr = String(me._id);
    const fromId = String(connection.from);
    const update =
      meStr === fromId
        ? { lastReadAtFrom: now }
        : meStr === String(connection.to)
          ? { lastReadAtTo: now }
          : null;
    if (!update) return res.status(400).json({ message: 'Invalid connection participant' });

    await Connection.updateOne({ _id: connection._id }, { $set: update });
    return res.json({ ok: true });
  }
);

router.get(
  '/:connectionId/messages',
  [param('connectionId').isMongoId().withMessage('Invalid connection id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const connection = await findAcceptedConnectionForMe(req.params.connectionId, me._id);
    if (!connection) return res.status(404).json({ message: 'Connection not found' });

    const after = String(req.query.after || '').trim();
    const query = { connection: connection._id };
    if (after && mongoose.Types.ObjectId.isValid(after)) {
      query._id = { $gt: new mongoose.Types.ObjectId(after) };
    }

    const messages = await ChatMessage.find(query).sort({ createdAt: 1, _id: 1 }).limit(150).lean();
    return res.json({ messages: messages.map((m) => mapChatMessage(m, me._id)) });
  }
);

router.post(
  '/:connectionId/messages',
  [param('connectionId').isMongoId().withMessage('Invalid connection id')],
  (req, res, next) => {
    chatUpload.single('attachment')(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message || 'Attachment upload failed' });
      return next();
    });
  },
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const connection = await findAcceptedConnectionForMe(req.params.connectionId, me._id);
    if (!connection) return res.status(404).json({ message: 'Connection not found' });

    const text = String(req.body?.text || '').trim().slice(0, 4000);
    const attachments = [];
    if (req.file) {
      attachments.push({
        url: `/uploads/chat/${req.file.filename}`,
        name: req.file.originalname || req.file.filename,
        mimeType: req.file.mimetype || '',
        size: req.file.size || 0,
        kind: String(req.file.mimetype || '').startsWith('image/') ? 'image' : 'file',
      });
    }
    if (!text && attachments.length === 0) {
      return res.status(400).json({ message: 'Write a message or add an attachment' });
    }

    const msg = await ChatMessage.create({
      connection: connection._id,
      sender: me._id,
      text,
      attachments,
    });

    return res.status(201).json({ message: mapChatMessage(msg, me._id) });
  }
);

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
    if (!target) {
      return res.status(404).json({ message: 'No account found with that BD ID' });
    }
    if (String(target._id) === String(me._id)) {
      return res.status(400).json({ message: 'You cannot connect with yourself' });
    }

    if (isFollowTargetRole(target.role)) {
      if (target.companyStatus && target.companyStatus !== 'approved') {
        return res.status(404).json({ message: 'This company is not available to follow yet' });
      }
      const existing = await CompanyFollow.findOne({
        follower: me._id,
        company: target._id,
      });
      if (existing) {
        return res.status(409).json({ message: 'You are already following this company' });
      }
      const doc = await CompanyFollow.create({
        follower: me._id,
        company: target._id,
      });
      const card = userCard(target);
      return res.status(201).json({
        ok: true,
        kind: 'following',
        message: 'Now following this company',
        followId: String(doc._id),
        company: card
          ? { ...card, role: 'company', followId: String(doc._id) }
          : null,
      });
    }

    if (!isConnectionTargetRole(target.role)) {
      return res.status(400).json({
        message:
          'Company accounts are followed (one-way). Connection requests are for job seekers and HR only.',
        hint: {
          followRoles: [...FOLLOW_TARGET_ROLES],
          connectionRoles: [...CONNECTION_TARGET_ROLES],
        },
      });
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
      const previews = await buildMemberPreviews(me, target);
      if (previews.fromPreview) doc.fromPreview = previews.fromPreview;
      if (previews.toPreview) doc.toPreview = previews.toPreview;
      await doc.save();
      return res.status(201).json({ ok: true, message: 'Connection request sent' });
    }

    const previews = await buildMemberPreviews(me, target);
    await Connection.create({
      from: me._id,
      to: target._id,
      status: 'pending',
      fromPreview: previews.fromPreview,
      toPreview: previews.toPreview,
    });
    return res.status(201).json({
      ok: true,
      kind: 'connection',
      message: 'Connection request sent',
    });
  }
);

router.get('/following', async (req, res) => {
  const me = await User.findById(req.user.id);
  if (!me) return res.status(404).json({ message: 'User not found' });
  const following = await listFollowingForUser(me._id);
  return res.json({ following, count: following.length });
});

router.delete(
  '/follow/:bdId',
  [param('bdId').trim().notEmpty().withMessage('bdId is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const bdId = String(req.params.bdId).toUpperCase().trim();
    const company = await User.findOne({ bdId, role: 'company' }).select('_id');
    if (!company) return res.status(404).json({ message: 'Company not found' });

    const result = await CompanyFollow.deleteOne({
      follower: me._id,
      company: company._id,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'You are not following this company' });
    }
    return res.json({ ok: true, message: 'Unfollowed company' });
  }
);

router.get(
  '/partner/:requestId',
  [param('requestId').isMongoId().withMessage('Invalid request id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const doc = await Connection.findById(req.params.requestId).lean();
    if (!doc || doc.status !== 'pending') {
      return res.status(404).json({ message: 'Request not found' });
    }

    const meStr = String(me._id);
    const fromStr = String(doc.from);
    const toStr = String(doc.to);
    if (fromStr !== meStr && toStr !== meStr) {
      return res.status(403).json({ message: 'Not allowed' });
    }

    const partnerId = fromStr === meStr ? doc.to : doc.from;
    const userMap = await usersByObjectIds([partnerId]);
    const partner = userMap.get(String(partnerId));
    if (!partner || !isDmPartner(me.role, partner.role)) {
      return res.status(404).json({ message: 'Member not found' });
    }

    const card = userCard(partner);
    if (!card) return res.status(404).json({ message: 'Member not found' });

    const photoMap = await partnerPhotoMap([{ partner }]);
    const photo =
      partner.role === 'jobSeeker'
        ? photoMap.get(String(partner._id)) || ''
        : '';

    return res.json({
      requestId: String(doc._id),
      ...card,
      role: partner.role || 'jobSeeker',
      profilePhotoUrl: photo,
    });
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

router.delete(
  '/:connectionId',
  [param('connectionId').isMongoId().withMessage('Invalid connection id')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidationError(res, errors);

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: 'User not found' });

    const doc = await Connection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.connectionId),
      status: 'accepted',
      $or: [{ from: me._id }, { to: me._id }],
    });

    if (!doc) {
      return res.status(404).json({ message: 'Connection not found' });
    }

    await Connection.deleteOne({ _id: doc._id });
    return res.json({ ok: true, message: 'Disconnected' });
  }
);

export { router as connectionsRouter };
