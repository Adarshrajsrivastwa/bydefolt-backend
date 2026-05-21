import mongoose from 'mongoose';

export const FEED_REACTION_TYPES = [
  'like',
  'celebrate',
  'support',
  'love',
  'insightful',
  'funny',
];

const feedPostReactionSchema = new mongoose.Schema(
  {
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NetworkFeedPost',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: FEED_REACTION_TYPES,
    },
  },
  { timestamps: true }
);

feedPostReactionSchema.index({ post: 1, user: 1 }, { unique: true });

export const FeedPostReaction = mongoose.model(
  'FeedPostReaction',
  feedPostReactionSchema
);
