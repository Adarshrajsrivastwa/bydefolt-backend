import mongoose from 'mongoose';
import { JobSeekerProfile } from '../models/JobSeekerProfile.js';
import { User } from '../models/User.js';
import { effectiveConnectionField } from '../util/connectionField.js';

export function displayUserName(u) {
  if (!u) return '';
  const o = typeof u.toObject === 'function' ? u.toObject() : u;
  const name = String(o.name ?? '').trim();
  if (name) return name;
  const email = String(o.email ?? '').trim().toLowerCase();
  if (email.includes('@')) {
    const local = email.split('@')[0]?.trim();
    if (local) return local.charAt(0).toUpperCase() + local.slice(1);
  }
  const bdId = String(o.bdId ?? '').trim();
  return bdId;
}

export function userCard(u) {
  if (!u) return null;
  const o = typeof u.toObject === 'function' ? u.toObject() : u;
  const bdId = String(o.bdId ?? '').trim();
  if (!bdId) return null;
  const name = displayUserName(o);
  return {
    bdId,
    name: name || bdId,
    headline: o.headline || '',
    field: effectiveConnectionField(o),
  };
}

export function cardFromStoredPreview(preview) {
  if (!preview) return null;
  const bdId = String(preview.bdId ?? '').trim();
  if (!bdId) return null;
  const name = String(preview.name ?? '').trim() || bdId;
  return {
    bdId,
    name,
    headline: preview.headline || '',
    field: preview.field || '',
  };
}

export async function partnerPhotoMap(partnerRows) {
  const seekerIds = partnerRows
    .filter(
      ({ partner }) =>
        partner &&
        typeof partner === 'object' &&
        partner._id &&
        partner.role === 'jobSeeker'
    )
    .map(({ partner }) => partner._id);
  if (seekerIds.length === 0) return new Map();
  const profiles = await JobSeekerProfile.find({ userId: { $in: seekerIds } })
    .select('userId profilePhotoUrl')
    .lean();
  return new Map(profiles.map((p) => [String(p.userId), p.profilePhotoUrl || '']));
}

export async function memberPreviewForUser(u, photoMap) {
  const card = userCard(u);
  if (!card || !u) return null;
  const id = String(u._id ?? '');
  const photo = u.role === 'jobSeeker' && id ? photoMap.get(id) || '' : '';
  return {
    ...card,
    role: u.role || 'jobSeeker',
    profilePhotoUrl: photo,
  };
}

export async function buildMemberPreviews(me, target) {
  const photoMap = await partnerPhotoMap([
    { partner: me },
    { partner: target },
  ]);
  const fromPreview = await memberPreviewForUser(me, photoMap);
  const toPreview = await memberPreviewForUser(target, photoMap);
  return { fromPreview, toPreview };
}

export async function usersByObjectIds(ids) {
  const unique = [
    ...new Set(
      ids
        .map((id) => String(id ?? '').trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];
  if (unique.length === 0) return new Map();
  const users = await User.find({ _id: { $in: unique } })
    .select('name bdId headline connectionField role email')
    .lean();
  return new Map(users.map((u) => [String(u._id), u]));
}

export function resolvePartnerUser(partnerRef, userMap) {
  if (!partnerRef) return null;
  if (typeof partnerRef === 'object' && partnerRef._id) {
    const id = String(partnerRef._id);
    const fromMap = userMap.get(id);
    if (fromMap) return fromMap;
    if (partnerRef.bdId) return partnerRef;
  }
  const id = String(partnerRef);
  if (mongoose.Types.ObjectId.isValid(id)) return userMap.get(id) ?? null;
  return null;
}
