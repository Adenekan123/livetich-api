import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class BatchQuestionItem {
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  body!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  options!: string[];

  @IsInt()
  @Min(0)
  correctIndex!: number;
}

/** Save a reviewed batch of AI-drafted questions into one section's bank. */
export class BatchQuestionsDto {
  @IsString()
  sectionId!: string;

  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => BatchQuestionItem)
  questions!: BatchQuestionItem[];
}
