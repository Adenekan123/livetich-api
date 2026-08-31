import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Org-wide class preferences (all optional so a PATCH can flip one at a time). */
export class UpdateOrgSettingsDto {
  @IsOptional()
  @IsBoolean()
  evictOnInstructorLeave?: boolean;

  @IsOptional()
  @IsBoolean()
  micRequiresRaisedHand?: boolean;

  @IsOptional()
  @IsBoolean()
  preClassReminder?: boolean;

  /** Minutes before class start to email the reminder (5 min – 24 h). */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  reminderLeadMinutes?: number;
}
