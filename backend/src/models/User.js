import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { CONNECTION_FIELDS } from '../util/connectionField.js';

const roles = ['jobSeeker', 'recruiter', 'company', 'owner'];
const companyStatuses = ['pending', 'approved', 'rejected', 'suspended'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email'],
    },
    password: { type: String, required: true, minlength: 6, select: false },
    role: { type: String, enum: roles, default: 'jobSeeker' },
    companyStatus: {
      type: String,
      enum: companyStatuses,
      default: function defaultCompanyStatus() {
        return this.role === 'company' ? 'pending' : 'approved';
      },
      index: true,
    },
    // If this user is a recruiter/HR associated to a company account, store the company user id here.
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [/^\d{10}$/, 'Phone must be 10 digits'],
    },
    bdId: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    emailVerified: {
      type: Boolean,
      default: true,
    },
    emailOtpHash: { type: String, select: false, default: null },
    emailOtpExpiresAt: { type: Date, default: null },
    emailOtpPurpose: { type: String, default: null },
    /** Short professional headline (job seeker network card). */
    headline: { type: String, default: '', trim: true, maxlength: 200 },
    /** Networking / suggestion bucket; must be one of [CONNECTION_FIELDS] when set. */
    connectionField: {
      type: String,
      default: '',
      trim: true,
      enum: [...CONNECTION_FIELDS, ''],
    },
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.password;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
export { roles as userRoles, companyStatuses };
