// MCP-сервер AnimForge: каждая команда ядра и адаптера — инструмент. Список строится из того же реестра, что у CLI,
// поэтому новая команда сразу появляется у агента. Инструмент sheet возвращает картинку — это «глаза» агента.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, call, listAll } from "../../cli/src/node.ts";

const toolName = (cmd: string) => "af_" + cmd.replace(/\./g, "_");
const jsonType = (t: string) => (t === "number" ? "number" : t === "boolean" ? "boolean" : t === "json" ? "object" : "string");

const server = new Server({ name: "animforge", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: listAll().map((c) => ({
    name: toolName(c.name),
    description: c.help,
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "папка проекта относительно корня AnimForge, например projects/fish-demo" },
        ...Object.fromEntries(Object.entries(c.args).map(([k, s]) => [k, { type: jsonType(s.type), description: s.help }])),
      },
      required: ["project", ...Object.entries(c.args).filter(([, s]) => s.required).map(([k]) => k)],
    },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const cmd = listAll().find((c) => toolName(c.name) === req.params.name);
  if (!cmd) return { content: [{ type: "text", text: `нет инструмента ${req.params.name}` }], isError: true };
  const { project, ...args } = (req.params.arguments ?? {}) as Record<string, any>;
  try {
    const res: any = await call(resolve(ROOT, String(project)), cmd.name, args);
    const content: any[] = [{ type: "text", text: JSON.stringify(res, null, 2) }];
    if (cmd.name === "sheet" && res?.out) content.push({ type: "image", data: readFileSync(res.out).toString("base64"), mimeType: "image/png" });
    return { content };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
