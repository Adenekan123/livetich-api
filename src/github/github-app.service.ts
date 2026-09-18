import { createSign } from 'node:crypto';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Authentication for the Livetich GitHub App.
 *
 * Two credentials, and neither is a password. The app proves it is itself with
 * a short-lived JWT signed by its private key; it then exchanges that for an
 * *installation* token, which is what actually acts on one institution's
 * organisation. Installation tokens last an hour, are never written to the
 * database, and never leave the server — so a database leak grants no GitHub
 * access at all, and there is nothing to rotate but the app key itself.
 *
 * When the app is not configured this reports so rather than throwing at
 * construction. A workspace that cannot be provisioned should say that to one
 * instructor, not stop the API from booting for everybody else.
 */

/** GitHub rejects an app JWT older than 10 minutes; stay clear of the edge. */
const APP_JWT_TTL_SECONDS = 9 * 60;
/** Clock skew allowance on `iat`, as GitHub's own documentation recommends. */
const APP_JWT_BACKDATE_SECONDS = 60;
/** Renew an installation token this long before it actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export const GITHUB_API = 'https://api.github.com';

interface CachedToken {
  token: string;
  expiresAt: number;
}

@Injectable()
export class GitHubAppService {
  private readonly log = new Logger(GitHubAppService.name);
  private readonly appId: string;
  private readonly privateKey: string;
  /** installationId -> token. In-memory on purpose: a token is worth less than
   *  the round trip to store it, and it must not outlive the process. */
  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>('GITHUB_APP_ID')?.trim() ?? '';
    this.privateKey = normalizeKey(
      this.config.get<string>('GITHUB_APP_PRIVATE_KEY') ?? '',
    );
  }

  /** Whether the app has credentials. Callers degrade rather than crash. */
  isConfigured(): boolean {
    return Boolean(this.appId && this.privateKey);
  }

  /** The app's public slug, for sending an org owner to install it. */
  installUrl(): string | null {
    const slug = this.config.get<string>('GITHUB_APP_SLUG')?.trim();
    return slug ? `https://github.com/apps/${slug}/installations/new` : null;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'GitHub is not configured on this server yet',
      );
    }
  }

  /**
   * A JWT proving this is the app. Signed RS256 with the app private key —
   * built here rather than with a JWT library because it is three base64url
   * segments and a signature, and this avoids a dependency that would sit in
   * the trust path of every repository operation.
   */
  appJwt(now: number = Date.now()): string {
    this.assertConfigured();
    const seconds = Math.floor(now / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iat: seconds - APP_JWT_BACKDATE_SECONDS,
      exp: seconds + APP_JWT_TTL_SECONDS,
      iss: this.appId,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(
      JSON.stringify(payload),
    )}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(this.privateKey).toString('base64url');
    return `${signingInput}.${signature}`;
  }

  /**
   * An installation token for one institution's organisation, minted on demand
   * and cached until shortly before it expires.
   */
  async installationToken(installationId: string): Promise<string> {
    this.assertConfigured();
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return cached.token;
    }

    const res = await fetch(
      `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.appJwt()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!res.ok) {
      // The body can carry the token on success, so it is never logged; on
      // failure it carries only GitHub's reason, which is what we want.
      const reason = await safeReason(res);
      this.log.error(
        `Installation token refused for installation ${installationId}: ${res.status} ${reason}`,
      );
      this.tokens.delete(installationId);
      throw new ServiceUnavailableException(
        res.status === 404
          ? 'This workspace is no longer connected to GitHub — reconnect it'
          : 'GitHub refused the connection for this workspace',
      );
    }

    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body?.token) {
      throw new ServiceUnavailableException('GitHub returned no access token');
    }
    const expiresAt = body.expires_at
      ? Date.parse(body.expires_at)
      : Date.now() + 55 * 60_000;
    this.tokens.set(installationId, { token: body.token, expiresAt });
    return body.token;
  }

  /** Drop a cached token — used when GitHub rejects it mid-flight. */
  forget(installationId: string): void {
    this.tokens.delete(installationId);
  }
}

/** A .pem pasted into an env var usually arrives with escaped newlines. */
function normalizeKey(raw: string): string {
  const key = raw.trim().replace(/\\n/g, '\n');
  return key.includes('BEGIN') ? key : '';
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** GitHub's error body, if it is readable. Never throws. */
async function safeReason(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { message?: string };
    return parsed?.message ?? text.slice(0, 200);
  } catch {
    return res.statusText;
  }
}
