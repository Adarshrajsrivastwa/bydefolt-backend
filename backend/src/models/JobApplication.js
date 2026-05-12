import mongoose from 'mongoose';

const jobApplicationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    jobPostId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPost', required: true, index: true },
  },
  { timestamps: true }
);

jobApplicationSchema.index({ userId: 1, jobPostId: 1 }, { unique: true });

export const JobApplication = mongoose.model('JobApplication', jobApplicationSchema);
