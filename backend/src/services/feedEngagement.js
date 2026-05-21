import mongoose from 'mongoose';

import { FeedPostReaction, FEED_REACTION_TYPES } from '../models/FeedPostReaction.js';
import { FeedPostComment } from '../models/FeedPostComment.js';

function emptyCounts() {
  return Object.fromEntries(FEED_REACTION_TYPES.map((t) => [t, 0]));
}

/**
 * @param {import('mongoose').Types.ObjectId[]} postIds
 * @param {import('mongoose').Types.ObjectId | string} meId
 */
export async function engagementForPosts(postIds, meId) {
  const oids = postIds.filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
  const map = new Map();
  for (const id of oids) {
    map.set(String(id), {
      reactionCounts: emptyCounts(),
      totalReactions: 0,
      myReaction: null,
      commentCount: 0,
    });
  }
  if (oids.length === 0) return map;

  const grouped = await FeedPostReaction.aggregate([
    { $match: { post: { $in: oids } } },
    { $group: { _id: { post: '$post', type: '$type' }, count: { $sum: 1 } } },
  ]);

  for (const row of grouped) {
    const pid = String(row._id.post);
    const type = row._id.type;
    const entry = map.get(pid);
    if (!entry || !FEED_REACTION_TYPES.includes(type)) continue;
    entry.reactionCounts[type] = row.count;
    entry.totalReactions += row.count;
  }

  const mine = await FeedPostReaction.find({
    post: { $in: oids },
    user: meId,
  })
    .select('post type')
    .lean();

  for (const r of mine) {
    const entry = map.get(String(r.post));
    if (entry) entry.myReaction = r.type;
  }

  const commentGroups = await FeedPostComment.aggregate([
    { $match: { post: { $in: oids } } },
    { $group: { _id: '$post', count: { $sum: 1 } } },
  ]);

  for (const row of commentGroups) {
    const entry = map.get(String(row._id));
    if (entry) entry.commentCount = row.count;
  }

  return map;
}

/**
 * @param {import('mongoose').Types.ObjectId | string} postId
 * @param {import('mongoose').Types.ObjectId | string} meId
 */
export async function engagementForPost(postId, meId) {
  const m = await engagementForPosts(
    [new mongoose.Types.ObjectId(String(postId))],
    meId
  );
  return (
    m.get(String(postId)) ?? {
      reactionCounts: emptyCounts(),
      totalReactions: 0,
      myReaction: null,
      commentCount: 0,
    }
  );
}

export function serializeEngagement(engagement) {
  const counts = { ...emptyCounts(), ...(engagement?.reactionCounts ?? {}) };
  let total = 0;
  for (const t of FEED_REACTION_TYPES) {
    counts[t] = Number(counts[t]) || 0;
    total += counts[t];
  }
  const my = engagement?.myReaction;
  return {
    reactionCounts: counts,
    totalReactions: total,
    myReaction: FEED_REACTION_TYPES.includes(my) ? my : null,
    commentCount: Number(engagement?.commentCount) || 0,
  };
}
