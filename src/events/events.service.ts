import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EventKind } from './event-kind';
import { DEFAULT_LIMIT } from './dto/query-events.dto';

export interface RecordEventInput {
  env: string;
  kind: EventKind;
  key: string;
  subject: string;
  payload: Prisma.InputJsonValue;
  occurredAt?: Date;
}

export interface QueryEventsInput {
  kind: EventKind;
  key: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface EventRow {
  occurredAt: Date;
  payload: Prisma.JsonValue;
}

export interface QueryResult {
  events: EventRow[];
  nextCursor: string | null;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordEventInput): Promise<void> {
    await this.prisma.event.create({
      data: {
        env: input.env,
        kind: input.kind,
        key: input.key,
        subject: input.subject,
        payload: input.payload,
        occurredAt: input.occurredAt ?? new Date(),
      },
    });
  }

  async query(input: QueryEventsInput): Promise<QueryResult> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const to = input.to ?? new Date();
    const from = input.from ?? new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.event.findMany({
      where: {
        kind: input.kind,
        key: input.key,
        occurredAt: { gte: from, lte: to },
      },
      orderBy: { occurredAt: 'desc' },
      take: limit + 1,
      select: { occurredAt: true, payload: true },
    });

    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? events[events.length - 1].occurredAt.toISOString() : null;

    return { events, nextCursor };
  }
}
