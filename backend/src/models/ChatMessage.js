import mongoose from 'mongoose';

const chatAttachmentSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, required: true },
    name: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' },
    size: { type: Number, default: 0 },
    kind: { type: String, enum: ['image', 'file'], default: 'file' },
  },
  { _id: false }
);

const chatMessageSchema = new mongoose.Schema(
  {
    connection: { type: mongoose.Schema.Types.ObjectId, ref: 'Connection', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    text: { type: String, trim: true, maxlength: 4000, default: '' },
    attachments: { type: [chatAttachmentSchema], default: [] },
  },
  { timestamps: true }
);

chatMessageSchema.index({ connection: 1, createdAt: 1 });

export const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
