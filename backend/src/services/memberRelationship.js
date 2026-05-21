import { Connection } from '../models/Connection.js';
import { User } from '../models/User.js';
import {
  isConnectionTargetRole,
  isFollowTargetRole,
  networkActionForTargetRole,
} from '../util/memberNetwork.js';
import {
  createFollowerEdge,
  deleteFollowerByBdId,
  followerExists,
} from './followerNetwork.js';

/** UI labels aligned with profile "Following" vs "Connections". */
export const NETWORK_LABELS = {
  connections: 'Connections',
  following: 'Following',
};

function baseRelationship(overrides = {}) {
  return {
    status: 'none',
    requestId: '',
    canMessage: false,
    canFollow: false,
    canConnect: false,
    action: null,
    actionLabel: '',
    ...overrides,
  };
}

/**
 * Viewer ↔ target state for profiles, feed, and BD lookup.
 * Companies → one-way following; job seekers / HR → connections.
 */
export async function relationshipForViewer(viewerId, targetId) {
  const me = String(viewerId);
  const other = String(targetId);
  if (me === other) {
    return baseRelationship({ status: 'self' });
  }

  const targetUser = await User.findById(targetId).select('role').lean();
  if (!targetUser) {
    return baseRelationship();
  }

  const action = networkActionForTargetRole(targetUser.role);

  if (isFollowTargetRole(targetUser.role)) {
    const follows = await followerExists(viewerId, targetId);
    if (follows) {
      return baseRelationship({
        status: 'following',
        action: 'following',
        actionLabel: NETWORK_LABELS.following,
      });
    }
    return baseRelationship({
      status: 'none',
      canFollow: true,
      action: 'following',
      actionLabel: NETWORK_LABELS.following,
    });
  }

  if (!isConnectionTargetRole(targetUser.role)) {
    return baseRelationship();
  }

  const edge = await Connection.findOne({
    $or: [
      { from: viewerId, to: targetId },
      { from: targetId, to: viewerId },
    ],
    status: { $in: ['pending', 'accepted'] },
  })
    .select('from to status')
    .lean();

  if (!edge) {
    return baseRelationship({
      status: 'none',
      canConnect: true,
      action: 'connection',
      actionLabel: NETWORK_LABELS.connections,
    });
  }

  if (edge.status === 'accepted') {
    return baseRelationship({
      status: 'connected',
      requestId: String(edge._id),
      canMessage: true,
      action: 'connection',
      actionLabel: NETWORK_LABELS.connections,
    });
  }

  if (String(edge.from) === me) {
    return baseRelationship({
      status: 'pending_out',
      requestId: String(edge._id),
      action: 'connection',
      actionLabel: NETWORK_LABELS.connections,
    });
  }

  return baseRelationship({
    status: 'pending_in',
    requestId: String(edge._id),
    action: 'connection',
    actionLabel: NETWORK_LABELS.connections,
  });
}

/** Follow a company (Follower edge, same pattern as Connection create). */
export async function followCompanyByBdId(me, targetBd) {
  const target = await User.findOne({ bdId: targetBd });
  if (!target) {
    return { error: { status: 404, message: 'No account found with that BD ID' } };
  }
  if (String(target._id) === String(me._id)) {
    return { error: { status: 400, message: 'You cannot follow yourself' } };
  }
  if (!isFollowTargetRole(target.role)) {
    return {
      error: {
        status: 400,
        message:
          'Only company accounts are added to Following. Use a connection request for professionals and HR.',
      },
    };
  }
  if (target.companyStatus && target.companyStatus !== 'approved') {
    return {
      error: { status: 404, message: 'This company is not available to follow yet' },
    };
  }

  const existing = await followerExists(me._id, target._id);
  if (existing) {
    return {
      error: { status: 409, message: 'Already in your Following list' },
    };
  }

  const doc = await createFollowerEdge(me, target);

  return {
    ok: true,
    kind: 'following',
    message: 'Added to Following',
    followerId: String(doc._id),
    followId: String(doc._id),
    company: target,
  };
}

export async function unfollowCompanyByBdId(me, bdId) {
  return deleteFollowerByBdId(me, bdId);
}
