export function anthropicErrorType(status) {
  return status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : status === 429 ? 'rate_limit_error' : status === 529 ? 'overloaded_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
}

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function fail(status, code, message) { throw new HttpError(status, code, message); }
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return res.destroy();
  const conflict = ['ER_DUP_ENTRY', 'ER_NO_REFERENCED_ROW_2'].includes(error.code);
  const status = error instanceof HttpError ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : conflict ? 409 : 500;
  if (error instanceof HttpError && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
  if (res.locals?.anthropicProtocol) return res.status(status).json({ type: 'error', error: {
    type: anthropicErrorType(status), message: status === 500 ? 'Internal server error' : error instanceof HttpError ? error.message : 'Request failed',
  }, request_id: res.getHeader('x-infergate-request-id') });
  res.status(status).json({ error: { message: status === 500 ? 'Internal server error' : conflict ? 'Conflicting or missing related record' : status === 413 ? 'Request body too large' : status === 400 && !(error instanceof HttpError) ? 'Malformed request' : error.message,
    type: error instanceof HttpError && error.type === 'usage_limit_error' ? error.type : status >= 500 ? 'server_error' : 'invalid_request_error', code: error instanceof HttpError ? error.code : String(status), param: null } });
}
