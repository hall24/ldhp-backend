/** CSV import and export of customers and service history. */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { scopedOf } from '../auth/plugin.js';
import type { Db } from '../db/client.js';
import { exportCustomersCsv, importCustomersCsv, MAX_IMPORT_ROWS } from '../services/csv-import.js';
import { ErrorResponse, errorResponses, OrgHeader } from './schemas.js';

const secured = [{ bearerAuth: [] }];
const MAX_CSV_BYTES = 4 * 1024 * 1024;

const ImportReport = Type.Object(
  {
    summary: Type.Object({
      rows: Type.Integer(),
      valid_rows: Type.Integer(),
      error_rows: Type.Integer(),
      customers_created: Type.Integer(),
      customers_matched: Type.Integer({ description: 'Rows that matched an existing customer (nothing overwritten).' }),
      service_records_created: Type.Integer(),
      service_records_duplicate: Type.Integer({ description: 'Already on file (same customer, service and date).' }),
    }),
    columns: Type.Object({
      mapped: Type.Record(Type.String(), Type.String(), { description: 'Your column header -> our field.' }),
      ignored: Type.Array(Type.String()),
    }),
    errors: Type.Array(Type.Object({ line: Type.Integer(), messages: Type.Array(Type.String()) })),
    sample: Type.Array(
      Type.Object({
        line: Type.Integer(),
        display_name: Type.String(),
        customer: Type.Union([Type.Literal('create'), Type.Literal('match'), Type.Literal('error')]),
        service: Type.Union([
          Type.Literal('create'),
          Type.Literal('duplicate'),
          Type.Literal('none'),
          Type.Literal('error'),
        ]),
      }),
    ),
    applied: Type.Boolean({ description: 'True only when mode was "import" and the rows were saved.' }),
  },
  { title: 'ImportReport' },
);

export const dataRoutes: FastifyPluginAsyncTypebox<{ db: Db }> = async (app) => {
  app.post(
    '/imports/customers',
    {
      onRequest: app.requireOrg(),
      bodyLimit: MAX_CSV_BYTES + 64 * 1024,
      schema: {
        tags: ['import-export'],
        summary: 'Import customers and their last service from a CSV file',
        description:
          'Send the file contents as `csv`. Run with mode "preview" first: nothing is saved and you get a ' +
          'report. Then send the same file with mode "import". ' +
          'Columns (header names are flexible): name (required), email, phone, address, address2, city, state, ' +
          'zip, notes, service_type, last_service_date (YYYY-MM-DD or MM/DD/YYYY), interval_days. ' +
          'One row per customer, or several rows per customer for several past services. Existing customers ' +
          'are matched by customer_id, email, or name + address and never overwritten; services already on ' +
          'file are skipped, so re-importing a file is safe. Import is all-or-nothing unless ' +
          `skip_invalid_rows is true (400 import_has_errors). At most ${MAX_IMPORT_ROWS} rows. ` +
          'Contact permissions are not imported; record those separately.',
        security: secured,
        headers: OrgHeader,
        body: Type.Object(
          {
            csv: Type.String({ minLength: 1, maxLength: MAX_CSV_BYTES }),
            mode: Type.Union([Type.Literal('preview'), Type.Literal('import')]),
            skip_invalid_rows: Type.Optional(Type.Boolean({ default: false })),
          },
          { additionalProperties: false },
        ),
        response: { 200: ImportReport, ...errorResponses },
      },
    },
    async (req) =>
      importCustomersCsv(scopedOf(req), {
        csv: req.body.csv,
        mode: req.body.mode,
        skipInvalidRows: req.body.skip_invalid_rows ?? false,
      }),
  );

  app.get(
    '/exports/customers.csv',
    {
      onRequest: app.requireOrg(['owner']),
      schema: {
        tags: ['import-export'],
        summary: 'Download all customers and service history as CSV (owners only)',
        description:
          'One row per service record; customers without any appear once. The file re-imports cleanly. ' +
          'Cells that a spreadsheet would treat as formulas are prefixed with an apostrophe.',
        security: secured,
        headers: OrgHeader,
        produces: ['text/csv'],
        response: { 200: Type.String({ description: 'text/csv' }), 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { csv } = await exportCustomersCsv(scopedOf(req));
      const date = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="customers-${date}.csv"`)
        .header('cache-control', 'no-store')
        .send(csv);
    },
  );
};
