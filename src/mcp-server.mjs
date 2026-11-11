import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { publicError } from "./errors.mjs";
import { VERSION } from "./version.mjs";

/** Expose the same toolbox jobs over stdio for local Agent clients. */
export async function startMcpServer(toolbox) {
  const server = new Server(
    { name: "tencent-docs-toolbox", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "tdocs_catalog",
        description: "列出腾讯文档工具箱、可用调用方式和文件限制。",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: "tdocs_limits",
        description:
          "读取当前账号的转写余额、文档积分、Buddy One 积分和每个工具已公开的限制。",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: "tdocs_job",
        description: "读取原任务的进度和结果，不重复提交。",
        inputSchema: {
          type: "object",
          properties: { jobId: { type: "string" } },
          required: ["jobId"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "tdocs_upload",
        description: "将用户选择的本地文件保存为私有输入，返回 artifact ID。",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, name: { type: "string" } },
          required: ["path", "name"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      ...toolbox.catalog().tools.map((tool) => ({
        name: `tdocs_${tool.id}`,
        description: `${tool.title}。${tool.execution === "provider" || tool.execution === "interactive" ? "原生交互步骤通过 user_action_required 返回，完成操作前保留该状态。" : "异步返回 job ID，继续调用 tdocs_job 查询。"} 只有 state=completed 才表示已取得结果。`,
        inputSchema: {
          type: "object",
          properties: {
            artifacts: {
              type: "array",
              items: { type: "string" },
              description: "tdocs_upload 返回的输入 ID",
            },
            options: {
              type: "object",
              description:
                "工具选项，例如 prompt、pages、markdown、language、questions。",
              additionalProperties: true,
            },
            requestId: {
              type: "string",
              description: "新任务使用稳定且唯一的编号，重试沿用原编号。",
            },
          },
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: tool.execution !== "local",
        },
      })),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args = {} } = request.params;
      let result;
      if (name === "tdocs_catalog") result = toolbox.catalog();
      else if (name === "tdocs_limits") result = await toolbox.limits.refresh();
      else if (name === "tdocs_job") result = await toolbox.status(args.jobId);
      else if (name === "tdocs_upload")
        result = await toolbox.artifacts.importFile(args.path, args.name);
      else
        result = await toolbox.run(
          name.replace(/^tdocs_/, ""),
          { artifacts: args.artifacts ?? [], options: args.options ?? {} },
          args.requestId ?? randomUUID(),
        );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: publicError(error).toJSON() }),
          },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
