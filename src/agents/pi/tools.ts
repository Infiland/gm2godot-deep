import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { z } from "zod";
import { DeepError } from "../../util/result.ts";
import { roleConfig } from "../roles.ts";
import type { ToolContext, ToolSpec } from "../runtime.ts";

export interface BuiltAgentTools {
  readonly tools: AgentTool[];
  /** The role's result tool. The SDK's terminating tool call; its `details` is the role result. */
  readonly resultToolName: string | null;
}

/**
 * Build the SDK tool list for one role from the host's `ToolSpec[]`.
 *
 * `parameters` must be a TypeBox schema; we build it by walking the zod schema rather than adding a
 * TypeBox dependency (Pi re-exports `Type`). Constraints (string length, numeric bounds, regexes) are
 * deliberately dropped: the server still re-parses every call with the authoritative zod schema inside
 * `execute`, so the schema sent to the provider only has to describe the *shape* faithfully — objects,
 * arrays, enums, optionals — which is what a model needs to produce a valid call. Anything this walker
 * cannot express throws `GM2DEEP-PI-TOOL-SCHEMA-UNSUPPORTED` naming the zod node instead of silently
 * sending a weaker schema.
 */
export function zodToTypeBox(schema: z.core.$ZodType): TSchema {
  if (schema instanceof z.ZodString) return Type.String();
  if (schema instanceof z.ZodNumber) return Type.Number();
  if (schema instanceof z.ZodBoolean) return Type.Boolean();
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return Type.Unknown();
  if (schema instanceof z.ZodNull) return Type.Null();
  if (schema instanceof z.ZodArray) return Type.Array(zodToTypeBox(schema.def.element));
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, TSchema> = {};
    for (const [key, value] of Object.entries(schema.def.shape)) {
      properties[key] = zodToTypeBox(value);
    }
    return Type.Object(properties, { additionalProperties: false });
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return Type.Optional(zodToTypeBox(schema.def.innerType));
  }
  if (schema instanceof z.ZodNullable) {
    return typeboxUnion([zodToTypeBox(schema.def.innerType), Type.Null()]);
  }
  if (schema instanceof z.ZodReadonly) {
    return zodToTypeBox(schema.def.innerType);
  }
  if (schema instanceof z.ZodEnum) {
    return typeboxUnion(Object.values(schema.def.entries).map((value) => typeboxLiteral(value)));
  }
  if (schema instanceof z.ZodLiteral) {
    return typeboxUnion(schema.def.values.map((value) => typeboxLiteral(value)));
  }
  if (schema instanceof z.ZodUnion) {
    return typeboxUnion(schema.def.options.map((option) => zodToTypeBox(option)));
  }
  if (schema instanceof z.ZodRecord) {
    if (!(schema.def.keyType instanceof z.ZodString)) {
      throw new DeepError("GM2DEEP-PI-TOOL-SCHEMA-UNSUPPORTED", "only string-keyed records are supported", {
        node: "record",
        keyType: "non-string",
      });
    }
    return Type.Record(Type.String(), zodToTypeBox(schema.def.valueType));
  }
  if (schema instanceof z.ZodTuple) {
    return Type.Tuple(schema.def.items.map((item) => zodToTypeBox(item)));
  }
  throw new DeepError("GM2DEEP-PI-TOOL-SCHEMA-UNSUPPORTED", "cannot express this zod node as a TypeBox schema", {
    node: String(schema._zod.def.type),
  });
}

/** TypeBox literals are JSON scalars; zod's `Literal` also admits `undefined`, which is not expressible. */
function typeboxLiteral(value: unknown): TSchema {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Type.Literal(value);
  }
  if (value === null) return Type.Null();
  throw new DeepError("GM2DEEP-PI-TOOL-SCHEMA-UNSUPPORTED", "only string, number, boolean and null literals are supported", {
    node: "literal",
    valueType: typeof value,
  });
}

/** `Type.Union` wants a non-empty tuple; a single member is just that member. */
function typeboxUnion(members: readonly TSchema[]): TSchema {
  const [first, second, ...rest] = members;
  if (first === undefined) {
    throw new DeepError("GM2DEEP-PI-TOOL-SCHEMA-UNSUPPORTED", "a union with no members cannot be expressed", {
      node: "union",
    });
  }
  if (second === undefined) return first;
  return Type.Union([first, second, ...rest]);
}

function toAgentTool(spec: ToolSpec, context: ToolContext): AgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: zodToTypeBox(spec.schema),
    execute: async (_toolCallId: string, params: unknown) => {
      const parsed = spec.schema.safeParse(params);
      if (!parsed.success) {
        throw new DeepError("GM2DEEP-PI-TOOL-ARGS", `arguments for "${spec.name}" do not match its schema`, {
          issues: parsed.error.issues.slice(0, 20).map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        });
      }
      const outcome = await spec.execute(parsed.data, context);
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        details: outcome.details,
        terminate: outcome.terminate === true,
      };
    },
  };
}

/**
 * Convert every spec, verifying that the role's declared result tool is present. Without it the SDK has
 * no terminating call and every run would end `no_result`; failing loudly here is better than a silent
 * run that can never produce a result.
 */
export function buildAgentTools(specs: readonly ToolSpec[], context: ToolContext): BuiltAgentTools {
  const resultToolName = roleConfig(context.role).resultTool;
  const names = specs.map((spec) => spec.name);
  if (!names.includes(resultToolName)) {
    throw new DeepError("GM2DEEP-TOOL-UNKNOWN", `role ${context.role} is missing its result tool "${resultToolName}"`, {
      role: context.role,
      resultToolName,
      tools: names,
    });
  }
  return { tools: specs.map((spec) => toAgentTool(spec, context)), resultToolName };
}
