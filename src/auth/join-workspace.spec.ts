/* eslint-disable @typescript-eslint/require-await --
   The in-memory Prisma stands in for an async client, so its methods are async
   without awaiting anything. */
import { Role, type Invite } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthCacheService } from './auth-cache.service';
import { AuthService } from './auth.service';

/**
 * Redeeming a course-scoped invite link.
 *
 * The case worth pinning down is the second one: a student who already belongs
 * to the school and opens a link for another program. That used to return the
 * moment the membership was found, so the enrolment was never written and the
 * only symptom was "Not enrolled" at the door of a class they had just been
 * told they had joined. Belonging to a school and being enrolled in one of its
 * programs are different facts, and nothing about this is visible from the
 * outside — hence a test rather than a comment.
 */

const ORG = 'org-1';
const COURSE = 'course-1';
const USER = 'user-1';

const invite = (over: Partial<Invite> = {}): Invite => ({
  id: 'invite-1',
  organizationId: ORG,
  role: Role.STUDENT,
  courseId: COURSE,
  token: 'tok',
  label: null,
  createdById: 'admin-1',
  maxUses: null,
  uses: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date(),
  ...over,
});

interface Calls {
  membershipCreated: number;
  enrolmentCreated: number;
  usesIncremented: number;
  courseAssigned: number;
}

function build(options: {
  existingMembership?: { role: Role } | null;
  existingEnrolment?: boolean;
  inviteRow?: Invite;
}) {
  const calls: Calls = {
    membershipCreated: 0,
    enrolmentCreated: 0,
    usesIncremented: 0,
    courseAssigned: 0,
  };

  const tx = {
    invite: {
      findUnique: async () => options.inviteRow ?? invite(),
      update: async () => {
        calls.usesIncremented += 1;
        return {};
      },
    },
    membership: {
      findUnique: async () => options.existingMembership ?? null,
      create: async () => {
        calls.membershipCreated += 1;
        return {};
      },
    },
    enrollment: {
      findUnique: async () =>
        options.existingEnrolment ? { id: 'enr-1' } : null,
      create: async () => {
        calls.enrolmentCreated += 1;
        return {};
      },
    },
    course: {
      update: async () => {
        calls.courseAssigned += 1;
        return {};
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    user: {
      findUnique: async () => ({
        id: USER,
        name: 'Aisha Bello',
        email: 'aisha@example.com',
        emailVerified: true,
        isSuperAdmin: false,
      }),
    },
  } as unknown as PrismaService;

  const service = new AuthService(
    prisma,
    { sign: () => 'jwt' } as unknown as JwtService,
    {} as MailService,
    { get: () => undefined } as unknown as ConfigService,
    {} as AuthCacheService,
  );
  return { service, calls };
}

describe('AuthService.joinWorkspace — course-scoped links', () => {
  it('enrols a brand-new member and spends a use', async () => {
    const { service, calls } = build({ existingMembership: null });
    await service.joinWorkspace(USER, 'tok');
    expect(calls).toEqual({
      membershipCreated: 1,
      enrolmentCreated: 1,
      usesIncremented: 1,
      courseAssigned: 0,
    });
  });

  it('enrols a student who is already in the school', async () => {
    const { service, calls } = build({
      existingMembership: { role: Role.STUDENT },
    });
    await service.joinWorkspace(USER, 'tok');
    expect(calls.membershipCreated).toBe(0);
    // The regression: this was 0, so the student joined nothing.
    expect(calls.enrolmentCreated).toBe(1);
    expect(calls.usesIncremented).toBe(1);
  });

  it('does nothing, and spends nothing, on a second opening', async () => {
    const { service, calls } = build({
      existingMembership: { role: Role.STUDENT },
      existingEnrolment: true,
    });
    await service.joinWorkspace(USER, 'tok');
    expect(calls).toEqual({
      membershipCreated: 0,
      enrolmentCreated: 0,
      usesIncremented: 0,
      courseAssigned: 0,
    });
  });

  it('does not demote an existing instructor to a student', async () => {
    const { service, calls } = build({
      existingMembership: { role: Role.INSTRUCTOR },
    });
    const result = await service.joinWorkspace(USER, 'tok');
    // Their standing decides what the link may do, not the role on the invite.
    expect(calls.enrolmentCreated).toBe(0);
    expect(calls.courseAssigned).toBe(1);
    expect(result.user.role).toBe(Role.INSTRUCTOR);
  });

  it('refuses a revoked link', async () => {
    const { service } = build({
      inviteRow: invite({ revokedAt: new Date() }),
    });
    await expect(service.joinWorkspace(USER, 'tok')).rejects.toThrow(
      'This invite link is not valid',
    );
  });

  it('refuses a link that has been used up', async () => {
    const { service } = build({
      inviteRow: invite({ maxUses: 2, uses: 2 }),
    });
    await expect(service.joinWorkspace(USER, 'tok')).rejects.toThrow('used up');
  });
});
