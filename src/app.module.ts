import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { EventsModule } from './events/events.module';
import { NatsModule } from './nats/nats.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule, PrismaModule, EventsModule, NatsModule, HealthModule],
})
export class AppModule {}
