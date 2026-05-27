import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { QueryEventsDto } from './dto/query-events.dto';
import { EventsService } from './events.service';

@Controller('events')
@UseGuards(ApiKeyGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  async list(@Query() query: QueryEventsDto) {
    const result = await this.events.query({
      kind: query.kind,
      key: query.key,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
    });

    return {
      events: result.events.map((e) => ({
        occurred_at: e.occurredAt.toISOString(),
        payload: e.payload,
      })),
      next_cursor: result.nextCursor,
    };
  }
}
