import {
  IsNumber,
  IsPositive,
  IsInt,
  IsOptional,
  IsString,
  IsEnum,
  IsDateString,
  IsArray,
  ArrayMinSize,
  Min,
  Max,
} from "class-validator";
import { PartialType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import { PaginationQueryDto } from "../../../common/dto/pagination-query.dto";

export class GenerateInvoiceDto {
  @IsNumber()
  @IsPositive()
  @IsInt()
  projectId!: number;

  @IsInt()
  @Min(2020)
  @Max(2100)
  fromYear!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  fromMonth!: number;

  @IsInt()
  @Min(2020)
  @Max(2100)
  toYear!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  toMonth!: number;
}

export class GenerateBulkInvoiceDto {
  @IsInt()
  @Min(2020)
  @Max(2100)
  fromYear!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  fromMonth!: number;

  @IsInt()
  @Min(2020)
  @Max(2100)
  toYear!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  toMonth!: number;
}

export class GenerateClientInvoiceDto {
  @IsInt()
  @IsPositive()
  clientId!: number;

  /** If omitted, all active projects of the client with a package are targeted. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  projectIds?: number[];

  @IsInt()
  @Min(2020)
  @Max(2100)
  fromYear!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  fromMonth!: number;

  @IsInt()
  @Min(2020)
  @Max(2100)
  toYear!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  toMonth!: number;
}

export class UpdateInvoiceDto {
  @IsOptional()
  @IsEnum(["draft", "sent", "paid", "overdue", "cancelled"])
  status?: "draft" | "sent" | "paid" | "overdue" | "cancelled";

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  due_date?: string;
}

export class QueryInvoicesDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  client_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  project_id?: number;

  @IsOptional()
  @IsEnum(["draft", "sent", "paid", "overdue", "cancelled"])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year?: number;
}
