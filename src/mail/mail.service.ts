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

  /**
   * Security tripwire — emails the operator when a sensitive platform event
   * fires (a new super-admin granted, an impersonation started). Best-effort.
   */
  async sendSecurityAlert(
    to: string,
    title: string,
    lines: string[],
  ): Promise<void> {
    const rows = lines
      .map(
        (l) =>
          `<p style="color:#404040;margin:4px 0;font-size:14px">${escapeHtml(l)}</p>`,
      )
      .join('');
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">
        <p style="color:#b91c1c;font-weight:700;font-size:12px;letter-spacing:1px;
        text-transform:uppercase;margin:0 0 8px">Livetich security alert</p>
        <h2 style="color:#0a0a0a;margin:0 0 12px">${escapeHtml(title)}</h2>
        ${rows}
        <p style="color:#737373;font-size:13px;margin-top:20px">If this wasn't you,
        treat the acting account as compromised: revoke its access and rotate
        credentials immediately.</p>
      </div>`;
    await this.send(to, `[Livetich security] ${title}`, html, `security alert → ${to}: ${title}`);
  }

  /** Nudge a student that their class starts soon. */
  async sendClassReminder(
    to: string,
    name: string,
    courseTitle: string,
    whenLabel: string,
    url: string,
  ): Promise<void> {
    const subject = `Starting soon — ${courseTitle}`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
        <p style="color:#16a34a;font-weight:700;font-size:12px;letter-spacing:1px;
        text-transform:uppercase;margin:0 0 8px">Class starting soon</p>
        <h2 style="color:#0a0a0a;margin:0 0 12px">${escapeHtml(courseTitle)}</h2>
        <p style="color:#404040">Hi ${escapeHtml(name)}, your class starts
        <strong>${escapeHtml(whenLabel)}</strong>. Join a few minutes early so
        you don't miss the start.</p>
        <p style="margin:24px 0">
          <a href="${url}" style="background:#0a0a0a;color:#fff;padding:12px 20px;
          border-radius:9999px;text-decoration:none;font-weight:600">Go to the class</a>
        </p>
      </div>`;
    await this.send(to, subject, html, `class reminder → ${to}: ${courseTitle} (${whenLabel})`);
  }

  /** Tell a student they've been added to a program. */
  async sendEnrolledInProgram(
    to: string,
    name: string,
    courseTitle: string,
    url: string,
  ): Promise<void> {
    const subject = `You've been added to ${courseTitle}`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
        <p style="color:#16a34a;font-weight:700;font-size:12px;letter-spacing:1px;
        text-transform:uppercase;margin:0 0 8px">New program</p>
        <h2 style="color:#0a0a0a;margin:0 0 12px">${escapeHtml(courseTitle)}</h2>
        <p style="color:#404040">Hi ${escapeHtml(name)}, you've been enrolled in
        <strong>${escapeHtml(courseTitle)}</strong> on livetich. Open the program
        to see the schedule, curriculum, and join live classes on meeting days.</p>
        <p style="margin:24px 0">
          <a href="${url}" style="background:#0a0a0a;color:#fff;padding:12px 20px;
          border-radius:9999px;text-decoration:none;font-weight:600">View the program</a>
        </p>
      </div>`;
    await this.send(to, subject, html, `enrolment notice → ${to}: ${courseTitle}`);
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
