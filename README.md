# 腾讯文档工具箱

本地 WebGUI、HTTP API 和 Agent MCP，接入腾讯文档工具箱的 43 项工具。使用自己的腾讯文档账号处理文件，查看积分、转写时长、文件限制和任务结果。

Tencent Docs toolbox with a local WebGUI, live entitlements, HTTP API and Agent MCP tools.

## 开始使用

需要 Node.js 24.15+，首次登录需要 Google Chrome。

```sh
npm ci --ignore-scripts
node src/cli.mjs login
npm start
```

登录窗口中使用 QQ 或微信登录，回到终端按 Enter 保存会话。随后打开 [本地工具箱](http://127.0.0.1:17832/)，可以直接使用。端口通过 `TDOCS_PROXY_PORT` 调整。

WebGUI 提供分类、搜索、上传、录音、参数填写、进度、文档链接与下载。顶部显示文档 AI 积分、Buddy One 积分和转写时长，每张卡片显示文件限制、额度和验收状态。

## 工具和验收范围

目录去重后共有 43 项，PDF 转图片与文件转图片共享同一入口。

- 33 项自动处理工具已完成真实账号或实际文件验收，覆盖 PDF、Office、图片、思维导图、AI 创作、收集表和音视频。
- 智能翻译、简历美化、图片转简历提供原生编辑器接续流程，最终翻译或排版由用户在对应编辑器完成。
- 7 项第三方插件提供服务商信息、授权状态和原生入口，包含简历范文、简历分析、证件照、草料二维码、魔法擦除、抠图及电子合同。插件结果及合同签署需要在其界面完成。

逐项能力和验证结果见 [工具清单](docs/toolbox.md) 和 [验收记录](docs/validation.md)。

## 额度显示

当前账号权益返回 `unlimit=true` 时，界面显示“无限量”。本地处理显示“无限量（本地）”，同时列出文件大小和处理限制。服务端没有返回独立额度时显示“服务未返回独立额度”。

语音速记与音视频转文字共用权益编号 25，余额按秒读取并换算为分钟。录音结束后提交转写，麦克风由用户在浏览器中开启，也可上传已有音频。

文档积分和 Buddy One 积分保留接口提供的小数精度，分别显示余额与优先使用的积分池。查询失败会显示未获取及失败状态。

文件限制来自公开前端和账号权益，界面同时列出本机上限。PDF 本地解析每文件最多 100 MiB，图片每张最多 50 MiB、4000 万像素，上传存储最多 1 GiB。上游会继续检查格式、页数、会员和插件规则。

## HTTP API

服务监听 `127.0.0.1`，本地调用直接可用。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 运行版本与服务状态 |
| `GET /v1/tools` | 目录、调用方式和验收状态 |
| `GET /v1/limits` | 账号余额、无限量标记和文件限制 |
| `POST /v1/limits/refresh` | 重新读取上游权益 |
| `POST /v1/artifacts?filename=example.pdf` | 发送文件字节并取得 artifact ID |
| `GET /v1/artifacts/<id>/content` | 下载本地结果 |
| `POST /v1/tools/<tool-id>/run` | 提交任务，带 `Idempotency-Key` 请求头 |
| `GET /v1/jobs` | 最近任务 |
| `GET /v1/jobs/<id>` | 原任务进度和结果 |
| `GET /v1/translation/languages` | 支持的翻译方向 |

例如先上传，再提交 PDF 拆分。

```sh
curl 'http://127.0.0.1:17832/v1/artifacts?filename=example.pdf' \
  -H 'Content-Type: application/pdf' --data-binary @example.pdf

curl http://127.0.0.1:17832/v1/tools/pdf_split/run \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-split-001' \
  -d '{"artifacts":["<artifact-id>"],"options":{"groups":[[1],[2,3]]}}'
```

原 `/v1/quota`、`/v1/transcriptions` 与转写 CLI 继续可用。

## Agent MCP 和 CLI

```sh
node src/cli.mjs mcp
node src/cli.mjs tools
node src/cli.mjs quota
node src/cli.mjs transcribe ./sample.wav --language 16k_zh --wait
node src/cli.mjs status <transcription-task-id>
```

将 `node`、`<项目路径>/src/cli.mjs`、`mcp` 配置为 Agent 的 stdio 服务。提供 43 个 `tdocs_<tool-id>` 工具和目录、额度、上传、查询，共 47 个 MCP 工具。

网页剪存使用已登录的网页会话提交和查询。工具箱使用自己的腾讯文档账号登录。

## DSH 插件

[DSH 腾讯文档工具箱](https://github.com/vb2250158/dsh-tencent-docs-toolbox) 提供侧栏入口和 48 个 Agent 工具。安装后自动检查已保存的登录，需要登录时打开独立 Chrome 窗口。完成 QQ 或微信登录后自动保存并关闭窗口，后续复用登录态。

插件通过本包的 `session`、`runtime` 和 `server` 导出复用账号、任务和 WebGUI。嵌入模式支持固定资源前缀和同源主题同步。

## 文件、登录与恢复

默认运行目录位于 Windows 的 `%LOCALAPPDATA%/tencent-docs-web-proxy`，其他系统使用 `~/.local/share/tencent-docs-web-proxy`。`TDOCS_PROXY_STATE_DIR` 可指定其他仓库外目录。Windows 会话使用当前用户 DPAPI 加密，独立 Chrome 配置及任务文件保存在运行目录。

相同 `Idempotency-Key`、输入和参数恢复原任务。网页丢失提交响应时保留原编号，可从任务记录恢复。写入结果未知或进程中断时显示需要处理，保留已知上游编号供核对。多文件云任务逐项保存结果。

输入、结果、Cookie、录音和私人文档地址保存在私有运行目录。保留该目录可继续查询历史任务。

## 开发

```sh
npm test
npm run check
npm audit --omit=dev
```

自动测试使用合成数据，覆盖额度、无限量、文件处理、恢复、协议解析和 WebGUI 交互。真实账号范围与剩余人工操作见验收记录。

## License

MIT。社区项目，腾讯文档和相关商标归各自权利人所有。

本机需要保留第二个地址时可设置 TDOCS_PROXY_ALIAS_PORT，两个地址共用同一组任务状态。
