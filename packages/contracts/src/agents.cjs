const { z } = require('zod');

const AgentIdSchema = z.string().regex(/^[a-z][a-z0-9:._-]{0,127}$/);
const resourceId = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);
const list = item =>
  z
    .array(item)
    .max(128)
    .refine(values => new Set(values).size === values.length, 'Duplicate Agent resource');
const tool = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_*.-]+$/);
const AgentDefinitionSchema = z
  .object({
    id: AgentIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
    instructions: z.string().max(32768),
    domain: z.union([z.literal('*'), resourceId]),
    tools: list(tool).optional(),
    disallowedTools: list(tool).optional(),
    skills: list(resourceId).optional(),
    subagents: list(AgentIdSchema).optional(),
  })
  .strict();

module.exports = { AgentIdSchema, AgentDefinitionSchema };
