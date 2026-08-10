import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RegisterDto } from './dto/register.dto';
import { RegisterOrganizationDto } from './dto/register-organization.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { AllowUnverified, Public } from './jwt-auth.guard';
import type { JwtPayload } from './jwt-payload';

// Auth is the most-attacked surface — cap it well below the global limit.
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  /** Company signup: creates the org + its first admin. */
  @Public()
  @Post('register-organization')
  registerOrganization(@Body() dto: RegisterOrganizationDto) {
    return this.auth.registerOrganization(dto);
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Throttle({ default: { limit: 4, ttl: 60_000 } }) // email send — anti-bombing
  @HttpCode(200)
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.requestPasswordReset(dto.email);
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    return { ok: true };
  }

  @AllowUnverified()
  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return user;
  }

  /** Sends (or resends) the 6-digit verification code to the current user. */
  @AllowUnverified()
  @Throttle({ default: { limit: 4, ttl: 60_000 } }) // email send — anti-bombing
  @HttpCode(200)
  @Post('send-verification')
  async sendVerification(@CurrentUser() user: JwtPayload) {
    await this.auth.sendVerificationOtp(user.sub);
    return { ok: true };
  }

  /** Confirms the code and returns a fresh session token (now verified). */
  @AllowUnverified()
  @HttpCode(200)
  @Post('verify-email')
  verifyEmail(@CurrentUser() user: JwtPayload, @Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(user.sub, dto.code);
  }

  @HttpCode(200)
  @Post('change-password')
  changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.sub, dto.currentPassword, dto.newPassword);
  }
}
