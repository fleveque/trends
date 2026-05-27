import { EventKind } from '../events/event-kind';

/**
 * Subscriptions we register on the NATS bus. `*` is a single-token wildcard:
 * `*.portfolio.updated` matches `prod.portfolio.updated`, `dev.portfolio.updated`, etc.
 *
 * Quantic publishes these subjects (see dividend-portfolio repo). Pulse subscribes
 * to the same set; Trends mirrors that exact list so we never miss a domain event.
 */
export const SUBSCRIPTIONS: readonly string[] = [
  '*.portfolio.updated',
  '*.portfolio.opted_in',
  '*.radar.updated',
  '*.radar.opted_in',
  '*.stock.price_updated',
] as const;

export interface ParsedSubject {
  env: string;
  kind: EventKind;
  /** Field on the payload to extract the `key` from. */
  keyFrom: 'slug' | 'symbol';
}

/**
 * Parse a NATS subject like `prod.portfolio.updated` into the env prefix,
 * the domain kind (portfolio/radar/price), and which payload field carries
 * the natural key for indexing.
 *
 * Returns null for unknown shapes so the caller can skip rather than crash.
 */
export function parseSubject(subject: string): ParsedSubject | null {
  const parts = subject.split('.');
  if (parts.length < 3) return null;

  const [env, head, ...tail] = parts;
  const tailJoined = tail.join('.');

  if (head === 'portfolio' && (tailJoined === 'updated' || tailJoined === 'opted_in')) {
    return { env, kind: 'portfolio', keyFrom: 'slug' };
  }
  if (head === 'radar' && (tailJoined === 'updated' || tailJoined === 'opted_in')) {
    return { env, kind: 'radar', keyFrom: 'slug' };
  }
  if (head === 'stock' && tailJoined === 'price_updated') {
    return { env, kind: 'price', keyFrom: 'symbol' };
  }
  return null;
}
