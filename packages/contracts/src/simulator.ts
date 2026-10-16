import { z } from "zod";

// Selected in server configuration, not part of a real call request.
export const SimulatorScenarioSchema = z.enum([
  "within_plan", "no_availability", "approval_required", "changed_offer",
  "disconnect", "pending_reply", "busy", "no_answer", "provider_failure",
]);
export type SimulatorScenario = z.infer<typeof SimulatorScenarioSchema>;
