import type { z } from "zod";
import type { ErrorCodeSchema } from "@callmate/contracts";

export class CommandError extends Error {
  constructor(public status: number, public code: z.infer<typeof ErrorCodeSchema>, message: string) {
    super(message);
  }
}
