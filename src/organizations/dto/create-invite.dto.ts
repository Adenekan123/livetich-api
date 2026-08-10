import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Role } from '@prisma/client';

export class CreateInviteDto {
  /** STUDENT or INSTRUCTOR (ORG_ADMIN is rejected in the service). */
  @IsEnum(Role)
  role!: Role;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  maxUses?: number;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
