import { Connection } from '../models/Connection.js';

import { User } from '../models/User.js';

import { countActiveFollowers } from './followerNetwork.js';



const PROFESSIONAL_ROLES = new Set(['jobSeeker', 'recruiter']);



/** Accepted connections with job seekers or HR only (not companies). */

export async function countProfessionalConnections(userId) {

  const id = userId;

  const edges = await Connection.find({

    status: 'accepted',

    $or: [{ from: id }, { to: id }],

  })

    .select('from to')

    .lean();



  const partnerIds = new Set();

  const meStr = String(id);

  for (const e of edges) {

    const fromStr = String(e.from);

    partnerIds.add(fromStr === meStr ? String(e.to) : fromStr);

  }

  if (partnerIds.size === 0) return 0;



  const partners = await User.find({ _id: { $in: [...partnerIds] } })

    .select('role')

    .lean();



  return partners.filter((u) => PROFESSIONAL_ROLES.has(u.role)).length;

}



/** Companies this member follows (Follower edges, one-way). */

export async function countCompanyFollows(userId) {

  return countActiveFollowers(userId);

}



export async function connectionStatsForUser(userId) {

  const [connectedCount, followingCount] = await Promise.all([

    countProfessionalConnections(userId),

    countCompanyFollows(userId),

  ]);

  return { connectedCount, followingCount };

}

