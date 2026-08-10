import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateQuestionDto {
  @IsString()
  sectionId!: string;

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

  /** 0-based index into options; bounds are re-checked against options in the service. */
  @IsInt()
  @Min(0)
  correctIndex!: number;
}
