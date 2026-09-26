import { generateKeyPairSync, createVerify } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { GitHubAppService } from './github-app.service';

/** A throwaway key pair, so signing is exercised for real without committing
 *  a private key to the repository. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function serviceWith(
  env: Record<string, string | undefined>,
): GitHubAppService {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new GitHubAppService(config);
}

const configured = () =>
  serviceWith({
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: 'livetich',
  });

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(segment, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

afterEach(() => jest.restoreAllMocks());

describe('configuration', () => {
  it('reports unconfigured instead of throwing at construction', () => {
    expect(() => serviceWith({})).not.toThrow();
    expect(serviceWith({}).isConfigured()).toBe(false);
  });

  it('treats a placeholder private key as unconfigured', () => {
    const svc = serviceWith({
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: '   ',
    });
    expect(svc.isConfigured()).toBe(false);
  });

  it('accepts a key whose newlines were escaped into one line', () => {
    const svc = serviceWith({
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    });
    expect(svc.isConfigured()).toBe(true);
    expect(() => svc.appJwt()).not.toThrow();
  });

  it('refuses to mint anything when unconfigured', async () => {
    const svc = serviceWith({});
    expect(() => svc.appJwt()).toThrow(ServiceUnavailableException);
    await expect(svc.installationToken('99')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('offers an install URL only when the slug is known', () => {
    expect(configured().installUrl()).toBe(
      'https://github.com/apps/livetich/installations/new',
    );
    expect(
      serviceWith({
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: privateKey,
      }).installUrl(),
    ).toBeNull();
  });
});

describe('appJwt', () => {
  it('is a verifiable RS256 token issued by the app', () => {
    const now = 1_700_000_000_000;
    const jwt = configured().appJwt(now);
    const [head, body, signature] = jwt.split('.');

    expect(decodeSegment(head)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(body)).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 9 * 60,
      iss: '123456',
    });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${head}.${body}`);
    verifier.end();
    expect(
      verifier.verify(publicKey, Buffer.from(signature, 'base64url')),
    ).toBe(true);
  });

  it('stays inside GitHub’s ten-minute ceiling', () => {
    const now = Date.now();
    const claims = decodeSegment(configured().appJwt(now).split('.')[1]);
    // What GitHub enforces is how far `exp` sits from now. The backdated `iat`
    // is clock-skew allowance and does not widen that window, so the span
    // between the two claims may touch the limit without exceeding it.
    expect((claims.exp as number) - now / 1000).toBeLessThanOrEqual(600);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(
      600,
    );
  });
});

describe('installationToken', () => {
  const ok = (token: string, expiresAt: string) =>
    ({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ token, expires_at: expiresAt }),
    }) as unknown as Response;

  it('mints a token and reuses it while it is still fresh', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        ok('ghs_first', new Date(Date.now() + 3600_000).toISOString()),
      );

    const svc = configured();
    await expect(svc.installationToken('42')).resolves.toBe('ghs_first');
    await expect(svc.installationToken('42')).resolves.toBe('ghs_first');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-mints once the cached token is close to expiring', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        ok('ghs_stale', new Date(Date.now() + 5_000).toISOString()),
      )
      .mockResolvedValueOnce(
        ok('ghs_fresh', new Date(Date.now() + 3600_000).toISOString()),
      );

    const svc = configured();
    await expect(svc.installationToken('42')).resolves.toBe('ghs_stale');
    await expect(svc.installationToken('42')).resolves.toBe('ghs_fresh');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps one token per installation, never crossing tenants', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        ok('ghs_a', new Date(Date.now() + 3600_000).toISOString()),
      )
      .mockResolvedValueOnce(
        ok('ghs_b', new Date(Date.now() + 3600_000).toISOString()),
      );

    const svc = configured();
    await expect(svc.installationToken('aaa')).resolves.toBe('ghs_a');
    await expect(svc.installationToken('bbb')).resolves.toBe('ghs_b');
    await expect(svc.installationToken('aaa')).resolves.toBe('ghs_a');
  });

  it('asks the org to reconnect when the installation is gone', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve(JSON.stringify({ message: 'Not Found' })),
    } as unknown as Response);

    await expect(configured().installationToken('42')).rejects.toThrow(
      /reconnect/i,
    );
  });

  it('does not cache a refusal', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: () => Promise.resolve(''),
    } as unknown as Response);

    const svc = configured();
    await expect(svc.installationToken('42')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(svc.installationToken('42')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forget() drops the cache so the next call re-mints', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        ok('ghs_x', new Date(Date.now() + 3600_000).toISOString()),
      );

    const svc = configured();
    await svc.installationToken('42');
    svc.forget('42');
    await svc.installationToken('42');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
