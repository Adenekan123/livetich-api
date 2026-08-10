import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

/**
 * Transactional email via Resend. When RESEND_API_KEY is unset (local dev), it
 * logs the message instead of sending, so email-driven flows stay testable
 * without a provider. Delivery failures are swallowed so callers (e.g. the
 * forgot-password endpoint) never reveal whether an address exists.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('RESEND_API_KEY');
    this.resend = key ? new Resend(key) : null;
    this.from =
      this.config.get<string>('MAIL_FROM') ??
      'livetich <onboarding@resend.dev>';
  }

  async sendPasswordReset(to: string, name: string, url: string): Promise<void> {
    const subject = 'Reset your livetich password';
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0a0a0a">Reset your password</h2>
        <p style="color:#404040">Hi ${escapeHtml(name)}, we received a request to
        reset your livetich password. This link is valid for 30 minutes.</p>
        <p style="margin:24px 0">
          <a href="${url}" style="background:#0a0a0a;color:#fff;padding:12px 20px;
          border-radius:9999px;text-decoration:none;font-weight:600">Reset password</a>
        </p>
        <p style="color:#737373;font-size:13px">If you didn't request this, you can
        safely ignore this email.</p>
      </div>`;

    await this.send(to, subject, html, `password reset link for ${to}: ${url}`);
  }

  async sendVerificationOtp(
    to: string,
    name: string,
    code: string,
  ): Promise<void> {
    const subject = 'Your livetich verification code';
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0a0a0a">Verify your email</h2>
        <p style="color:#404040">Hi ${escapeHtml(name)}, enter this code to
        finish setting up your livetich account. It expires in 10 minutes.</p>
        <p style="font-size:32px;font-weight:800;letter-spacing:8px;
        color:#0a0a0a;margin:24px 0">${escapeHtml(code)}</p>
        <p style="color:#737373;font-size:13px">If you didn't create an account,
        you can ignore this email.</p>
      </div>`;
    await this.send(to, subject, html, `verification code for ${to}: ${code}`);
  }

  async sendScheduleChanged(
    to: string,
    name: string,
    courseTitle: string,
    url: string,
  ): Promise<void> {
    const subject = `Class time changed — ${courseTitle}`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0a0a0a">Your class time changed</h2>
        <p style="color:#404040">Hi ${escapeHtml(name)}, the schedule for
        <strong>${escapeHtml(courseTitle)}</strong> was updated. Your calendar
        reminder is now out of date — please re-add it so you get reminded at the
        right time.</p>
        <p style="margin:24px 0">
          <a href="${url}" style="background:#0a0a0a;color:#fff;padding:12px 20px;
          border-radius:9999px;text-decoration:none;font-weight:600">Update my reminder</a>
        </p>
        <p style="color:#737373;font-size:13px">On the class page, tap
        <strong>Add to calendar</strong> again, then tap <strong>Add</strong> when
        your calendar opens.</p>
      </div>`;
    await this.send(to, subject, html, `schedule-change notice for ${to}: ${url}`);
  }

  private async send(
    to: string,
    subject: string,
    html: string,
    devSummary: string,
  ): Promise<void> {
    if (!this.resend) {
      this.logger.warn(`[mail:dev] No RESEND_API_KEY — ${devSummary}`);
      return;
    }
    try {
      await this.resend.emails.send({ from: this.from, to, subject, html });
    } catch (e) {
      this.logger.error(`Failed to send email to ${to}: ${String(e)}`);
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
