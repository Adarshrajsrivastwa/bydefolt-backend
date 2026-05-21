import mongoose from 'mongoose';

/** One-way follow: member → company account (not a mutual connection). */
const companyFollowSchema = new mongoose.Schema(
  {
    follower: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

companyFollowSchema.index({ follower: 1, company: 1 }, { unique: true });

export const CompanyFollow = mongoose.model('CompanyFollow', companyFollowSchema);
