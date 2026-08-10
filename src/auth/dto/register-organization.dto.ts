import {
  IsEmail,
  IsHexColor,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Company signup — creates the Organization and its first ORG_ADMIN together. */
export class RegisterOrganizationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  organizationName!: string;

  // ---- Admin account ----
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  // ---- Optional brand kit (can be edited later) ----
  @IsOptional()
  @IsString()
  @MaxLength(160)
  tagline?: string;

  @IsOptional()
  @IsHexColor()
  primaryColor?: string;

  @IsOptional()
  @IsHexColor()
  accentColor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string;
}
