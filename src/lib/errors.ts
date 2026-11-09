/** Consistent error envelope: { error: { code, message, request_id } } (PRD §9). */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  unauthenticated: () => new ApiError(401, 'unauthenticated', 'A valid session token is required.'),
  orgRequired: () =>
    new ApiError(400, 'organization_required', 'Select an organization with the X-Organization-Id header.'),
  // Deliberately identical for "org does not exist" and "not a member" so callers
  // cannot probe for other workspaces.
  forbiddenOrg: () => new ApiError(403, 'forbidden', 'You do not have access to this organization.'),
  forbiddenRole: () => new ApiError(403, 'forbidden', 'Your role does not allow this action.'),
  notFound: (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found.`),
  conflict: (msg: string) => new ApiError(409, 'conflict', msg),
  validation: (details: unknown) =>
    new ApiError(400, 'validation_error', 'Request validation failed.', details),
};
