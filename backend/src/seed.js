import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from './models/User.js';

const demoes = [
  {
    name: 'Platform owner',
    email: 'owner@gmail.com',
    password: '123456',
    role: 'owner',
    phone: '9000011111',
    bdId: 'PLATFORMO1112026',
  },
  {
    name: 'Kartik Khorwal',
    email: 'user@gmail.com',
    password: '123456',
    role: 'jobSeeker',
    phone: '9000022222',
    bdId: 'KARTIKK2222026',
  },
  {
    name: 'Recruiter partner',
    email: 'recruiter@gmail.com',
    password: '123456',
    role: 'recruiter',
    phone: '9000033333',
    bdId: 'RECRUITE3332026',
  },
  {
    name: 'Primary HR desk',
    email: 'hr@gmail.com',
    password: '123456',
    role: 'recruiter',
    phone: '9000044444',
    bdId: 'PRIMARYHR4442026',
  },
  {
    name: 'Company admin',
    email: 'company@gmail.com',
    password: '123456',
    role: 'company',
    phone: '9000055555',
    bdId: 'COMPANYA5552026',
  },
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);
  for (const row of demoes) {
    const ex = await User.findOne({ email: row.email });
    if (ex) {
      // eslint-disable-next-line no-console
      console.log('skip (exists):', row.email);
      continue;
    }
    await User.create(row);
    // eslint-disable-next-line no-console
    console.log('created:', row.email, row.role);
  }

  // Link demo recruiters to the demo company (so company dashboard sees their jobs too).
  const company = await User.findOne({ email: 'company@gmail.com' });
  if (company) {
    await User.updateMany(
      { role: 'recruiter', email: { $in: ['recruiter@gmail.com', 'hr@gmail.com'] } },
      { $set: { companyId: company._id } }
    );
    // eslint-disable-next-line no-console
    console.log('linked recruiters to company:', company.email);
  }

  await mongoose.disconnect();
  // eslint-disable-next-line no-console
  console.log('done');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
