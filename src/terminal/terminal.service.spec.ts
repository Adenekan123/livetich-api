import { Role } from '@prisma/client';
import { TerminalService } from './terminal.service';
import type { JwtPayload } from '../auth/jwt-payload';

describe('TerminalService', () => {
  let service: TerminalService;

  beforeEach(() => {
    service = new TerminalService();
  });

  const instructorUser: JwtPayload = {
    sub: 'inst_1',
    name: 'Instructor',
    email: 'inst@example.com',
    emailVerified: true,
    isSuperAdmin: false,
    role: Role.INSTRUCTOR,
    organizationId: 'org_1',
  };

  const student1: JwtPayload = {
    sub: 'stud_1',
    name: 'Student 1',
    email: 'student1@example.com',
    emailVerified: true,
    isSuperAdmin: false,
    role: Role.STUDENT,
    organizationId: 'org_1',
  };

  const student2: JwtPayload = {
    sub: 'stud_2',
    name: 'Student 2',
    email: 'student2@example.com',
    emailVerified: true,
    isSuperAdmin: false,
    role: Role.STUDENT,
    organizationId: 'org_1',
  };

  it('should open a terminal and retrieve it', () => {
    service.openTerminal(
      'sess_1',
      {
        terminalId: 'term_1',
        name: 'bash',
        cols: 80,
        rows: 24,
        interactive: true,
        writableBy: 'INSTRUCTOR_ONLY',
      },
      'socket_inst',
      'inst_1',
    );

    const terms = service.getTerminalsForSession('sess_1');
    expect(terms).toHaveLength(1);
    expect(terms[0].name).toBe('bash');
    expect(terms[0].cols).toBe(80);
    expect(terms[0].backlog).toBe('');
  });

  it('should append output and cap backlog to MAX_BACKLOG_BYTES (64KB)', () => {
    service.openTerminal(
      'sess_1',
      {
        terminalId: 'term_1',
        name: 'bash',
        cols: 80,
        rows: 24,
        interactive: true,
        writableBy: 'INSTRUCTOR_ONLY',
      },
      'socket_inst',
      'inst_1',
    );

    service.appendData('sess_1', 'term_1', 'Hello World!\n');
    let terms = service.getTerminalsForSession('sess_1');
    expect(terms[0].backlog).toBe('Hello World!\n');

    // Overflow test: 70KB
    const largeChunk = 'A'.repeat(70 * 1024);
    service.appendData('sess_1', 'term_1', largeChunk);

    terms = service.getTerminalsForSession('sess_1');
    expect(terms[0].backlog?.length).toBe(64 * 1024);
  });

  it('should enforce write permissions correctly', () => {
    service.openTerminal(
      'sess_1',
      {
        terminalId: 'term_1',
        name: 'bash',
        cols: 80,
        rows: 24,
        interactive: true,
        writableBy: 'INSTRUCTOR_ONLY',
      },
      'socket_inst',
      'inst_1',
    );

    // Instructor can write
    expect(service.canSendStdin('sess_1', 'term_1', instructorUser)).toBe(true);
    // Student cannot write in INSTRUCTOR_ONLY mode
    expect(service.canSendStdin('sess_1', 'term_1', student1)).toBe(false);

    // Delegate to student1
    service.updatePermission('sess_1', 'term_1', 'DELEGATED', ['stud_1']);
    expect(service.canSendStdin('sess_1', 'term_1', student1)).toBe(true);
    expect(service.canSendStdin('sess_1', 'term_1', student2)).toBe(false);

    // Open to all
    service.updatePermission('sess_1', 'term_1', 'OPEN');
    expect(service.canSendStdin('sess_1', 'term_1', student2)).toBe(true);
  });

  it('should clean up when host socket disconnects', () => {
    service.openTerminal(
      'sess_1',
      {
        terminalId: 'term_1',
        name: 'bash',
        cols: 80,
        rows: 24,
        interactive: true,
        writableBy: 'INSTRUCTOR_ONLY',
      },
      'socket_inst',
      'inst_1',
    );

    const removed = service.cleanupSocket('socket_inst');
    expect(removed).toEqual([{ sessionId: 'sess_1', terminalId: 'term_1' }]);
    expect(service.getTerminalsForSession('sess_1')).toHaveLength(0);
  });
});
