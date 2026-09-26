import { IsOptional, IsString } from 'class-validator';

/** Which annotations to load. Every id is checked against the course. */
export class ListTajweedAnnotationsDto {
  /** The lesson. */
  @IsOptional()
  @IsString()
  sectionId?: string;

  /** A live session: its lesson's annotations, plus corrections made in it. */
  @IsOptional()
  @IsString()
  sessionId?: string;

  /** Staff only: one student's corrections. */
  @IsOptional()
  @IsString()
  studentId?: string;
}

/** For a delete made during class: the session to tell. */
export class TajweedSessionScopeDto {
  @IsOptional()
  @IsString()
  sessionId?: string;
}
