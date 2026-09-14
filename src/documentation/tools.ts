import { z } from "zod";
import type { ToolSpec } from "../agents/runtime.ts";
import { DocumentationService } from "./service.ts";
const engine = z.enum(["gamemaker", "godot"]);
export function documentationTools(service: DocumentationService): ToolSpec[] {
  const search = z.strictObject({ engine, query: z.string().min(1).max(200) });
  const read = z.strictObject({
    engine,
    url: z.string().url(),
    startLine: z.number().int().positive().default(1),
    maxLines: z.number().int().min(1).max(500).default(200),
  });
  return [
    {
      name: "search_documentation",
      description:
        "Search the selected official GameMaker or Godot documentation. Results are page identities; read pages before citing their contents.",
      schema: search,
      execute: async (args, context) => {
        const q = search.parse(args);
        const results = await service.search(q.engine, q.query, context.signal);
        return { text: JSON.stringify(results), details: results };
      },
    },
    {
      name: "read_documentation",
      description:
        "Read line-addressable official documentation; returns URL, version, fallback and content hash for citations.",
      schema: read,
      execute: async (args, context) => {
        const q = read.parse(args);
        const page = await service.read(q.engine, q.url, context.signal);
        const lines = page.text.split("\n");
        const text = lines
          .slice(q.startLine - 1, q.startLine - 1 + q.maxLines)
          .map((line, i) => `${q.startLine + i}: ${line}`)
          .join("\n");
        const { text: _body, ...citation } = page;
        return {
          text,
          details: {
            ...citation,
            startLine: q.startLine,
            totalLines: lines.length,
            nextLine:
              q.startLine + q.maxLines <= lines.length
                ? q.startLine + q.maxLines
                : null,
          },
        };
      },
    },
  ];
}
