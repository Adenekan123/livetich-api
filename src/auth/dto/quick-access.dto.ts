import { IsString, Matches } from 'class-validator';

/** Six digits. The strength rules that reject 111111 and 123456 live in
 *  QuickAccessService, so the message a student sees explains the actual
 *  problem rather than restating the format. */
export class SetQuickAccessDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Your code must be exactly 6 digits.' })
  passcode!: string;
}

export class RedeemQuickAccessDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Your code must be exactly 6 digits.' })
  passcode!: string;
}
