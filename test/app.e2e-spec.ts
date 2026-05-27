// End-to-end test that exercises the full pipeline:
//   publish to NATS  →  subscriber inserts into Postgres  →  HTTP returns row.
//
// Prerequisites (CI: started by GitHub Actions services; local: docker-compose):
//   * NATS  on localhost:4222
//   * Postgres on localhost:5432 with schema migrated
//
// Run with: npm run test:e2e
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { connect } from '@nats-io/transport-node';
type NatsConnection = Awaited<ReturnType<typeof connect>>;
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const API_KEY = 'e2e-key';
const SLUG = 'e2e-portfolio';

describe('Trends e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let nats: NatsConnection;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    process.env.NATS_HOST = process.env.NATS_HOST ?? 'localhost';
    process.env.NATS_PORT = process.env.NATS_PORT ?? '4222';
    process.env.NATS_ENV_PREFIX = 'dev';
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? 'postgresql://trends:trends@localhost:5432/trends?schema=public';
    process.env.TRENDS_API_KEYS = API_KEY;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    await prisma.event.deleteMany({ where: { key: SLUG } });

    nats = await connect({ servers: `${process.env.NATS_HOST}:${process.env.NATS_PORT}` });
  });

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { key: SLUG } });
    await nats?.drain();
    await app?.close();
  });

  it('records a portfolio.updated event and returns it via GET /events', async () => {
    nats.publish(
      'dev.portfolio.updated',
      JSON.stringify({ version: 2, slug: SLUG, base_currency: 'EUR', holdings: [] }),
    );
    await nats.flush();

    // The subscriber writes asynchronously — give it up to 2s to land.
    const deadline = Date.now() + 2000;
    let count = 0;
    while (Date.now() < deadline) {
      count = await prisma.event.count({ where: { key: SLUG, kind: 'portfolio' } });
      if (count > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(count).toBeGreaterThan(0);

    const res = await request(app.getHttpServer())
      .get('/events')
      .query({ kind: 'portfolio', key: SLUG, limit: 10 })
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(res.body.events).toHaveLength(count);
    expect(res.body.events[0].payload).toMatchObject({ slug: SLUG, base_currency: 'EUR' });
  });

  it('rejects requests without a valid API key', async () => {
    await request(app.getHttpServer())
      .get('/events')
      .query({ kind: 'portfolio', key: SLUG })
      .expect(401);

    await request(app.getHttpServer())
      .get('/events')
      .query({ kind: 'portfolio', key: SLUG })
      .set('X-API-Key', 'wrong')
      .expect(401);
  });
});
