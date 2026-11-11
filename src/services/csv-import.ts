/**
 * Bring a pro's existing customer list in from a spreadsheet, and take it back out
 * (PRD §4 step 2). One CSV row = one customer and, optionally, their last service.
 *
 * Import is preview-first: `mode: "preview"` validates every row and reports what
 * would happen without writing anything; `mode: "import"` applies it in one
 * transaction. Re-importing the same file doesn't duplicate customers (matched by
 * customer_id, then email, then name + address) or service records (same customer,
 * service and date).
 *
 * Consent is never imported: a spreadsheet column is not evidence of permission.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { customers, serviceRecords } from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { ScopedContext } from './context.js';
import { addDays, isValidIsoDate, todayInZone } from '../lib/dates.js';
import { ApiError } from '../lib/errors.js';
import { csvLine, CsvError, parseCsv } from '../lib/csv.js';

export const MAX_IMPORT_ROWS = 5000;

type Field =
  | 'customer_id'
  | 'display_name'
  | 'email'
  | 'phone'
  | 'address_line1'
  | 'address_line2'
  | 'city'
  | 'region'
  | 'postal_code'
  | 'notes'
  | 'service_type'
  | 'completed_on'
  | 'interval_days';

/** Header spellings we accept, after lower-casing and turning spaces/punctuation into "_". */
const ALIASES: Record<Field, string[]> = {
  customer_id: ['customer_id', 'id'],
  display_name: ['display_name', 'name', 'customer', 'customer_name', 'full_name', 'client', 'client_name'],
  email: ['email', 'email_address', 'e_mail'],
  phone: ['phone', 'phone_number', 'mobile', 'cell', 'telephone'],
  address_line1: ['address_line1', 'address', 'address1', 'address_1', 'street', 'street_address', 'service_address'],
  address_line2: ['address_line2', 'address2', 'address_2', 'unit', 'apt', 'suite'],
  city: ['city', 'town'],
  region: ['region', 'state', 'province'],
  postal_code: ['postal_code', 'zip', 'zip_code', 'zipcode', 'postcode'],
  notes: ['notes', 'note', 'comments'],
  service_type: ['service_type', 'service', 'last_service_type', 'job_type'],
  completed_on: ['completed_on', 'last_service_date', 'last_service', 'service_date', 'date', 'last_visit'],
  interval_days: ['interval_days', 'interval', 'repeat_every_days', 'repeat_days', 'frequency_days'],
};

const MAX_LEN: Partial<Record<Field, number>> = {
  display_name: 200,
  email: 320,
  phone: 50,
  address_line1: 200,
  address_line2: 200,
  city: 100,
  region: 100,
  postal_code: 20,
  notes: 5000,
  service_type: 100,
};

const normHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Gutter Cleaning" -> "gutter_cleaning", matching how service types are stored. */
export const normServiceType = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Accepts YYYY-MM-DD and US M/D/YYYY. Two-digit years are refused as ambiguous. */
function parseDate(v: string): string | null {
  if (isValidIsoDate(v)) return v;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (!m) return null;
  const iso = `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** Undo the formula guard our own export adds ('=..., '+...). */
const unguard = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);

interface ParsedRow {
  line: number;
  customerId: string | null;
  customer: {
    displayName: string;
    email: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    notes: string | null;
  };
  service: { serviceType: string; completedOn: string; intervalDays: number | null } | null;
  errors: string[];
}

export interface ImportReport {
  summary: {
    rows: number;
    valid_rows: number;
    error_rows: number;
    customers_created: number;
    customers_matched: number;
    service_records_created: number;
    service_records_duplicate: number;
  };
  columns: { mapped: Record<string, string>; ignored: string[] };
  /** Rows with problems (first 500). `line` is the line number in the file, header = 1. */
  errors: { line: number; messages: string[] }[];
  /** What happens to the first 20 rows. */
  sample: {
    line: number;
    display_name: string;
    customer: 'create' | 'match' | 'error';
    service: 'create' | 'duplicate' | 'none' | 'error';
  }[];
  applied: boolean;
}

function parseFile(csv: string, today: string) {
  let table: string[][];
  try {
    table = parseCsv(csv);
  } catch (e) {
    if (e instanceof CsvError) throw new ApiError(400, 'csv_invalid', e.message);
    throw e;
  }
  if (table.length < 2) throw new ApiError(400, 'csv_invalid', 'The file needs a header row and at least one data row.');
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    throw new ApiError(400, 'csv_too_large', `At most ${MAX_IMPORT_ROWS} rows per import. Split the file and try again.`);
  }
  const header = table[0]!.map(normHeader);
  const index: Partial<Record<Field, number>> = {};
  const mapped: Record<string, string> = {};
  const ignored: string[] = [];
  header.forEach((h, i) => {
    const field = (Object.keys(ALIASES) as Field[]).find((f) => ALIASES[f].includes(h));
    if (field && index[field] === undefined) {
      index[field] = i;
      mapped[table[0]![i]!.trim()] = field;
    } else if (h) ignored.push(table[0]![i]!.trim());
  });
  if (index.display_name === undefined) {
    throw new ApiError(400, 'csv_missing_columns', 'The file needs a "name" column (customer name).', {
      found: table[0],
    });
  }

  const rows: ParsedRow[] = table.slice(1).map((cells, i) => {
    const get = (f: Field) => {
      const at = index[f];
      if (at === undefined) return null;
      const v = unguard((cells[at] ?? '').trim());
      return v === '' ? null : v;
    };
    const errors: string[] = [];
    for (const [f, max] of Object.entries(MAX_LEN) as [Field, number][]) {
      const v = get(f);
      if (v && v.length > max) errors.push(`${f} is longer than ${max} characters`);
    }
    const displayName = get('display_name');
    if (!displayName) errors.push('name is required');
    const email = get('email')?.toLowerCase() ?? null;
    if (email && !EMAIL_RE.test(email)) errors.push(`email "${email}" doesn't look like an email address`);
    const rawId = get('customer_id');
    const customerId = rawId && UUID_RE.test(rawId) ? rawId.toLowerCase() : null;
    if (rawId && !customerId) errors.push('customer_id is not a valid id (leave it blank for new customers)');

    const st = get('service_type');
    const rawDate = get('completed_on');
    const rawInterval = get('interval_days');
    let service: ParsedRow['service'] = null;
    if (st || rawDate || rawInterval) {
      const completedOn = rawDate ? parseDate(rawDate) : null;
      if (!st) errors.push('service_type is required when a service date or interval is given');
      if (!rawDate) errors.push('last service date is required when a service is given');
      else if (!completedOn) errors.push(`date "${rawDate}" must be YYYY-MM-DD or MM/DD/YYYY`);
      else if (completedOn > addDays(today, 1)) errors.push(`date ${completedOn} is in the future`);
      let intervalDays: number | null = null;
      if (rawInterval) {
        intervalDays = /^\d+$/.test(rawInterval) ? Number(rawInterval) : NaN;
        if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 3650) {
          errors.push('interval_days must be a whole number of days from 1 to 3650');
        }
      }
      if (st && completedOn) service = { serviceType: normServiceType(st), completedOn, intervalDays };
    }
    return {
      line: i + 2,
      customerId,
      customer: {
        displayName: displayName ?? '',
        email,
        phone: get('phone'),
        addressLine1: get('address_line1'),
        addressLine2: get('address_line2'),
        city: get('city'),
        region: get('region'),
        postalCode: get('postal_code'),
        notes: get('notes'),
      },
      service,
      errors,
    };
  });
  return { rows, mapped, ignored };
}

const fold = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const nameAddrKey = (name: string, line1: string | null, postal: string | null) =>
  `${fold(name)}|${fold(line1)}|${fold(postal)}`;

