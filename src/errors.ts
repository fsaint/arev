export const EXIT = {
  OK: 0,
  ERROR: 1,
  NOT_FOUND: 2,
  TIMEOUT: 3,
  APPROVED: 10,
  CHANGES_REQUESTED: 11,
  REJECTED: 12,
} as const;

export class ArevError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: number = EXIT.ERROR,
  ) {
    super(message);
    this.name = 'ArevError';
  }
}
