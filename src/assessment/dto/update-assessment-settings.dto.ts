import { IsBoolean } from 'class-validator';

/** Per-course assessment release preference. */
export class UpdateAssessmentSettingsDto {
  /** true = release the class-end quiz to students the moment class ends. */
  @IsBoolean()
  instantClassAssessment!: boolean;
}
