import mongoose from 'mongoose';
import { Follower } from '../models/Follower.js';
import { User } from '../models/User.js';
import { isFollowTargetRole } from '../util/memberNetwork.js';
import {
  buildMemberPreviews,
  cardFromStoredPreview,
  resolvePartnerUser,
  userCard,
  usersByObjectIds,
} from './memberPreview.js';

let legacyMigrated = false;

/** Copy legacy CompanyFollow docs (follower/company) into Follower (from/to). */
export async function migrateLegacyCompanyFollowsOnce() {
  if (legacyMigrated) return;
  legacyMigrated = true;

  const db = mongoose.connection?.db;
  if (!db) return;

  let legacy = [];
  try {
    legacy = await db.collection('companyfollows').find({}).toArray();
  } catch {
    return;
  }

  for (const row of legacy) {
    const from = row.follower;
    const to = row.company;
    if (!from || !to) continue;
    await Follower.updateOne(
      { from, to },
      {
        $setOnInsert: {
          from,
          to,
          status: 'following',
          createdAt: row.createdAt ?? new Date(),
          updatedAt: row.updatedAt ?? new Date(),
        },
      },
      { upsert: true }
    );
  }
}

export async function countActiveFollowers(userId) {
  await migrateLegacyCompanyFollowsOnce();
  return Follower.countDocuments({ from: userId, status: 'following' });
}

function mapFollowerRow(d, userMap) {
  const storedPreview = d.toPreview;
  const partner = resolvePartnerUser(d.to, userMap);
  if (!partner || !isFollowTargetRole(partner.role)) return null;

  let card = cardFromStoredPreview(storedPreview);
  let role = storedPreview?.role || partner.role || 'company';
  let profilePhotoUrl = storedPreview?.profilePhotoUrl || '';

  if (!card) {
    card = userCard(partner);
    if (!card) return null;
    role = partner.role || 'company';
    void Follower.updateOne(
      { _id: d._id },
      {
        $set: {
          toPreview: {
            ...card,
            role,
            profilePhotoUrl,
          },
        },
      }
    ).catch(() => {});
  }

  const id = String(d._id);
  return {
    requestId: id,
    followerId: id,
    followId: id,
    connectionId: id,
    kind: 'following',
    status: 'following',
    ...card,
    role,
    profilePhotoUrl,
  };
}

/** List companies the member follows (same card shape as connection requests). */
export async function listFollowersForUser(userId) {
  await migrateLegacyCompanyFollowsOnce();

  const docs = await Follower.find({ from: userId, status: 'following' })
    .sort({ createdAt: -1 })
    .lean();

  if (docs.length === 0) return [];

  const partnerIds = docs.map((d) => d.to?._id ?? d.to);
  const userMap = await usersByObjectIds(partnerIds);

  return docs.map((d) => mapFollowerRow(d, userMap)).filter(Boolean);
}

/** Accepted-style list (parallel to GET /connections/accepted). */
export async function listFollowersAccepted(userId) {
  const rows = await listFollowersForUser(userId);
  return rows.map((row) => ({
    followerId: row.followerId,
    followId: row.followId,
    connectionId: row.connectionId,
    bdId: row.bdId,
    name: row.name,
    headline: row.headline,
    field: row.field,
    role: row.role,
    profilePhotoUrl: row.profilePhotoUrl,
    status: row.status,
  }));
}

export async function createFollowerEdge(me, target) {
  await migrateLegacyCompanyFollowsOnce();

  const previews = await buildMemberPreviews(me, target);
  const doc = await Follower.create({
    from: me._id,
    to: target._id,
    status: 'following',
    fromPreview: previews.fromPreview,
    toPreview: previews.toPreview,
  });

  return doc;
}

export async function deleteFollowerByBdId(me, bdId) {
  await migrateLegacyCompanyFollowsOnce();

  const company = await User.findOne({ bdId, role: 'company' }).select('_id');
  if (!company) {
    return { error: { status: 404, message: 'Company not found' } };
  }

  const result = await Follower.deleteOne({
    from: me._id,
    to: company._id,
    status: 'following',
  });
  if (result.deletedCount === 0) {
    return { error: { status: 404, message: 'Not in your Following list' } };
  }

  return { ok: true, message: 'Removed from Following' };
}

export async function deleteFollowerById(me, followerId) {
  await migrateLegacyCompanyFollowsOnce();

  if (!mongoose.Types.ObjectId.isValid(followerId)) {
    return { error: { status: 400, message: 'Invalid follower id' } };
  }

  const result = await Follower.deleteOne({
    _id: new mongoose.Types.ObjectId(followerId),
    from: me._id,
    status: 'following',
  });
  if (result.deletedCount === 0) {
    return { error: { status: 404, message: 'Follower not found' } };
  }

  return { ok: true, message: 'Removed from Following' };
}

export async function followerExists(viewerId, companyId) {
  await migrateLegacyCompanyFollowsOnce();
  return Follower.exists({
    from: viewerId,
    to: companyId,
    status: 'following',
  });
}

export async function followedCompanyIdsForUser(userId) {
  await migrateLegacyCompanyFollowsOnce();
  const rows = await Follower.find({ from: userId, status: 'following' })
    .select('to')
    .lean();
  return rows.map((r) => String(r.to));
}
