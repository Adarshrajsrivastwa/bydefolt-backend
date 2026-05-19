import { Router } from 'express';

import { param, validationResult } from 'express-validator';

import mongoose from 'mongoose';

import multer from 'multer';

import path from 'node:path';

import fs from 'node:fs';

import { requireAuth } from '../middleware/auth.js';

import { User } from '../models/User.js';

import { NetworkFeedPost } from '../models/NetworkFeedPost.js';

import { effectiveConnectionField } from '../util/connectionField.js';
import {
  CONNECTION_TARGET_ROLES,
  MEMBER_NETWORK_ROLES,
} from '../util/memberNetwork.js';
import { Connection } from '../models/Connection.js';
import { ensureBdId } from '../services/bdId.js';



const router = Router();



const feedUploadDir = path.join(process.cwd(), 'uploads', 'feed');

fs.mkdirSync(feedUploadDir, { recursive: true });



function isAllowedFeedImage(file) {

  const mime = String(file.mimetype || '').toLowerCase();

  const name = String(file.originalname || '').toLowerCase();

  if (/^image\/(jpeg|jpg|pjpeg|png|x-png|webp|gif)$/i.test(mime)) return true;

  if (mime === 'application/octet-stream' && /\.(jpe?g|png|webp|gif)$/i.test(name)) {

    return true;

  }

  return false;

}



