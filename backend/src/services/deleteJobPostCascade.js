import mongoose from 'mongoose';
import { JobApplication } from '../models/JobApplication.js';
import { JobPost } from '../models/JobPost.js';
import { JobSave } from '../models/JobSave.js';

/** Remove job post and applications / saves (owner tool). */
export async function deleteJobPostCascade(jobIdRaw) {
  const oid =
    typeof jobIdRaw === 'string'
      ? new mongoose.Types.ObjectId(jobIdRaw)
      : jobIdRaw;

  await Promise.all([
    JobApplication.deleteMany({ jobPostId: oid }),
    JobSave.deleteMany({ jobPostId: oid }),
  ]);
  const r = await JobPost.deleteOne({ _id: oid });
  return r.deletedCount === 1;
}
