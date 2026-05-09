import mongoose from 'mongoose';

const companyProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    companyDisplayName: { type: String, trim: true, default: '' },
    legalRegisteredName: { type: String, trim: true, default: '' },
    industry: { type: String, trim: true, default: '' },
    website: { type: String, trim: true, default: '' },
    headquarters: { type: String, trim: true, default: '' },
    companyAddress: { type: String, trim: true, default: '' },
    companyPhone: { type: String, trim: true, default: '' },
    companyEmailContact: { type: String, trim: true, default: '' },
    about: { type: String, trim: true, default: '' },
    verificationPdf: {
      originalName: { type: String, trim: true, default: '' },
      mimeType: { type: String, trim: true, default: '' },
      sizeBytes: { type: Number, default: 0 },
      storedPath: { type: String, trim: true, default: '' }, // e.g. /uploads/company/abc.pdf
      uploadedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

export const CompanyProfile = mongoose.model('CompanyProfile', companyProfileSchema);
