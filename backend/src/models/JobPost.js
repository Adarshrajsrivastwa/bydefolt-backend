import mongoose from 'mongoose';

export const jobPostTitleOptions = [
  'Senior Product Designer',
  'Product Designer',
  'UI/UX Designer',
  'Flutter Developer',
  'Software Engineer',
  'Full Stack Developer',
  'HR Manager',
  'Talent Acquisition Specialist',
  'Marketing Lead',
  'Data Analyst',
  'DevOps Engineer',
  'Graphic Designer',
];

export const jobPostLocationOptions = [
  'Bangalore, India',
  'Hyderabad, India',
  'Mumbai, India',
  'California, United States',
  'New York, United States',
  'London, United Kingdom',
  'Berlin, Germany',
  'Singapore',
  'Remote — worldwide',
];

export const workplaceOptions = ['On-site', 'Hybrid', 'Remote'];
export const employmentTypeOptions = [
  'Full-time',
  'Part-time',
  'Contract',
  'Temporary',
  'Internship',
  'Apprenticeship',
  'Volunteer',
];

const jobPostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 4000, default: '' },
    jobPosition: { type: String, required: true, trim: true, maxlength: 140 },
    location: { type: String, required: true, trim: true, maxlength: 180 },
    workplace: { type: String, enum: workplaceOptions, default: 'Hybrid' },
    employmentType: { type: String, enum: employmentTypeOptions, default: 'Full-time' },
    status: { type: String, enum: ['published', 'closed'], default: 'published' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    companyName: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

export const JobPost = mongoose.model('JobPost', jobPostSchema);
