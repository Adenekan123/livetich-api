/** The sole account permitted to hold platform-admin access. */
const PLATFORM_ADMIN_EMAIL = 'mr.nekan123@gmail.com';

export function isConfiguredPlatformAdminEmail(
  email: string | null | undefined,
): boolean {
  return email?.trim().toLowerCase() === PLATFORM_ADMIN_EMAIL;
}
