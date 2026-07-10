export class RigorError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "RigorError";
  }
}

export const EXIT = {
  success: 0,
  policyViolation: 2,
  inputError: 3,
  internalError: 4,
} as const;
