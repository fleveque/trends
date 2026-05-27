import { parseSubject } from './subject';

describe('parseSubject', () => {
  it('parses prod.portfolio.updated', () => {
    expect(parseSubject('prod.portfolio.updated')).toEqual({
      env: 'prod',
      kind: 'portfolio',
      keyFrom: 'slug',
    });
  });

  it('parses dev.radar.opted_in', () => {
    expect(parseSubject('dev.radar.opted_in')).toEqual({
      env: 'dev',
      kind: 'radar',
      keyFrom: 'slug',
    });
  });

  it('parses beta.stock.price_updated', () => {
    expect(parseSubject('beta.stock.price_updated')).toEqual({
      env: 'beta',
      kind: 'price',
      keyFrom: 'symbol',
    });
  });

  it('returns null for unknown shapes', () => {
    expect(parseSubject('prod.portfolio')).toBeNull();
    expect(parseSubject('something.weird.subject')).toBeNull();
    expect(parseSubject('prod.portfolio.deleted')).toBeNull();
  });
});
