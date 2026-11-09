import { describe, expect, it } from 'vitest';
import { addDays, isValidIsoDate, todayInZone } from '../src/lib/dates.js';

describe('dates', () => {
  it('adds days across month and leap boundaries', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('uses the organization time zone for "today"', () => {
    const instant = new Date('2026-11-08T03:00:00Z'); // still Nov 7 in New York
    expect(todayInZone('America/New_York', instant)).toBe('2026-11-07');
    expect(todayInZone('UTC', instant)).toBe('2026-11-08');
  });
  it('validates calendar dates', () => {
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2026-1-1')).toBe(false);
  });
});
