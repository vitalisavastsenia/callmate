import { DialogueProposalSchema } from "@callmate/contracts";

// Generate from the shared contract. Refinements still run locally: the API's
// JSON Schema subset cannot express time-zone consistency or transcript evidence.
function apiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(apiSchema);
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  // Structured Outputs requires every property, using null for optional slots.
  // Local contracts continue accepting old fixtures without those additive fields.
  const required = new Set(Array.isArray(object.required) ? object.required as string[] : []);
  const properties = object.properties as Record<string, unknown> | undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (["$schema", "minLength", "maxLength"].includes(key)) return [];
    if (key === "const") return [["enum", [child]]];
    if (key === "required" && properties) return [[key, Object.keys(properties)]];
    if (key === "properties" && properties) return [[key, Object.fromEntries(Object.entries(properties).map(([name, schema]) =>
      [name, required.has(name) ? apiSchema(schema) : { anyOf: [apiSchema(schema), { type: "null" }] }]))]];
    // The action discriminator makes these branches mutually exclusive.
    return [[key === "oneOf" ? "anyOf" : key, apiSchema(child)]];
  }));
}

export const dialogueResponseSchema = apiSchema(DialogueProposalSchema.toJSONSchema({ io: "input" }));
