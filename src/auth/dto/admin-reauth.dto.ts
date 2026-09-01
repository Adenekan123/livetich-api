import { IsString, MinLength } from 'class-validator';

export class AdminReauthDto {
  @IsString()
  @MinLength(1)
  password!: string;
}
