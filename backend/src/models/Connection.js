import mongoose from 'mongoose';

/** Snapshot of a member at request time (so cards always show name + BD ID). */
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

const connectionSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Sender snapshot (shown on receiver's incoming cards). */
    fromPreview: { type: memberPreviewSchema, default: null },
    /** Recipient snapshot (shown on sender's outgoing cards). */
    toPreview: { type: memberPreviewSchema, default: null },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'ignored'],
      default: 'pending',
      index: true,
    },
    lastReadAtFrom: { type: Date, default: null },
    lastReadAtTo: { type: Date, default: null },
  },
  { timestamps: true }
);

connectionSchema.index({ from: 1, to: 1 }, { unique: true });

export const Connection = mongoose.model('Connection', connectionSchema);
