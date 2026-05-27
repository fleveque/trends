import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { EVENT_KINDS, EventKind } from '../event-kind';

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 5000;

export class QueryEventsDto {
  @IsEnum(EVENT_KINDS)
  kind!: EventKind;

  @IsString()
  key!: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}
