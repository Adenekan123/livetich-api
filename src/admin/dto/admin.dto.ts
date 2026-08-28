import { Role, UserStatus } from '@prisma/client';
import { IsBoolean, IsEnum } from 'class-validator';

export class SetStatusDto {
  @IsEnum(UserStatus)
  status!: UserStatus;
}

export class SetRoleDto {
  @IsEnum(Role)
  role!: Role;
}

export class SetSuperAdminDto {
  @IsBoolean()
  value!: boolean;
}