export async function importCustomersCsv(
  ctx: ScopedContext,
  input: { csv: string; mode: 'preview' | 'import'; skipInvalidRows: boolean },
): Promise<ImportReport> {
  const { rows, mapped, ignored } = parseFile(input.csv, todayInZone(ctx.timeZone));
  const invalid = rows.filter((r) => r.errors.length);
  const report: ImportReport = {
    summary: {
      rows: rows.length,
      valid_rows: rows.length - invalid.length,
      error_rows: invalid.length,
      customers_created: 0,
      customers_matched: 0,
      service_records_created: 0,
      service_records_duplicate: 0,
    },
    columns: { mapped, ignored },
    errors: invalid.slice(0, 500).map((r) => ({ line: r.line, messages: r.errors })),
    sample: [],
    applied: false,
  };
  if (input.mode === 'import' && invalid.length && !input.skipInvalidRows) {
    throw new ApiError(
      400,
      'import_has_errors',
      `${invalid.length} row(s) have problems. Fix them, or import with skip_invalid_rows to leave them out.`,
      { errors: report.errors },
    );
  }

  const run = async (db: Db) => {
    // Existing customers and service records, to match against instead of duplicating.
    const existing = await db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        email: customers.email,
        addressLine1: customers.addressLine1,
        postalCode: customers.postalCode,
      })
      .from(customers)
      .where(and(eq(customers.organizationId, ctx.organizationId), isNull(customers.deletedAt)))
      .orderBy(asc(customers.createdAt));
    const byId = new Set(existing.map((c) => c.id));
    const byEmail = new Map<string, string>();
    const byNameAddr = new Map<string, string>();
    for (const c of existing) {
      if (c.email && !byEmail.has(c.email.toLowerCase())) byEmail.set(c.email.toLowerCase(), c.id);
      const k = nameAddrKey(c.displayName, c.addressLine1, c.postalCode);
      if (!byNameAddr.has(k)) byNameAddr.set(k, c.id);
    }
    const existingServices = new Set(
      (
        await db
          .select({ c: serviceRecords.customerId, t: serviceRecords.serviceType, d: serviceRecords.completedOn })
          .from(serviceRecords)
          .where(and(eq(serviceRecords.organizationId, ctx.organizationId), isNull(serviceRecords.deletedAt)))
      ).map((s) => `${s.c}|${s.t}|${s.d}`),
    );

    const newCustomers: (typeof customers.$inferInsert)[] = [];
    const newServices: (typeof serviceRecords.$inferInsert)[] = [];
    for (const r of rows) {
      if (r.errors.length) {
        if (report.sample.length < 20) {
          report.sample.push({ line: r.line, display_name: r.customer.displayName, customer: 'error', service: 'error' });
        }
        continue;
      }
      const key = nameAddrKey(r.customer.displayName, r.customer.addressLine1, r.customer.postalCode);
      let id =
        (r.customerId && byId.has(r.customerId) ? r.customerId : undefined) ??
        (r.customer.email ? byEmail.get(r.customer.email) : undefined) ??
        (r.customer.email ? undefined : byNameAddr.get(key));
      let customerAction: 'create' | 'match' = 'match';
      if (!id) {
        id = randomUUID();
        customerAction = 'create';
        newCustomers.push({ id, organizationId: ctx.organizationId, createdBy: ctx.actor.accountId, ...r.customer });
        byId.add(id);
        if (r.customer.email) byEmail.set(r.customer.email, id);
        else byNameAddr.set(key, id);
        report.summary.customers_created++;
      } else report.summary.customers_matched++;

      let serviceAction: 'create' | 'duplicate' | 'none' = 'none';
      if (r.service) {
        const sk = `${id}|${r.service.serviceType}|${r.service.completedOn}`;
        if (existingServices.has(sk)) {
          serviceAction = 'duplicate';
          report.summary.service_records_duplicate++;
        } else {
          existingServices.add(sk);
          serviceAction = 'create';
          report.summary.service_records_created++;
          newServices.push({
            organizationId: ctx.organizationId,
            customerId: id,
            serviceType: r.service.serviceType,
            completedOn: r.service.completedOn,
            intervalDays: r.service.intervalDays,
            nextDueOn: r.service.intervalDays ? addDays(r.service.completedOn, r.service.intervalDays) : null,
            createdBy: ctx.actor.accountId,
          });
        }
      }
      if (report.sample.length < 20) {
        report.sample.push({
          line: r.line,
          display_name: r.customer.displayName,
          customer: customerAction,
          service: serviceAction,
        });
      }
    }

    if (input.mode === 'import') {
      for (let i = 0; i < newCustomers.length; i += 500) await db.insert(customers).values(newCustomers.slice(i, i + 500));
      for (let i = 0; i < newServices.length; i += 500) {
        await db.insert(serviceRecords).values(newServices.slice(i, i + 500));
      }
      // One summary event, no personal data: the rows themselves are the record.
      await recordAudit(db, {
        actor: ctx.actor,
        organizationId: ctx.organizationId,
        action: 'customers.imported',
        recordType: 'organization',
        recordId: ctx.organizationId,
        requestId: ctx.requestId,
        after: { ...report.summary },
      });
      report.applied = true;
    }
  };

  if (input.mode === 'import') {
    await ctx.db.transaction(async (tx) => run(tx as unknown as Db));
  } else {
    await run(ctx.db);
  }
  return report;
}

export const EXPORT_COLUMNS = [
  'customer_id',
  'name',
  'email',
  'phone',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'zip',
  'notes',
  'suppressed',
  'service_type',
  'last_service_date',
  'interval_days',
  'next_due_on',
] as const;

/**
 * Every customer with their service history, one row per service record (customers
 * without any get one row). The column names re-import cleanly.
 */
export async function exportCustomersCsv(ctx: ScopedContext): Promise<{ csv: string; rows: number }> {
  const rows = await ctx.db
    .select({ c: customers, s: serviceRecords })
    .from(customers)
    .leftJoin(
      serviceRecords,
      and(
        eq(serviceRecords.customerId, customers.id),
        eq(serviceRecords.organizationId, customers.organizationId),
        isNull(serviceRecords.deletedAt),
      ),
    )
    .where(and(eq(customers.organizationId, ctx.organizationId), isNull(customers.deletedAt)))
    .orderBy(asc(customers.createdAt), asc(customers.id), asc(serviceRecords.completedOn));
  const lines = [csvLine([...EXPORT_COLUMNS])];
  for (const { c, s } of rows) {
    lines.push(
      csvLine([
        c.id,
        c.displayName,
        c.email,
        c.phone,
        c.addressLine1,
        c.addressLine2,
        c.city,
        c.region,
        c.postalCode,
        c.notes,
        c.suppressed,
        s?.serviceType,
        s?.completedOn,
        s?.intervalDays,
        s?.nextDueOn,
      ]),
    );
  }
  await recordAudit(ctx.db, {
    actor: ctx.actor,
    organizationId: ctx.organizationId,
    action: 'customers.exported',
    recordType: 'organization',
    recordId: ctx.organizationId,
    requestId: ctx.requestId,
    metadata: { rows: rows.length },
  });
  return { csv: lines.join('\r\n') + '\r\n', rows: rows.length };
}
