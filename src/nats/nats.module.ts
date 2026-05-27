import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { NatsService } from './nats.service';

@Module({
  imports: [EventsModule],
  providers: [NatsService],
})
export class NatsModule {}
