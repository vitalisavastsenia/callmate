import type { z } from "zod";
import type { ErrorCodeSchema } from "@callmate/contracts";

/** Only explicitly parsed HTTP inputs may produce a client validation error. */
export class RequestValidationError extends Error {
  readonly details: { path: string; message: string }[];
  constructor(error: z.ZodError) {
    super("Request validation failed");
    this.details = error.issues.map(issue => ({ path: issue.path.join("."), message: "Invalid value" }));
  }
}

export function parseRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestValidationError(result.error);
  return result.data;
}

export class CommandError extends Error {
  constructor(public status: number, public code: z.infer<typeof ErrorCodeSchema>, message: string) {
    super(message);
  }
}
