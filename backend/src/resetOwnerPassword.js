/**
 * Reset password for an existing user (e.g. owner) in MongoDB.
 * Does not create the user — run `npm run seed` first if missing.
 *
 * Usage:
 *   npm run reset-owner
 *   node src/resetOwnerPassword.js owner@gmail.com 123456
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from './models/User.js';

async function main() {
  const uri = process.env.MONGODB_URI_OVERRIDE || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required in .env');
    process.exit(1);
  }

  const email = (process.argv[2] || 'owner@byfelot.com').trim().toLowerCase();
  const plain = process.argv[3] || 'owner@123';

  await mongoose.connect(uri);
  const user = await User.findOne({ email }).select('+password');
  if (!user) {
    console.error(`No user found for ${email}. Run: npm run seed`);
    await mongoose.disconnect();
    process.exit(1);
  }

  user.password = plain;
  await user.save();

  // eslint-disable-next-line no-console
  console.log(`Password updated for ${user.email} (role: ${user.role})`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
