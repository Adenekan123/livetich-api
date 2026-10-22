import { TunnelService } from './tunnel.service';
import type { Response } from 'express';

describe('TunnelService', () => {
  let service: TunnelService;

  beforeEach(() => {
    service = new TunnelService();
  });

  it('should register and retrieve forwarded ports for a session', () => {
    const port = service.registerPort(
      'sess_1',
      3000,
      'Next.js Dev App',
      'sock_host',
      'user_inst',
    );

    expect(port.port).toBe(3000);
    expect(port.label).toBe('Next.js Dev App');
    expect(port.targetUrl).toBe('http://localhost:3000');

    const list = service.getPortsForSession('sess_1');
    expect(list).toHaveLength(1);
    expect(list[0].port).toBe(3000);

    expect(service.getHostSocketForPort('sess_1', 3000)).toBe('sock_host');
  });

  it('should unregister port', () => {
    service.registerPort('sess_1', 3000, undefined, 'sock_host', 'user_inst');
    expect(service.unregisterPort('sess_1', 3000)).toBe(true);
    expect(service.getPortsForSession('sess_1')).toHaveLength(0);
  });

  it('should clean up ports when host socket disconnects', () => {
    service.registerPort('sess_1', 3000, undefined, 'sock_host', 'user_inst');
    service.registerPort('sess_1', 5173, undefined, 'sock_host', 'user_inst');

    const removed = service.cleanupSocket('sock_host');
    expect(removed).toHaveLength(2);
    expect(service.getPortsForSession('sess_1')).toHaveLength(0);
  });

  it('should stream response headers and chunks without accumulation', () => {
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      write: jest.fn().mockReturnThis(),
      end: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const reqId = 'test_req_1';
    service.registerPendingRequest(reqId, mockRes, jest.fn());

    // 1. Headers
    const headersHandled = service.handleResponseHeaders(reqId, 200, {
      'content-type': 'application/json',
      'x-frame-options': 'DENY', // Should be stripped for iframe compatibility
    });
    expect(headersHandled).toBe(true);
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.setHeader).toHaveBeenCalledWith('content-type', 'application/json');
    expect(mockRes.setHeader).not.toHaveBeenCalledWith('x-frame-options', 'DENY');

    // 2. Chunks
    const chunkHandled = service.handleResponseChunk(reqId, '{"status":"ok"}', false);
    expect(chunkHandled).toBe(true);
    expect(mockRes.write).toHaveBeenCalledWith(Buffer.from('{"status":"ok"}', 'utf-8'));

    // 3. End
    service.handleResponseEnd(reqId);
    expect(mockRes.end).toHaveBeenCalled();
  });
});
