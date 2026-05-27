import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from './events.service';

describe('EventsService', () => {
  let service: EventsService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        {
          provide: PrismaService,
          useValue: {
            event: {
              create: jest.fn(),
              findMany: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(EventsService);
    prisma = moduleRef.get(PrismaService) as unknown as jest.Mocked<PrismaService>;
  });

  describe('record', () => {
    it('writes a row to the events table', async () => {
      const occurredAt = new Date('2026-05-27T10:00:00Z');
      await service.record({
        env: 'prod',
        kind: 'portfolio',
        key: 'francesc',
        subject: 'prod.portfolio.updated',
        payload: { foo: 'bar' },
        occurredAt,
      });

      expect(prisma.event.create).toHaveBeenCalledWith({
        data: {
          env: 'prod',
          kind: 'portfolio',
          key: 'francesc',
          subject: 'prod.portfolio.updated',
          payload: { foo: 'bar' },
          occurredAt,
        },
      });
    });

    it('defaults occurredAt to now when not provided', async () => {
      const before = Date.now();
      await service.record({
        env: 'prod',
        kind: 'price',
        key: 'AAPL',
        subject: 'prod.stock.price_updated',
        payload: { symbol: 'AAPL', price: 175 },
      });
      const createMock = prisma.event.create as unknown as jest.Mock;
      const call = createMock.mock.calls[0][0];
      const ts = (call.data as { occurredAt: Date }).occurredAt.getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('query', () => {
    it('returns rows ordered desc and applies default window/limit', async () => {
      const occurredAt = new Date('2026-05-27T09:00:00Z');
      (prisma.event.findMany as jest.Mock).mockResolvedValue([
        { occurredAt, payload: { slug: 'francesc' } },
      ]);

      const result = await service.query({ kind: 'portfolio', key: 'francesc' });

      expect(result.events).toHaveLength(1);
      expect(result.nextCursor).toBeNull();

      const args = (prisma.event.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({
        kind: 'portfolio',
        key: 'francesc',
        occurredAt: { gte: expect.any(Date), lte: expect.any(Date) },
      });
      expect(args.orderBy).toEqual({ occurredAt: 'desc' });
      expect(args.take).toBe(501); // default limit (500) + 1 for nextCursor probe
    });

    it('returns a nextCursor when there are more rows than the limit', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        occurredAt: new Date(`2026-05-27T0${i}:00:00Z`),
        payload: { i },
      }));
      (prisma.event.findMany as jest.Mock).mockResolvedValue(rows);

      const result = await service.query({ kind: 'price', key: 'AAPL', limit: 2 });

      expect(result.events).toHaveLength(2);
      expect(result.nextCursor).toBe(rows[1].occurredAt.toISOString());
    });
  });
});
