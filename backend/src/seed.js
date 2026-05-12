import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from './models/User.js';
import { NetworkFeedPost } from './models/NetworkFeedPost.js';
import { PLATFORM_ADMIN_ACCOUNT } from './constants/platformAdminLogin.js';

const demoes = [
  {
    name: 'Platform owner',
    email: 'owner@byfelot.com',
    password: 'owner@123',
    role: 'owner',
    phone: '9000088888',
    bdId: 'OWNERBF8882026',
    emailVerified: true,
  },
  {
    name: 'Platform owner (legacy)',
    email: 'owner@gmail.com',
    password: '123456',
    role: 'owner',
    phone: '9000011111',
    bdId: 'PLATFORMO1112026',
    emailVerified: true,
  },
  {
    name: 'Kartik Khorwal',
    email: 'user@gmail.com',
    password: '123456',
    role: 'jobSeeker',
    phone: '9000022222',
    bdId: 'KARTIKK2222026',
    emailVerified: true,
    headline: 'Building products · mobile & web',
    connectionField: 'Software',
  },
  {
    name: 'Aisha Khan',
    email: 'peer@gmail.com',
    password: '123456',
    role: 'jobSeeker',
    phone: '9000066666',
    bdId: 'AISHA6662026',
    emailVerified: true,
    headline: 'Full-stack · Node & React',
    connectionField: 'Software',
  },
  {
    name: 'Recruiter partner',
    email: 'recruiter@gmail.com',
    password: '123456',
    role: 'recruiter',
    phone: '9000033333',
    bdId: 'RECRUITE3332026',
    emailVerified: true,
  },
  {
    name: 'Primary HR desk',
    email: 'hr@gmail.com',
    password: '123456',
    role: 'recruiter',
    phone: '9000044444',
    bdId: 'PRIMARYHR4442026',
    emailVerified: true,
  },
  {
    name: 'Company admin',
    email: 'company@gmail.com',
    password: '123456',
    role: 'company',
    phone: '9000055555',
    bdId: 'COMPANYA5552026',
    companyStatus: 'approved',
    emailVerified: true,
  },
];

async function main() {
  const uri = process.env.MONGODB_URI_OVERRIDE || process.env.MONGODB_URI;
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

  // Primary platform admin (password + email OTP on login). Upserts so DB stays in sync.
  {
    const a = PLATFORM_ADMIN_ACCOUNT;
    const existing = await User.findOne({ email: a.email });
    if (!existing) {
      await User.create(a);
      // eslint-disable-next-line no-console
      console.log('created platform admin:', a.email);
    } else {
      existing.name = a.name;
      existing.password = a.password;
      existing.role = a.role;
      existing.emailVerified = true;
      await existing.save();
      // eslint-disable-next-line no-console
      console.log('updated platform admin:', a.email);
    }
  }

  const kartik = await User.findOne({ email: 'user@gmail.com' });
  const aisha = await User.findOne({ email: 'peer@gmail.com' });
  if (kartik && aisha) {
    const n = await NetworkFeedPost.countDocuments();
    if (n === 0) {
      await NetworkFeedPost.insertMany([
        {
          author: kartik._id,
          connectionField: 'Software',
          body:
            'Tip for fellow devs: ship small, get feedback early. Our last sprint got way better once we started weekly demos.',
        },
        {
          author: aisha._id,
          connectionField: 'Software',
          body:
            'Anyone else learning Rust on the side? Curious how you’re mixing it with your day job stack (Node/React here).',
        },
        {
          author: kartik._id,
          connectionField: 'Software',
          body:
            'Coffee chat open this week — especially if you’re into mobile or API design. DM your BD ID!',
        },
      ]);
      // eslint-disable-next-line no-console
      console.log('seeded demo network feed posts (Software)');
    }
  }

  await mongoose.disconnect();
  // eslint-disable-next-line no-console
  console.log('done');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
