import mongoose from 'mongoose';

const statuses = ['pending', 'approved', 'rejected'];

const companyEmployerJoinRequestSchema = new mongoose.Schema(
  {
    seekerId: {
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
    jobTitle: { type: String, trim: true, default: '', maxlength: 200 },
    status: {
      type: String,
      enum: statuses,
      default: 'pending',
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

companyEmployerJoinRequestSchema.index(
  { seekerId: 1, companyUserId: 1, status: 1 },
  { partialFilterExpression: { status: 'pending' }, unique: true }
);

export const CompanyEmployerJoinRequest = mongoose.model(
  'CompanyEmployerJoinRequest',
  companyEmployerJoinRequestSchema
);
export { statuses as companyEmployerJoinRequestStatuses };
