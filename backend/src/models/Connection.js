import mongoose from 'mongoose';

const connectionSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'ignored'],
      default: 'pending',
      index: true,
    },
  },
  { timestamps: true }
);

connectionSchema.index({ from: 1, to: 1 }, { unique: true });

export const Connection = mongoose.model('Connection', connectionSchema);
