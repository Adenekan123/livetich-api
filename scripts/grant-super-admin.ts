/**
 * Grant (or revoke) the platform super-admin flag by email.
 *
 *   pnpm admin:grant you@example.com          # grant
 *   pnpm admin:grant you@example.com --revoke # revoke
 *
 * Runs against DATABASE_URL. In production the slim runner image doesn't carry
 * this script — use the SQL one-liner in deploy/ADMIN.md instead.
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const email = process.argv[2];
  const revoke = process.argv.includes('--revoke');
  if (!email) {
    console.error('Usage: pnpm admin:grant <email> [--revoke]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`No user with email ${email}`);
      process.exit(1);
    }
    await prisma.user.update({
      where: { email },
      data: { isSuperAdmin: !revoke },
    });
    console.log(
      `${revoke ? 'Revoked' : 'Granted'} platform super-admin for ${email}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
