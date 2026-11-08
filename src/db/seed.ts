/**
 * Synthetic test data for local dev, tests and the MCP spike. Fictional names
 * and addresses only; never load real customer data here (PRD §13).
 */
import type { Db } from './client.js';
import { accounts, customers, memberships, organizations, serviceRecords } from './schema.js';
import { addDays, todayInZone } from '../lib/dates.js';

export const SEED = {
  orgA: '0a000000-0000-4000-8000-00000000000a',
  orgB: '0b000000-0000-4000-8000-00000000000b',
  ownerA: { id: 'a0000000-0000-4000-8000-000000000001', clerkUserId: 'user_test_owner_a' },
  staffA: { id: 'a0000000-0000-4000-8000-000000000002', clerkUserId: 'user_test_staff_a' },
  ownerB: { id: 'b0000000-0000-4000-8000-000000000001', clerkUserId: 'user_test_owner_b' },
  outsider: { id: 'c0000000-0000-4000-8000-000000000001', clerkUserId: 'user_test_outsider' },
  /** Org A test home with history: one overdue service, one due soon, one not due. */
  homeA1: 'a1000000-0000-4000-8000-000000000001',
  homeA2: 'a1000000-0000-4000-8000-000000000002',
  /** Org B test home: must never be visible to org A callers. */
  homeB1: 'b1000000-0000-4000-8000-000000000001',
} as const;

export async function seedSynthetic(db: Db, now: Date = new Date()) {
  const tz = 'America/New_York';
  const today = todayInZone(tz, now);

  await db.insert(organizations).values([
    { id: SEED.orgA, name: 'Test Gutter & Window Co', timeZone: tz, messageFromName: 'Test Gutter Co' },
    { id: SEED.orgB, name: 'Sample HVAC Services', timeZone: 'America/Chicago' },
  ]);
  await db.insert(accounts).values(
    [SEED.ownerA, SEED.staffA, SEED.ownerB, SEED.outsider].map((a) => ({
      id: a.id,
      clerkUserId: a.clerkUserId,
      displayName: a.clerkUserId,
    })),
  );
  await db.insert(memberships).values([
    { organizationId: SEED.orgA, accountId: SEED.ownerA.id, role: 'owner' as const },
    { organizationId: SEED.orgA, accountId: SEED.staffA.id, role: 'staff' as const },
    { organizationId: SEED.orgB, accountId: SEED.ownerB.id, role: 'owner' as const },
  ]);
  await db.insert(customers).values([
    {
      id: SEED.homeA1,
      organizationId: SEED.orgA,
      displayName: 'Test Home One',
      email: 'home1@example.test',
      phone: '+15555550101',
      addressLine1: '100 Synthetic Way',
      city: 'Exampleville',
      region: 'NJ',
      postalCode: '00001',
    },
    {
      id: SEED.homeA2,
      organizationId: SEED.orgA,
      displayName: 'Test Home Two',
      addressLine1: '200 Placeholder Ave',
      city: 'Exampleville',
      region: 'NJ',
      postalCode: '00001',
    },
    {
      id: SEED.homeB1,
      organizationId: SEED.orgB,
      displayName: 'Other Org Home',
      addressLine1: '900 Elsewhere Rd',
      city: 'Sampletown',
      region: 'IL',
      postalCode: '00009',
    },
  ]);

  const rec = (customerId: string, org: string, serviceType: string, daysAgo: number, interval: number | null) => {
    const completedOn = addDays(today, -daysAgo);
    return {
      organizationId: org,
      customerId,
      serviceType,
      completedOn,
      intervalDays: interval,
      nextDueOn: interval ? addDays(completedOn, interval) : null,
      notes: `Synthetic ${serviceType} record`,
      createdBy: null,
    };
  };
  await db.insert(serviceRecords).values([
    rec(SEED.homeA1, SEED.orgA, 'gutter_cleaning', 400, 180), // superseded by newer record below
    rec(SEED.homeA1, SEED.orgA, 'gutter_cleaning', 190, 180), // overdue by 10 days
    rec(SEED.homeA1, SEED.orgA, 'window_washing', 355, 365), // due in 10 days
    rec(SEED.homeA1, SEED.orgA, 'dryer_vent', 30, 365), // not due
    rec(SEED.homeA2, SEED.orgA, 'gutter_cleaning', 100, null), // no interval: never due
    rec(SEED.homeB1, SEED.orgB, 'hvac_tuneup', 200, 180), // other org, overdue
  ]);
  return SEED;
}
