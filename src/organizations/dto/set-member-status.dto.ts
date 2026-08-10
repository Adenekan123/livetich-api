import { IsEnum } from 'class-validator';
import { UserStatus } from '@prisma/client';

export class SetMemberStatusDto {
  /** ACTIVE re-enables login; DISABLED blocks login and ends active sessions. */
  @IsEnum(UserStatus)
  status!: UserStatus;
}
