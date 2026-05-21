import { Connection } from '../models/Connection.js';

/** Accepted connections (either direction). */
export async function connectionStatsForUser(userId) {
  const id = userId;
  const [connectedCount, followingCount] = await Promise.all([
    Connection.countDocuments({
      status: 'accepted',
      $or: [{ from: id }, { to: id }],
    }),
    Connection.countDocuments({
      status: 'accepted',
      from: id,
    }),
  ]);
  return { connectedCount, followingCount };
}
