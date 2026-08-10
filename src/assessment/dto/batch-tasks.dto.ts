import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class BatchTaskItem {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  instructions?: string;
}

/** Save a reviewed batch of AI-drafted remediation tasks into one section. */
export class BatchTasksDto {
  @IsString()
  sectionId!: string;

  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => BatchTaskItem)
  tasks!: BatchTaskItem[];
}
