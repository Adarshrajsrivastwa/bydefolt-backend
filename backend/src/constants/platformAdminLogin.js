/**
 * Platform admin (owner) synced by `npm run seed`.
 * Listed emails use the normal login OTP flow (after password); other owners stay password-only.
 */
export const OWNER_LOGIN_REQUIRES_OTP = new Set(['bydefoltofficial@gmail.com']);

export const PLATFORM_ADMIN_ACCOUNT = {
  name: 'Platform admin',
  email: 'bydefoltofficial@gmail.com',
  password: 'admin@123',
  role: 'owner',
  phone: '9000070007',
  bdId: 'BYDEFOL0072026',
  emailVerified: true,
};
