import {
  IsString,
  IsNotEmpty,
  MaxLength,
  Matches,
  IsOptional,
  IsBoolean,
} from "class-validator";

export class WpCliRunDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Matches(/^[a-zA-Z0-9_\-.:/=@% "']+$/, {
    message:
      "Command contains invalid or dangerous characters. Shell chaining (; & | ` $) is not permitted.",
  })
  command!: string;
}

export class WpSearchReplaceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  search!: string;

  @IsString()
  @MaxLength(500)
  replace!: string;

  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;

  @IsOptional()
  @IsBoolean()
  skip_transients?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  tables?: string;
}
