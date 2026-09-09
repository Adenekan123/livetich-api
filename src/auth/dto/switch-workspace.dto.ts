import { IsNotEmpty, IsString } from 'class-validator';

/** Body for POST /auth/switch-workspace — the org to make active. */
export class SwitchWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  organizationId!: string;
}
