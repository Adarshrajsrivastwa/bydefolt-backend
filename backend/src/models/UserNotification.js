import mongoose from 'mongoose';

const audienceTypes = ['all', 'hr', 'employee'];

const userNotificationSchema = new mongoose.Schema(
  {
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    companyUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    audience: {
      type: String,
      enum: audienceTypes,
      default: 'all',
    },
    title: { type: String, trim: true, required: true, maxlength: 200 },
    body: { type: String, trim: true, required: true, maxlength: 4000 },
    imageUrl: { type: String, trim: true, default: '' },
    /** Owner / platform broadcast (inbox shows as ByDefolt). */
    isPlatformBroadcast: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    /** Same id on every copy from one send (enables batch update by sender). */
    noticeBatchId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
      default: null,
    },
  },
  { timestamps: true }
);

userNotificationSchema.index({ recipientId: 1, createdAt: -1 });
userNotificationSchema.index({ noticeBatchId: 1, sentBy: 1 });

export const UserNotification = mongoose.model('UserNotification', userNotificationSchema);
export { audienceTypes as notificationAudienceTypes };
