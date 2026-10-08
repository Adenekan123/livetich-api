import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TurnstileVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secretKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.get<string>('CLOUDFLARE_TURNSTILE_SECRET_KEY')?.trim() || undefined;
    if (!this.secretKey) {
      this.logger.log(
        'CLOUDFLARE_TURNSTILE_SECRET_KEY is not set. Bot challenge verification is inactive (permissive mode).',
      );
    }
  }

  /**
   * Whether Cloudflare Turnstile verification is actively configured and enforced.
   */
  isEnabled(): boolean {
    return Boolean(this.secretKey);
  }

  /**
   * Validate a Turnstile token against Cloudflare's siteverify API.
   * If the secret key is not configured, the check passes immediately.
   */
  async validateToken(token?: string, remoteIp?: string): Promise<boolean> {
    if (!this.secretKey) {
      // In development or environments without Turnstile configured, bypass verification
      return true;
    }

    if (!token || !token.trim()) {
      throw new BadRequestException(
        'Security challenge verification is required. Please complete the captcha.',
      );
    }

    try {
      const formData = new URLSearchParams();
      formData.append('secret', this.secretKey);
      formData.append('response', token.trim());
      if (remoteIp) {
        formData.append('remoteip', remoteIp);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6_000);

      const response = await fetch(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          body: formData,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.error(
          `Cloudflare Turnstile API returned HTTP status ${response.status}`,
        );
        throw new BadRequestException(
          'Security challenge validation server error. Please retry.',
        );
      }

      const data = (await response.json()) as TurnstileVerifyResponse;

      if (!data.success) {
        this.logger.warn(
          `Cloudflare Turnstile rejected token from IP ${remoteIp ?? 'unknown'}: ${JSON.stringify(
            data['error-codes'] ?? [],
          )}`,
        );
        throw new BadRequestException(
          'Security challenge failed or expired. Please refresh and try again.',
        );
      }

      return true;
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error('Error contacting Cloudflare Turnstile verification API', err);
      throw new BadRequestException(
        'Could not verify security challenge at this time. Please try again.',
      );
    }
  }
}
