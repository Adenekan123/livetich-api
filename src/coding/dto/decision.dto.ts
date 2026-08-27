import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** The instructor's ruling on an attempt — always overrides the AI. */
export enum DecisionKind {
  /** Passed. */
  PASS = 'PASS',
  /** Failed, no further attempt implied. */
  FAIL = 'FAIL',
  /** Returned for revision — the student may resubmit (if attempts remain). */
  RETURN = 'RETURN',
}

export class DecisionDto {
  @IsEnum(DecisionKind)
  decision!: DecisionKind;

  /** Final score 0–100 (overrides the AI's provisional score). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  finalScore?: number;

  /** Optional feedback sent to the student alongside the decision. */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  feedback?: string;
}
