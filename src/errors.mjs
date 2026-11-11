/** A public error containing only deliberately selected diagnostic fields. */
export class ProxyError extends Error {
  constructor(code, message, { status = 502, details = {} } = {}) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, ...this.details };
  }
}

/** Keep unexpected implementation failures, upstream bodies and credentials private. */
export function publicError(error) {
  return error instanceof ProxyError
    ? error
    : new ProxyError('INTERNAL_ERROR', 'The operation failed. Check local configuration and retry the read operation.', { status: 500 });
}
