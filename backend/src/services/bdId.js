import { User } from '../models/User.js';

export function buildBdIdBase(name, phone) {
  const firstName = name.trim().split(/\s+/)[0] || '';
  const cleanFirst = firstName.replace(/[^a-zA-Z]/g, '').slice(0, 8).toUpperCase();
  const firstLetter = cleanFirst[0] || 'U';
  const midPhone = phone.slice(5, 8);
  const year = String(new Date().getFullYear());
  return `${cleanFirst}${firstLetter}${midPhone}${year}`;
}

export async function generateUniqueBdId(name, phone) {
  const base = buildBdIdBase(name, phone);
  let candidate = base;
  let counter = 1;
  while (await User.exists({ bdId: candidate })) {
    candidate = `${base}${String(counter).padStart(2, '0')}`;
    counter += 1;
  }
  return candidate;
}

export function buildLegacyBdIdBase(user) {
  const fromName = (user.name || '')
    .replace(/[^a-zA-Z]/g, '')
    .slice(0, 8)
    .toUpperCase();
  const localEmail = String(user.email || '')
    .split('@')[0]
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase();
  const year = String(new Date().getFullYear());
  return `${fromName || 'USER'}${localEmail || 'ID'}${year}`;
}

export async function ensureBdId(user) {
  if (user.bdId && String(user.bdId).trim().length > 0) {
    return user.bdId;
  }
  const base = buildLegacyBdIdBase(user);
  let candidate = base;
  let counter = 1;
  while (await User.exists({ bdId: candidate })) {
    candidate = `${base}${String(counter).padStart(2, '0')}`;
    counter += 1;
  }
  await User.updateOne(
    { _id: user._id, $or: [{ bdId: { $exists: false } }, { bdId: null }, { bdId: '' }] },
    { $set: { bdId: candidate } }
  );
  return candidate;
}
