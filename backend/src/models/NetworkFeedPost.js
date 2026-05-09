import mongoose from 'mongoose';
import { CONNECTION_FIELDS } from '../util/connectionField.js';

const networkFeedPostSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    connectionField: { type: String, required: true, enum: CONNECTION_FIELDS, index: true },
  },
  { timestamps: true }
);

networkFeedPostSchema.index({ connectionField: 1, createdAt: -1 });

export const NetworkFeedPost = mongoose.model('NetworkFeedPost', networkFeedPostSchema);
