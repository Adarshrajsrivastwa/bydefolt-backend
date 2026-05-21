import mongoose from 'mongoose';

const feedPostCommentSchema = new mongoose.Schema(
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
    body: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

feedPostCommentSchema.index({ post: 1, createdAt: 1 });

export const FeedPostComment = mongoose.model(
  'FeedPostComment',
  feedPostCommentSchema
);
