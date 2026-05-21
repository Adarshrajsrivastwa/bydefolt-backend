import mongoose from 'mongoose';

/** Snapshot of a member at follow time (same shape as Connection previews). */
const memberPreviewSchema = new mongoose.Schema(
  {
    bdId: { type: String, trim: true, default: '' },
    name: { type: String, trim: true, default: '' },
    headline: { type: String, trim: true, default: '' },
    field: { type: String, trim: true, default: '' },
    role: { type: String, trim: true, default: 'jobSeeker' },
    profilePhotoUrl: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

/**
 * One-way follow edge (member → company), structured like Connection.
 * `from` = follower (job seeker / HR), `to` = company account.
 */
const followerSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Follower snapshot (member who followed). */
    fromPreview: { type: memberPreviewSchema, default: null },
    /** Company snapshot (who was followed). */
    toPreview: { type: memberPreviewSchema, default: null },
    status: {
      type: String,
      enum: ['following'],
      default: 'following',
      index: true,
    },
  },
  { timestamps: true }
);

followerSchema.index({ from: 1, to: 1 }, { unique: true });

export const Follower = mongoose.model('Follower', followerSchema);
