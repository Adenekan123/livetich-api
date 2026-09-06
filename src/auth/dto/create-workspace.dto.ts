import { IsHexColor, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for POST /auth/create-workspace — an existing account spins up a new
 *  teaching space (org) and becomes its admin, without a second account. */
export class CreateWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  organizationName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  tagline?: string;

  @IsOptional()
  @IsHexColor()
  primaryColor?: string;
}
