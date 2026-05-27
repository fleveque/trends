// Helper that emits a fake NATS event so you can exercise the full pipeline
// against a locally-running Trends instance.
//
// Usage:
//   docker compose -f docker-compose.dev.yml up -d
//   npm run dev                          # in another terminal
//   npm run publish:fake portfolio       # or `radar` or `price`

import { connect } from '@nats-io/transport-node';

const kind = (process.argv[2] ?? 'portfolio') as 'portfolio' | 'radar' | 'price';

const host = process.env.NATS_HOST ?? 'localhost';
const port = process.env.NATS_PORT ?? '4222';
const env = process.env.NATS_ENV_PREFIX ?? 'dev';

const PAYLOADS: Record<string, { subject: string; payload: Record<string, unknown> }> = {
  portfolio: {
    subject: `${env}.portfolio.updated`,
    payload: {
      version: 2,
      slug: 'fake-portfolio',
      base_currency: 'EUR',
      holdings: [
        {
          symbol: 'AAPL',
          currency: 'USD',
          quantity: 10,
          avg_price: 150,
          price: 175,
          value_in_base: 1620,
          value_in_usd: 1750,
        },
      ],
      stats: { yoc: 1.2, currentYield: 0.5, sectors: { Technology: 100 } },
    },
  },
  radar: {
    subject: `${env}.radar.updated`,
    payload: {
      version: 1,
      slug: 'fake-portfolio',
      base_currency: 'EUR',
      stocks: [
        {
          symbol: 'MSFT',
          name: 'Microsoft',
          currency: 'USD',
          sector: 'Technology',
          price: 410,
          target_price: 380,
          dividend_yield: 0.7,
          fifty_two_week_high: 470,
          fifty_two_week_low: 310,
          ma_200: 400,
        },
      ],
    },
  },
  price: {
    subject: `${env}.stock.price_updated`,
    payload: {
      symbol: 'AAPL',
      price: 178.5,
      currency: 'USD',
      updated_at: new Date().toISOString(),
    },
  },
};

const choice = PAYLOADS[kind];
if (!choice) {
  console.error(`Unknown kind: ${kind}. Use one of: portfolio | radar | price`);
  process.exit(1);
}

async function main() {
  const nc = await connect({ servers: `${host}:${port}` });
  nc.publish(choice.subject, JSON.stringify(choice.payload));
  await nc.flush();
  console.log(`Published ${choice.subject} →`, choice.payload);
  await nc.drain();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
