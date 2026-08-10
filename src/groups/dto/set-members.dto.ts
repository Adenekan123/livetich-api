import { ArrayUnique, IsArray, IsString } from 'class-validator';

/** Replaces a group's full membership with the given enrolled students. */
export class SetMembersDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  studentIds!: string[];
}
