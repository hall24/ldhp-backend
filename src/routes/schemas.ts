import { Type, type TSchema } from '@sinclair/typebox';

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      request_id: Type.String(),
      details: Type.Optional(Type.Unknown()),
    }),
  },
  { title: 'Error' },
);

export const Address = Type.Object({
  line1: Nullable(Type.String()),
  line2: Nullable(Type.String()),
  city: Nullable(Type.String()),
  region: Nullable(Type.String()),
  postal_code: Nullable(Type.String()),
});

export const Customer = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    display_name: Type.String(),
    email: Nullable(Type.String()),
    phone: Nullable(Type.String()),
    address: Address,
    suppressed: Type.Boolean(),
    notes: Nullable(Type.String()),
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
  },
  { title: 'Customer' },
);

const optStr = (max: number) => Type.Optional(Nullable(Type.String({ maxLength: max })));

export const CustomerCreate = Type.Object(
  {
    display_name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Type.Optional(Nullable(Type.String({ format: 'email', maxLength: 320 }))),
    phone: optStr(40),
    address: Type.Optional(
      Type.Object(
        {
          line1: optStr(200),
          line2: optStr(200),
          city: optStr(100),
          region: optStr(100),
          postal_code: optStr(20),
        },
        { additionalProperties: false },
      ),
    ),
    notes: optStr(5000),
  },
  { title: 'CustomerCreate', additionalProperties: false },
);

export const ServiceRecord = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    customer_id: Type.String({ format: 'uuid' }),
    service_type: Type.String(),
    completed_on: Type.String({ format: 'date' }),
    interval_days: Nullable(Type.Integer()),
    next_due_on: Nullable(Type.String({ format: 'date' })),
    notes: Nullable(Type.String()),
    created_at: Type.String({ format: 'date-time' }),
  },
  { title: 'ServiceRecord' },
);

export const ServiceRecordCreate = Type.Object(
  {
    service_type: Type.String({ minLength: 1, maxLength: 100 }),
    completed_on: Type.String({ format: 'date' }),
    interval_days: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 3650 }))),
    notes: optStr(5000),
  },
  { title: 'ServiceRecordCreate', additionalProperties: false },
);

export const DueItem = Type.Object(
  {
    service_record_id: Type.String({ format: 'uuid' }),
    customer_id: Type.String({ format: 'uuid' }),
    customer_name: Type.String(),
    service_type: Type.String(),
    last_completed_on: Type.String({ format: 'date' }),
    next_due_on: Type.String({ format: 'date' }),
    days_until_due: Type.Integer(),
    status: Type.Union([Type.Literal('overdue'), Type.Literal('due_soon')]),
  },
  { title: 'DueItem' },
);

export const AuditEvent = Type.Object(
  {
    id: Type.Integer(),
    occurred_at: Type.String({ format: 'date-time' }),
    actor_type: Type.String(),
    actor_account_id: Nullable(Type.String()),
    actor_label: Nullable(Type.String()),
    action: Type.String(),
    outcome: Type.String(),
    record_type: Nullable(Type.String()),
    record_id: Nullable(Type.String()),
    request_id: Nullable(Type.String()),
  },
  { title: 'AuditEvent' },
);

export const OrgHeader = Type.Object({
  'x-organization-id': Type.String({
    format: 'uuid',
    description: 'Organization (workspace) context. The server verifies your membership.',
  }),
});

export const IdempotencyHeader = Type.Object({
  'x-organization-id': Type.String({ format: 'uuid' }),
  'idempotency-key': Type.Optional(
    Type.String({ maxLength: 200, description: 'Retries with the same key return the original response.' }),
  ),
});

export const errorResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
};

export const Page = <T extends TSchema>(item: T) =>
  Type.Object({ data: Type.Array(item), next_cursor: Nullable(Type.String()) });
