import { IsOptional, IsString } from 'class-validator';

export class LaunchAssignmentDto {
  /** The live session to launch this task into ("Practice now"). Defaults to
   *  the session the assignment was already tied to when omitted. */
  @IsOptional()
  @IsString()
  sessionId?: string;
}
