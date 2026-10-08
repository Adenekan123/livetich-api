/* eslint-disable @typescript-eslint/require-await */
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthCacheService } from './auth-cache.service';
import { AuthService } from './auth.service';

describe('AuthService.registerOrganization with initial plugins', () => {
  it('creates the organization, admin, and enables selected valid plugins', async () => {
    let createdPlugins: { organizationId: string; pluginKey: string }[] = [];
    let createdOrgName = '';
    let createdUserRole: Role | null = null;

    const tx = {
      organization: {
        create: async ({ data }: { data: { name: string; slug: string } }) => {
          createdOrgName = data.name;
          return { id: 'org-test-1', ...data };
        },
      },
      user: {
        create: async ({ data }: { data: { name: string; email: string; role: Role } }) => {
          createdUserRole = data.role;
          return {
            id: 'user-test-1',
            ...data,
            organizationId: 'org-test-1',
            emailVerified: false,
          };
        },
      },
      membership: {
        create: async () => ({}),
      },
      orgPlugin: {
        createMany: async ({ data }: { data: { organizationId: string; pluginKey: string }[] }) => {
          createdPlugins = data;
          return { count: data.length };
        },
      },
    };

    const prisma = {
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
      user: {
        findUnique: async () => null,
      },
      organization: {
        findUnique: async () => null,
      },
    } as unknown as PrismaService;

    const mail = {
      sendVerificationOtp: jest.fn().mockResolvedValue(undefined),
    } as unknown as MailService;

    const service = new AuthService(
      prisma,
      { sign: () => 'jwt-test-token' } as unknown as JwtService,
      mail,
      { get: () => undefined } as unknown as ConfigService,
      {} as AuthCacheService,
    );

    const result = await service.registerOrganization({
      organizationName: 'Atlas Coding Academy',
      name: 'Amara Okafor',
      email: 'amara@example.com',
      password: 'password123',
      pluginKeys: ['code-instruction', 'islamic-education', 'invalid-plugin-key'],
    });

    expect(createdOrgName).toBe('Atlas Coding Academy');
    expect(createdUserRole).toBe(Role.ORG_ADMIN);
    expect(result.accessToken).toBe('jwt-test-token');
    expect(result.user.name).toBe('Amara Okafor');

    // Only valid plugin keys should have been saved
    expect(createdPlugins).toEqual([
      { organizationId: 'org-test-1', pluginKey: 'code-instruction' },
      { organizationId: 'org-test-1', pluginKey: 'islamic-education' },
    ]);
  });
});
