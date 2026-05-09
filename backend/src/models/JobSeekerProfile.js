import mongoose from 'mongoose';

const workExperienceSchema = new mongoose.Schema(
  {
    jobTitle: { type: String, trim: true, default: '' },
    company: { type: String, trim: true, default: '' },
    startDate: { type: String, trim: true, default: '' },
    endDate: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    currentPosition: { type: Boolean, default: false },
  },
  { _id: false }
);

const educationSchema = new mongoose.Schema(
  {
    level: { type: String, trim: true, default: '' },
    institution: { type: String, trim: true, default: '' },
    fieldOfStudy: { type: String, trim: true, default: '' },
    startDate: { type: String, trim: true, default: '' },
    endDate: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    currentlyStudying: { type: Boolean, default: false },
  },
  { _id: false }
);

const languageSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    flagEmoji: { type: String, trim: true, default: '🌐' },
    oralLevel: { type: Number, min: 0, max: 10, default: 5 },
    writtenLevel: { type: Number, min: 0, max: 10, default: 5 },
    isFirstLanguage: { type: Boolean, default: false },
  },
  { _id: false }
);

const appreciationSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, default: '' },
    subtitle: { type: String, trim: true, default: '' },
    timeLabel: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const jobSeekerProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    about: { type: String, trim: true, default: '', maxlength: 8000 },
    workExperiences: { type: [workExperienceSchema], default: [] },
    education: { type: [educationSchema], default: [] },
    skills: { type: [String], default: [] },
    languages: { type: [languageSchema], default: [] },
    appreciations: { type: [appreciationSchema], default: [] },
  },
  { timestamps: true }
);

export const JobSeekerProfile = mongoose.model('JobSeekerProfile', jobSeekerProfileSchema);
