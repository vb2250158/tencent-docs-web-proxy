#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stateDirectory, loadSession, saveSession } from "./state.mjs";
import { TencentDocsClient } from "./client.mjs";
import { TranscriptionService } from "./service.mjs";
import { createProxyServer } from "./server.mjs";
import { publicError, ProxyError } from "./errors.mjs";
import { VERSION } from "./version.mjs";
import { ToolboxService } from "./toolbox-service.mjs";

const HELP = `Tencent Docs web transcription proxy ${VERSION}
Usage: node src/cli.mjs <command> [file-or-task-id] [options]
  login                    Sign in in a dedicated Chrome profile and save the session
  quota                    Read remaining transcription seconds
  history                  List Tencent Docs transcription records
  transcribe <media-file>  Upload and submit once; returns a durable task ID
  status <task-id>          Read task progress and result document URL
  wait <task-id>            Poll an existing task without resubmitting
  serve                    Start the local WebGUI and HTTP API
  tools                    List all tools in the toolbox
  mcp                      Start the Agent stdio MCP server
Options: --language 16k_zh --speakers --wait --request-id <id>
Runtime data is stored outside the repository. See README.md for API usage.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      language: { type: "string" },
      speakers: { type: "boolean" },
      wait: { type: "boolean" },
      "request-id": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command, argument] = positionals;
  if (!command || values.help) return console.log(HELP);
  const root = stateDirectory();
  if (command === "login") {
    const { chromium } = await import("playwright-core");
    const context = await chromium.launchPersistentContext(
      join(root, "login-profile"),
      { channel: "chrome", headless: false },
    );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto("https://docs.qq.com/open/toolkit/av-to-text.html");
      await terminal.question(
        "Sign in with QQ or WeChat in Chrome, then press Enter here to save the session privately. ",
      );
      const cookie = (await context.cookies("https://docs.qq.com/"))
        .map((item) => `${item.name}=${item.value}`)
        .join("; ");
      const client = TencentDocsClient.fromCookie(cookie);
      const quota = await client.quota();
      await saveSession(root, cookie);
      console.log(JSON.stringify({ authenticated: true, ...quota }));
    } finally {
      terminal.close();
      await context.close();
    }
    return;
  }
  if (
    ![
      "quota",
      "history",
      "transcribe",
      "status",
      "wait",
      "serve",
      "tools",
      "mcp",
    ].includes(command)
  )
    throw new ProxyError(
      "INVALID_COMMAND",
      "Use --help to list supported commands.",
      { status: 400 },
    );
  const client = TencentDocsClient.fromCookie(await loadSession(root));
  const service = new TranscriptionService(client, root);
  service.toolbox = new ToolboxService(client, root);
  if (command === "tools")
    return console.log(JSON.stringify(service.toolbox.catalog(), null, 2));
  if (command === "mcp")
    return (await import("./mcp-server.mjs")).startMcpServer(service.toolbox);
  if (command === "quota")
    return console.log(JSON.stringify(await client.quota(), null, 2));
  if (command === "history")
    return console.log(JSON.stringify(await client.history(), null, 2));
  if (command === "status" || command === "wait")
    return console.log(
      JSON.stringify(await client[command](argument), null, 2),
    );
  if (command === "transcribe") {
    if (!argument)
      throw new ProxyError(
        "FILE_REQUIRED",
        "Provide the audio or video file path.",
        { status: 400 },
      );
    const result = await service.submitFile(argument, {
      requestId: values["request-id"],
      language: values.language,
      speakerDiarization: values.speakers,
    });
    console.log(JSON.stringify(result, null, 2));
    if (values.wait)
      console.log(JSON.stringify(await client.wait(result.taskId), null, 2));
    return;
  }
  const port = Number(process.env.TDOCS_PROXY_PORT ?? 17832);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ProxyError(
      "INVALID_PORT",
      "TDOCS_PROXY_PORT must be between 1 and 65535.",
      { status: 400 },
    );
  const aliasPort = process.env.TDOCS_PROXY_ALIAS_PORT
    ? Number(process.env.TDOCS_PROXY_ALIAS_PORT)
    : null;
  if (
    aliasPort !== null &&
    (!Number.isInteger(aliasPort) || aliasPort < 1 || aliasPort > 65535)
  ) {
    throw new ProxyError(
      "INVALID_PORT",
      "TDOCS_PROXY_ALIAS_PORT must be between 1 and 65535.",
      { status: 400 },
    );
  }
  const ports = [
    ...new Set([port, aliasPort].filter((value) => value !== null)),
  ];
  const servers = [];
  try {
    for (const listenPort of ports) {
      const server = createProxyServer(service, {
        root,
        logger: (event) => console.error(JSON.stringify(event)),
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, "127.0.0.1", resolve);
      });
      servers.push(server);
      console.error(
        JSON.stringify({
          listening: `http://127.0.0.1:${listenPort}`,
          webGui: server.webGuiUrl(),
        }),
      );
    }
  } catch (error) {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
    throw error;
  }
  const stop = async () => {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
    await service.toolbox.official.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error(JSON.stringify({ error: publicError(error).toJSON() }));
  process.exitCode = 1;
});
