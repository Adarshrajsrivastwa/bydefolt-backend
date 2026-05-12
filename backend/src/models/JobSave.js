import mongoose from 'mongoose';

const jobSaveSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    jobPostId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPost', required: true, index: true },
  },
  { timestamps: true }
);

jobSaveSchema.index({ userId: 1, jobPostId: 1 }, { unique: true });

export const JobSave = mongoose.model('JobSave', jobSaveSchema);
