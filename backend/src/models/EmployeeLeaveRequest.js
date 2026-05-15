import mongoose from 'mongoose';

const leaveStatuses = ['pending', 'approved', 'rejected', 'cancelled'];

const employeeLeaveRequestSchema = new mongoose.Schema(
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
    companyName: { type: String, trim: true, default: '', maxlength: 200 },
    jobTitle: { type: String, trim: true, default: '', maxlength: 200 },
    /** Inclusive, `YYYY-MM-DD` */
    startDate: { type: String, required: true, trim: true, maxlength: 10 },
    /** Inclusive, `YYYY-MM-DD`; same as startDate for single-day leave */
    endDate: { type: String, required: true, trim: true, maxlength: 10 },
    singleDay: { type: Boolean, default: false },
    reason: { type: String, trim: true, default: '', maxlength: 2000 },
    status: {
      type: String,
      enum: leaveStatuses,
      default: 'pending',
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, default: '', maxlength: 500 },
  },
  { timestamps: true }
);

employeeLeaveRequestSchema.index({ companyUserId: 1, status: 1, createdAt: -1 });
employeeLeaveRequestSchema.index({ seekerId: 1, createdAt: -1 });

export const EmployeeLeaveRequest = mongoose.model(
  'EmployeeLeaveRequest',
  employeeLeaveRequestSchema
);
export { leaveStatuses as employeeLeaveStatuses };
