/** A domain error carrying an HTTP status. REST maps it to `{ error, details }`; MCP maps it to an isError result. */
export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409 | 422 | 429,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string, details?: unknown) => new AppError(404, `${what} not found`, details);
export const badRequest = (message: string, details?: unknown) => new AppError(400, message, details);
export const conflict = (message: string, details?: unknown) => new AppError(409, message, details);