const upload = multer({

  storage: multer.diskStorage({

    destination: (_req, _file, cb) => cb(null, feedUploadDir),

    filename: (_req, file, cb) => {

      const safe = String(file.originalname || 'img').replace(/[^a-zA-Z0-9.\-_]/g, '_');

      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`);

    },

  }),

  limits: { fileSize: 8 * 1024 * 1024, files: 10 },

  fileFilter: (_req, file, cb) => {

    const ok = isAllowedFeedImage(file);

    cb(

      ok ? null : new Error('Only JPEG, PNG, WebP, or GIF images are allowed'),

      ok

    );

  },

});



function feedUploadMiddleware(req, res, next) {

  upload.array('images', 10)(req, res, (err) => {

    if (err) {

      const msg = err && err.message ? String(err.message) : 'Invalid upload';

      return res.status(400).json({ message: msg });

    }

    return next();

  });

}



function sendValidationError(res, errors) {

  return res.status(400).json({ message: 'Validation failed', errors: errors.array() });

}



function requireFeedAccess(req, res, next) {
  if (!MEMBER_NETWORK_ROLES.has(req.user.role)) {
    return res.status(403).json({ message: 'Feed is not available for this account' });
  }
  return next();
}



/**
 * @param {import('mongoose').Types.ObjectId | string} meId
 * @param {string[]} authorIds
 * @returns {Promise<Map<string, { relation: string, requestId?: string }>>}
 */
async function buildAuthorRelationMap(meId, authorIds) {
  const meStr = String(meId);
  const unique = [
    ...new Set(
      authorIds.map((id) => String(id)).filter((id) => id && id !== meStr)
    ),
  ];
  const map = new Map();
  for (const id of unique) map.set(id, { relation: 'none' });
  if (unique.length === 0) return map;

  const objectIds = unique
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (objectIds.length === 0) return map;

  const edges = await Connection.find({
    $or: [
      { from: meId, to: { $in: objectIds } },
      { from: { $in: objectIds }, to: meId },
    ],
    status: { $in: ['pending', 'accepted'] },
  })
    .select('from to status')
    .lean();

  for (const e of edges) {
    const from = String(e.from);
    const to = String(e.to);
    const partner = from === meStr ? to : from;
    if (e.status === 'accepted') {
      map.set(partner, { relation: 'connected' });
    } else if (from === meStr) {
      map.set(partner, { relation: 'pending_out' });
    } else {
      map.set(partner, { relation: 'pending_in', requestId: String(e._id) });
    }
  }
  return map;
}

function serializePost(doc, relationMeta = { relation: 'none' }) {
  const a = doc.author;

  if (!a || !a._id) return null;

  const authorId = a._id.toString();
  const role = a.role || '';

  return {
    id: doc._id.toString(),
    body: doc.body ?? '',
    images: Array.isArray(doc.images) ? doc.images : [],
    connectionField: doc.connectionField,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    authorRelation: relationMeta.relation,
    connectionRequestId: relationMeta.requestId || '',
    canConnect: CONNECTION_TARGET_ROLES.has(role),
    author: {
      id: authorId,
      name: a.name,
      headline: a.headline || '',
      bdId: a.bdId || '',
      role,
    },
  };
}



function shuffleInPlace(arr) {

  for (let i = arr.length - 1; i > 0; i -= 1) {

    const j = Math.floor(Math.random() * (i + 1));

    [arr[i], arr[j]] = [arr[j], arr[i]];

  }

  return arr;

}



function unlinkFeedImage(urlPath) {

  if (!urlPath || typeof urlPath !== 'string') return;

  if (!urlPath.startsWith('/uploads/feed/')) return;

  const rel = urlPath.replace(/^\//, '');

  const full = path.join(process.cwd(), rel);

  if (!full.startsWith(feedUploadDir)) return;

  try {

    fs.unlinkSync(full);

  } catch {

    // ignore missing files

  }

}



router.use(requireAuth, requireFeedAccess);



router.get('/', async (req, res) => {

  const me = await User.findById(req.user.id);

  if (!me) return res.status(404).json({ message: 'User not found' });

  await ensureBdId(me);



  let limit = Number.parseInt(String(req.query.limit ?? '24'), 10);

  if (!Number.isFinite(limit) || limit < 1) limit = 24;

  if (limit > 50) limit = 50;



  const take = Math.min(120, Math.max(limit * 3, limit));

  const raw = await NetworkFeedPost.find({})

    .populate('author', 'name headline bdId connectionField role')

    .sort({ createdAt: -1 })

    .limit(take)

    .lean();



  const filtered = raw.filter((d) => d.author && d.author._id);

  const meId = String(me._id);
  const authorIds = filtered.map((d) => String(d.author._id));
  const relMap = await buildAuthorRelationMap(me._id, authorIds);

  const connected = [];
  const rest = [];
  for (const d of filtered) {
    const rel = relMap.get(String(d.author._id))?.relation ?? 'none';
    if (rel === 'connected') connected.push(d);
    else rest.push(d);
  }
  shuffleInPlace(connected);
  shuffleInPlace(rest);
  const ordered = [...connected, ...rest].slice(0, limit);

  const posts = ordered
    .map((d) => {
      const aid = String(d.author._id);
      const meta =
        aid === meId
          ? { relation: 'self' }
          : relMap.get(aid) ?? { relation: 'none' };
      return serializePost(d, meta);
    })
    .filter(Boolean);

  return res.json({ field: '', posts, global: true });

});



router.post('/', feedUploadMiddleware, async (req, res) => {

  try {

    const me = await User.findById(req.user.id);

    if (!me) return res.status(404).json({ message: 'User not found' });

    await ensureBdId(me);



    const body = String(req.body?.body ?? '').trim();

    const files = Array.isArray(req.files) ? req.files : [];

    if (!body && files.length === 0) {

      return res.status(400).json({ message: 'Write something or add at least one photo' });

    }

    if (body.length > 2000) {

      return res.status(400).json({ message: 'Post text must be at most 2000 characters' });

    }



    const field = effectiveConnectionField(me);

    const imagePaths = files.map((f) => `/uploads/feed/${f.filename}`);



    const post = await NetworkFeedPost.create({

      author: me._id,

      body,

      images: imagePaths,

      connectionField: field,

    });



    const populated = await NetworkFeedPost.findById(post._id)

      .populate('author', 'name headline bdId connectionField role')

      .lean();



    const out = serializePost(populated);

    if (!out) return res.status(500).json({ message: 'Could not load new post' });

    return res.status(201).json({ post: out });

  } catch (e) {

    const msg = e && e.message ? String(e.message) : '';

    if (msg.includes('Only JPEG') || msg.includes('File too large')) {

      return res.status(400).json({ message: msg || 'Invalid upload' });

    }

    throw e;

  }

});



function parseKeepImages(raw) {

  if (raw == null || raw === '') return [];

  try {

    const parsed = JSON.parse(String(raw));

    if (!Array.isArray(parsed)) return [];

    return parsed

      .filter((p) => typeof p === 'string' && p.startsWith('/uploads/feed/'))

      .slice(0, 10);

  } catch {

    return [];

  }

}



router.patch('/:postId', (req, res, next) => {
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('multipart/form-data')) {
    return feedUploadMiddleware(req, res, next);
  }
  return next();
}, async (req, res) => {

  try {

    const postId = req.params.postId;

    if (!mongoose.Types.ObjectId.isValid(postId)) {

      return res.status(400).json({ message: 'Invalid post id' });

    }



    const me = await User.findById(req.user.id);

    if (!me) return res.status(404).json({ message: 'User not found' });



    const post = await NetworkFeedPost.findOne({

      _id: new mongoose.Types.ObjectId(postId),

      author: me._id,

    });



    if (!post) {

      return res.status(404).json({ message: 'Post not found or not yours to edit' });

    }



    const isMultipart = String(req.headers['content-type'] || '').includes('multipart/form-data');

    const text = String(req.body?.body ?? '').trim();

    const previousImages = Array.isArray(post.images) ? [...post.images] : [];



    if (isMultipart) {

      const keep = parseKeepImages(req.body?.keepImages);

      const files = Array.isArray(req.files) ? req.files : [];

      const newPaths = files.map((f) => `/uploads/feed/${f.filename}`);

      const images = [...keep, ...newPaths].slice(0, 10);

      if (!text && images.length === 0) {

        return res.status(400).json({ message: 'Write something or keep at least one photo' });

      }

      if (text.length > 2000) {

        return res.status(400).json({ message: 'Post text must be at most 2000 characters' });

      }

      post.body = text;

      post.images = images;

    } else {

      if (!text) {

        return res.status(400).json({ message: 'Post text is required (max 2000 chars)' });

      }

      if (text.length > 2000) {

        return res.status(400).json({ message: 'Post text must be at most 2000 characters' });

      }

      post.body = text;

    }



    await post.save();



    const nextImages = Array.isArray(post.images) ? post.images : [];

    for (const oldPath of previousImages) {

      if (!nextImages.includes(oldPath)) {

        unlinkFeedImage(oldPath);

      }

    }



    const populated = await NetworkFeedPost.findById(post._id)

      .populate('author', 'name headline bdId connectionField role')

      .lean();



    const out = serializePost(populated);

    if (!out) return res.status(500).json({ message: 'Could not load post' });

    return res.json({ post: out });

  } catch (e) {

    const msg = e && e.message ? String(e.message) : '';

    if (msg.includes('Only JPEG') || msg.includes('File too large')) {

      return res.status(400).json({ message: msg || 'Invalid upload' });

    }

    throw e;

  }

});



router.delete(

  '/:postId',

  [param('postId').isMongoId().withMessage('Invalid post id')],

  async (req, res) => {

    const errors = validationResult(req);

    if (!errors.isEmpty()) return sendValidationError(res, errors);



    const me = await User.findById(req.user.id);

    if (!me) return res.status(404).json({ message: 'User not found' });



    const post = await NetworkFeedPost.findOne({

      _id: new mongoose.Types.ObjectId(req.params.postId),

      author: me._id,

    });



    if (!post) {

      return res.status(404).json({ message: 'Post not found or not yours to delete' });

    }



    const images = Array.isArray(post.images) ? post.images : [];

    await post.deleteOne();

    for (const img of images) {

      unlinkFeedImage(img);

    }



    return res.json({ ok: true });

  }

);



export { router as feedRouter };

