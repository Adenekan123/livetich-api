import { Readable } from 'node:stream';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { Role, SessionStatus } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import type { PrismaService } from '../prisma/prisma.service';
import type { ObjectStorage } from '../storage/object-storage';
import { BoardAssetController } from './board-asset.controller';

describe('BoardAssetController access and limits', () => {
  const sessionId = 'session-asset-test';
  const instructor: JwtPayload = {
    sub: 'teacher-1',
    role: Role.INSTRUCTOR,
    name: 'Teacher',
    email: 'teacher@example.test',
    organizationId: null,
    emailVerified: true,
    isSuperAdmin: false,
  };
  const student: JwtPayload = {
    sub: 'student-1',
    role: Role.STUDENT,
    name: 'Student',
    email: 'student@example.test',
    organizationId: null,
    emailVerified: true,
    isSuperAdmin: false,
  };
  let controller: BoardAssetController;
  let storage: jest.Mocked<ObjectStorage>;
  let redis: {
    eval: jest.Mock;
    sadd: jest.Mock;
    srem: jest.Mock;
    decr: jest.Mock;
    decrby: jest.Mock;
  };
  let prisma: PrismaService;
  let prismaMocks: {
    liveSession: { findUnique: jest.Mock };
    enrollment: { findUnique: jest.Mock };
  };
  let board: { isWritable: jest.Mock };

  beforeEach(() => {
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      getStream: jest
        .fn()
        .mockResolvedValue(Readable.from([Buffer.from('image')])),
      delete: jest.fn().mockResolvedValue(undefined),
      size: jest.fn().mockResolvedValue(8),
      signedUrl: jest.fn().mockResolvedValue(null),
    };
    redis = {
      eval: jest.fn().mockResolvedValue(1),
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      decrby: jest.fn().mockResolvedValue(0),
    };
    prismaMocks = {
      liveSession: {
        findUnique: jest.fn().mockResolvedValue({
          status: SessionStatus.LIVE,
          course: {
            id: 'course-1',
            instructorId: instructor.sub,
            organizationId: null,
          },
        }),
      },
      enrollment: {
        findUnique: jest.fn().mockResolvedValue({ id: 'enrollment-1' }),
      },
    };
    prisma = prismaMocks as unknown as PrismaService;
    board = { isWritable: jest.fn().mockReturnValue(false) };
    controller = new BoardAssetController(
      prisma,
      storage,
      redis as never,
      board as never,
    );
  });

  it('accepts a verified raster upload and returns a class-scoped URL', async () => {
    const result = await controller.upload(instructor, sessionId, {
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimetype: 'image/png',
      size: 8,
    });

    expect(result.url).toMatch(
      new RegExp(`^/api/files/board-asset/${sessionId}/`),
    );
    expect(storage.put.mock.calls[0]).toEqual([
      expect.stringMatching(/^board-asset\//),
      expect.any(Buffer),
      'image/png',
    ]);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('rejects a student upload while student drawing is closed', async () => {
    await expect(
      controller.upload(student, sessionId, {
        buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        mimetype: 'image/png',
        size: 8,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects SVG and content-type spoofing before reserving storage quota', async () => {
    await expect(
      controller.upload(instructor, sessionId, {
        buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
        mimetype: 'image/svg+xml',
        size: 29,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('enforces the atomic per-class asset quota', async () => {
    redis.eval.mockResolvedValueOnce(0);
    await expect(
      controller.upload(instructor, sessionId, {
        buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        mimetype: 'image/png',
        size: 8,
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(storage.put.mock.calls).toHaveLength(0);
  });

  it('rejects an asset read when its stored class does not match the requested class', async () => {
    storage.get.mockResolvedValueOnce(Buffer.from('another-session'));
    await expect(
      controller.serve(instructor, sessionId, 'asset-uuid'),
    ).rejects.toThrow('Board asset not found');
    expect(storage.getStream.mock.calls).toHaveLength(0);
  });

  it('does not accept new assets after a class has ended', async () => {
    prismaMocks.liveSession.findUnique.mockResolvedValueOnce({
      status: SessionStatus.ENDED,
      course: {
        id: 'course-1',
        instructorId: instructor.sub,
        organizationId: null,
      },
    });
    await expect(
      controller.upload(instructor, sessionId, {
        buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        mimetype: 'image/png',
        size: 8,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(redis.eval.mock.calls).toHaveLength(0);
  });

  it('requires current class membership before serving an asset', async () => {
    prismaMocks.enrollment.findUnique.mockResolvedValueOnce(null);
    await expect(
      controller.serve(student, sessionId, 'asset-uuid'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.size.mock.calls).toHaveLength(0);
  });

  it('serves a known raster asset to an authorized class instructor', async () => {
    storage.get
      .mockResolvedValueOnce(Buffer.from(sessionId))
      .mockResolvedValueOnce(Buffer.from('image/png'));
    const result = await controller.serve(instructor, sessionId, 'asset-uuid');
    expect(result).toBeDefined();
    expect(storage.getStream.mock.calls).toHaveLength(1);
  });
});
