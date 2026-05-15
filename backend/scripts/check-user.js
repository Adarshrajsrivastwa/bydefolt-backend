import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../src/models/User.js';

const email = process.argv[2] || 'srivastwadarsh@gmail.com';
const password = process.argv[3] || '';

await mongoose.connect(process.env.MONGODB_URI);
const u = await User.findOne({ email: email.toLowerCase() }).select('+password email emailVerified role name');
if (!u) {
  const partial = await User.find({ email: { $regex: email.split('@')[0], $options: 'i' } }).select('email role');
  console.log('NOT_FOUND', { searched: email.toLowerCase(), similar: partial.map((x) => x.email) });
} else {
  const ok = password ? await bcrypt.compare(password, u.password) : null;
  console.log('FOUND', {
    email: u.email,
    name: u.name,
    role: u.role,
    emailVerified: u.emailVerified,
    passwordMatch: ok,
  });
}
await mongoose.disconnect();
