import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { ChatMessage } from '../models/ChatMessage.js';
import { CompanyEmployerJoinRequest } from '../models/CompanyEmployerJoinRequest.js';
import { Connection } from '../models/Connection.js';
import { EmployeeLeaveRequest } from '../models/EmployeeLeaveRequest.js';
import { JobApplication } from '../models/JobApplication.js';
import { JobSave } from '../models/JobSave.js';
import { JobSeekerProfile } from '../models/JobSeekerProfile.js';
import { NetworkFeedPost } from '../models/NetworkFeedPost.js';
import { UserNotification } from '../models/UserNotification.js';

/**
 * Permanently remove a job seeker and related docs (applications, saves, connections, …).
 */
export async function deleteJobSeekerUserCascade(userIdRaw) {
  const oid =
    typeof userIdRaw === 'string'
      ? new mongoose.Types.ObjectId(userIdRaw)
      : userIdRaw;

  const connections = await Connection.find({
    $or: [{ from: oid }, { to: oid }],
  }).select('_id');

  const connectionIds = connections.map((c) => c._id);
  if (connectionIds.length > 0) {
    await ChatMessage.deleteMany({ connection: { $in: connectionIds } });
    await Connection.deleteMany({ _id: { $in: connectionIds } });
  }

  await Promise.all([
    JobSeekerProfile.deleteOne({ userId: oid }),
    JobApplication.deleteMany({ userId: oid }),
    JobSave.deleteMany({ userId: oid }),
    NetworkFeedPost.deleteMany({ author: oid }),
    UserNotification.deleteMany({
      $or: [{ recipientId: oid }, { sentBy: oid }, { companyUserId: oid }],
    }),
    EmployeeLeaveRequest.deleteMany({ seekerId: oid }),
    CompanyEmployerJoinRequest.deleteMany({ seekerId: oid }),
  ]);

  const r = await User.deleteOne({ _id: oid, role: 'jobSeeker' });
  return r.deletedCount === 1;
}
