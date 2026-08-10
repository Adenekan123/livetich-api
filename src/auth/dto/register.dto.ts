import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** Student/instructor registration — always via an organization invite link. */
export class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt input limit
  password!: string;

  /** The invite token from the join link; determines org + role. */
  @IsString()
  @IsNotEmpty()
  inviteToken!: string;
}
