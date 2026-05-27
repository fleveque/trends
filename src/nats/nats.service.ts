import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect } from '@nats-io/transport-node';
import { Prisma } from '@prisma/client';

// `@nats-io/transport-node` re-exports its types through nested `exports`
// maps that TS's default `moduleResolution: node` doesn't follow. Derive
// the types from the runtime API instead — same shapes, no import needed.
type NatsConnection = Awaited<ReturnType<typeof connect>>;
type Subscription = ReturnType<NatsConnection['subscribe']>;
import type { Env } from '../config/env.schema';
import { EventsService } from '../events/events.service';
import { parseSubject, SUBSCRIPTIONS } from './subject';

@Injectable()
export class NatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsService.name);
  private connection?: NatsConnection;
  private subscriptions: Subscription[] = [];

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly events: EventsService,
  ) {}

  async onModuleInit() {
    const host = this.config.get('NATS_HOST', { infer: true });
    const port = this.config.get('NATS_PORT', { infer: true });
    const server = `${host}:${port}`;

    this.connection = await connect({
      servers: server,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
      name: 'trends',
    });

    this.logger.log(`Connected to NATS at ${server}`);

    for (const subject of SUBSCRIPTIONS) {
      const sub = this.connection.subscribe(subject);
      this.subscriptions.push(sub);
      this.consume(sub).catch((err) => {
        this.logger.error(`Subscription ${subject} failed`, err instanceof Error ? err.stack : err);
      });
      this.logger.log(`Subscribed to ${subject}`);
    }
  }

  async onModuleDestroy() {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    await this.connection?.drain();
  }

  private async consume(sub: Subscription) {
    for await (const msg of sub) {
      try {
        const payload = msg.json<Record<string, unknown>>();
        await this.handle(msg.subject, payload);
      } catch (err) {
        this.logger.error(
          `Failed to handle ${msg.subject}: ${(err as Error).message}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
  }

  private async handle(subject: string, payload: Record<string, unknown>) {
    const parsed = parseSubject(subject);
    if (!parsed) {
      this.logger.warn(`Unknown subject shape, skipping: ${subject}`);
      return;
    }

    const key = payload[parsed.keyFrom];
    if (typeof key !== 'string' || key.length === 0) {
      this.logger.warn(`Payload on ${subject} missing string '${parsed.keyFrom}' field, skipping`);
      return;
    }

    await this.events.record({
      env: parsed.env,
      kind: parsed.kind,
      key,
      subject,
      payload: payload as Prisma.InputJsonValue,
    });
  }
}
