import { Role } from '@prisma/client';
import { TerminalGateway } from './terminal.gateway';
import { TerminalService } from './terminal.service';

describe('TerminalGateway host ownership', () => {
  let terminalService: TerminalService;
  let gateway: TerminalGateway;

  const makeClient = (id: string, role: Role, userId: string) => ({
    id,
    data: {
      sessionIds: new Set(['session-1']),
      user: { sub: userId, role },
    },
    emit: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
  });

  beforeEach(() => {
    terminalService = new TerminalService();
    gateway = new TerminalGateway(
      {} as never,
      {} as never,
      terminalService,
      {} as never,
      {} as never,
    );
    gateway.server = { to: jest.fn(() => ({ emit: jest.fn() })) } as never;
    terminalService.openTerminal(
      'session-1',
      {
        terminalId: 'terminal-1',
        name: 'Instructor terminal',
        cols: 80,
        rows: 24,
        interactive: true,
        writableBy: 'INSTRUCTOR_ONLY',
      },
      'host-socket',
      'instructor-1',
    );
  });

  it('rejects learner output injection and terminal closure', () => {
    const learner = makeClient('learner-socket', Role.STUDENT, 'learner-1');
    const appendData = jest.spyOn(terminalService, 'appendData');
    const closeTerminal = jest.spyOn(terminalService, 'closeTerminal');

    gateway.onData(learner as never, {
      sessionId: 'session-1',
      terminalId: 'terminal-1',
      data: 'forged output',
    });
    gateway.onClose(learner as never, {
      sessionId: 'session-1',
      terminalId: 'terminal-1',
    });

    expect(appendData).not.toHaveBeenCalled();
    expect(closeTerminal).not.toHaveBeenCalled();
    expect(terminalService.getTerminalsForSession('session-1')).toHaveLength(1);
    expect(learner.emit).toHaveBeenCalledWith('error', {
      code: 'FORBIDDEN',
      message: expect.stringContaining('terminal host'),
    });
  });

  it('allows the creating instructor socket to publish and close its terminal', () => {
    const host = makeClient('host-socket', Role.INSTRUCTOR, 'instructor-1');

    gateway.onData(host as never, {
      sessionId: 'session-1',
      terminalId: 'terminal-1',
      data: 'trusted output',
    });
    expect(terminalService.getTerminalsForSession('session-1')[0].backlog).toBe('trusted output');

    gateway.onClose(host as never, {
      sessionId: 'session-1',
      terminalId: 'terminal-1',
    });
    expect(terminalService.getTerminalsForSession('session-1')).toHaveLength(0);
    expect(host.emit).not.toHaveBeenCalled();
  });

  it('rejects learner stdin even if the terminal advertises open access', () => {
    terminalService.updatePermission('session-1', 'terminal-1', 'OPEN');
    const learner = makeClient('learner-socket', Role.STUDENT, 'learner-1');
    const emit = jest.spyOn(gateway.server, 'to');

    gateway.onStdin(learner as never, {
      sessionId: 'session-1',
      terminalId: 'terminal-1',
      data: 'whoami\r',
    });

    expect(emit).not.toHaveBeenCalledWith('host-socket');
    expect(learner.emit).toHaveBeenCalledWith('error', {
      code: 'FORBIDDEN',
      message: expect.stringContaining('locked'),
    });
  });

  it('rejects attempts to enable open terminal input', () => {
    const host = makeClient('host-socket', Role.INSTRUCTOR, 'instructor-1');
    const updatePermission = jest.spyOn(terminalService, 'updatePermission');

    gateway.onPermission(host as never, {
      sessionId: 'session-1',
      terminalId: 'terminal-1',
      writableBy: 'OPEN',
    });

    expect(updatePermission).not.toHaveBeenCalled();
    expect(host.emit).toHaveBeenCalledWith('error', {
      code: 'FORBIDDEN',
      message: expect.stringContaining('isolated code execution'),
    });
  });

  it('routes learner input to the host only for a sandboxed terminal with open permission', () => {
    terminalService.openTerminal(
      'session-1',
      {
        terminalId: 'terminal-safe',
        name: 'Sandboxed terminal',
        cols: 80,
        rows: 24,
        interactive: true,
        sandboxed: true,
        writableBy: 'OPEN',
      },
      'host-socket',
      'instructor-1',
    );
    const learner = makeClient('learner-socket', Role.STUDENT, 'learner-1');
    const emit = jest.fn();
    jest.spyOn(gateway.server, 'to').mockReturnValue({ emit } as never);

    gateway.onStdin(learner as never, {
      sessionId: 'session-1',
      terminalId: 'terminal-safe',
      data: 'node main.js\r',
    });

    expect(gateway.server.to).toHaveBeenCalledWith('host-socket');
    expect(emit).toHaveBeenCalledWith('term:stdin', {
      sessionId: 'session-1',
      terminalId: 'terminal-safe',
      data: 'node main.js\r',
      fromUserId: 'learner-1',
    });
    expect(learner.emit).not.toHaveBeenCalled();
  });

  it('rejects oversized terminal input before routing it to the host', () => {
    terminalService.openTerminal(
      'session-1',
      {
        terminalId: 'terminal-safe',
        name: 'Sandboxed terminal',
        cols: 80,
        rows: 24,
        interactive: true,
        sandboxed: true,
        writableBy: 'OPEN',
      },
      'host-socket',
      'instructor-1',
    );
    const learner = makeClient('learner-socket', Role.STUDENT, 'learner-1');
    const route = jest.spyOn(gateway.server, 'to');

    gateway.onStdin(learner as never, {
      sessionId: 'session-1',
      terminalId: 'terminal-safe',
      data: 'x'.repeat(4097),
    });

    expect(route).not.toHaveBeenCalledWith('host-socket');
    expect(learner.emit).toHaveBeenCalledWith('error', {
      code: 'INVALID_INPUT',
      message: expect.stringContaining('4 KB'),
    });
  });
});
