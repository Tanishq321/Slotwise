// A custom error class carries an HTTP status, so route code can simply `throw`
// and the central error middleware turns it into a clean JSON response.
export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new AppError(400, msg, details);
export const unauthorized = (msg = 'Please log in') => new AppError(401, msg);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, msg);
export const notFound = (what = 'Resource') => new AppError(404, `${what} not found`);
export const conflict = (msg, details) => new AppError(409, msg, details);
