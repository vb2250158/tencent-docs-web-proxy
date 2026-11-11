# Tencent Docs web transcription proxy

将腾讯文档网页端的音视频转文字能力接入本地 CLI 和 HTTP API，使用你自己的腾讯文档账号及转写时长。支持查询剩余额度、上传本地音视频、提交转写、查询进度和取得结果文档链接。

Local CLI and authenticated loopback API for Tencent Docs audio/video transcription, using your own web account and transcription entitlement.

这是社区实现，使用腾讯文档网页接口。AI 助手积分、腾讯云 ASR 计费和通用大模型代理属于不同能力，本项目首版聚焦转写分钟数。网页协议及登录方式可能变化，接口依据和验证范围见 [协议记录](docs/protocol.md)。

## 安装与登录

需要 Node.js 24.15+ 和已安装的 Google Chrome。

```sh
npm ci --ignore-scripts
node src/cli.mjs login
```

登录命令打开独立 Chrome 配置目录。使用 QQ 或微信登录腾讯文档后，在终端按 Enter；程序回读转写额度，再保存登录态。它不会读取你日常 Chrome 的 Cookie 数据库。

默认运行数据目录是 Windows 的 `%LOCALAPPDATA%/tencent-docs-web-proxy`，其他系统使用 `~/.local/share/tencent-docs-web-proxy`。可设置 `TDOCS_PROXY_STATE_DIR` 改到其他仓库外目录。Windows 登录态使用当前用户的 DPAPI 加密；其他系统使用权限为 `0600` 的文件。独立 Chrome 配置本身也包含登录资料，应作为私有运行数据保管。

已有专用 Cookie 的自动化环境也可通过 `TDOCS_COOKIE` 注入；其中必须包含腾讯文档 `TOK`。请在本机私有环境中配置，避免放进仓库、命令参数、聊天、日志或 Issue。

## 命令行

```sh
node src/cli.mjs quota
node src/cli.mjs transcribe ./sample.wav --language 16k_zh --wait
node src/cli.mjs transcribe ./meeting.mp4 --speakers --request-id meeting-001
node src/cli.mjs status <task-id>
node src/cli.mjs wait <task-id>
node src/cli.mjs history
```

提交返回 `requestId`、腾讯任务 `taskId` 和识别到的 `durationSeconds`。完成后返回 `fileUrl`，可在腾讯文档中打开文字结果。首版返回结果文档链接，尚未实现全文 TXT/SRT 导出。

`--language` 使用网页端引擎标识，默认 `16k_zh`；例如 `16k_en`、`16k_yue`、`16k_ja`。区分说话人目前只支持网页明确开放的中文、英语、马来语和印度尼西亚语。网页每文件限制为 1 GiB、5 小时，实际可用格式与额度以腾讯文档响应为准。

## HTTP API

```sh
node src/cli.mjs serve
```

服务仅监听 `127.0.0.1:17832`。`TDOCS_PROXY_PORT` 可调整端口。每个请求都需要 `Authorization: Bearer <本地 API token>`；启动日志只提示 token 文件位置，不输出其内容。默认 token 保存在运行目录的 `api-token`，也可设置至少 24 字符的 `TDOCS_PROXY_TOKEN`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 服务版本和存活状态；不会验证腾讯登录态 |
| `GET /v1/quota` | 剩余和总转写秒数，同时检查上游访问 |
| `GET /v1/transcriptions` | 腾讯文档转写历史 |
| `POST /v1/transcriptions?filename=sample.wav&language=16k_zh&speakers=false` | 请求体直接发送音视频字节，另带 `Idempotency-Key` |
| `GET /v1/transcriptions/<task-id>` | 进度、错误码和结果文档链接 |

例如在已私有配置 `TDOCS_PROXY_TOKEN` 的终端中：

```sh
curl http://127.0.0.1:17832/v1/quota \
  -H "Authorization: Bearer $TDOCS_PROXY_TOKEN"

curl 'http://127.0.0.1:17832/v1/transcriptions?filename=sample.wav' \
  -H "Authorization: Bearer $TDOCS_PROXY_TOKEN" \
  -H 'Idempotency-Key: sample-001' \
  -H 'Content-Type: audio/wav' \
  --data-binary @sample.wav
```

API 接收文件字节，不接收远端下载 URL 或服务器本地路径。所有请求均校验本地 token、Host 和浏览器 Origin；该版本不提供远程监听或跨站调用。

## 重复请求与故障恢复

每次新转写使用一个稳定的 `requestId` / `Idempotency-Key`。相同编号、文件和参数返回已保存的任务回执；更换文件或参数会返回 `IDEMPOTENCY_CONFLICT`。

提交前记录请求身份。进程退出、网络断开或响应解析失败后，若无法确认腾讯是否接受任务，返回 `SUBMISSION_OUTCOME_UNKNOWN` 或 `REQUEST_OUTCOME_UNKNOWN`，保留原编号并停止自动重发。先查询 `history` 和腾讯文档网页中的转换历史，找到原任务后继续 `status` / `wait`。不要通过换编号盲目重试。

当前请求回执不会自动清理。运行目录包含账号会话和任务资料，完整保留它可供恢复；请不要把它打包进公开仓库。HTTP 上传暂存文件在请求结束后清理。关闭本地等待不会取消已提交的腾讯任务。

## 开发与验证

```sh
npm test
npm run check
npm audit --omit=dev
```

测试覆盖请求鉴权、固定上游地址、响应校验、任务状态、流式上传、额度错误和重复提交恢复。自动测试使用合成数据和模拟上游，不消耗账号时长。真实账号验收需要登录后用短音频验证上传、提交、结果文档和额度变化，具体结果记录在 [验证记录](docs/validation.md)。

贡献时请提交最小的脱敏协议样例，标明网页版本和 `retcode`，保留 Cookie、上传临时密钥、音视频、文字稿和私人文档地址在本地。

## License

MIT。腾讯文档及相关商标归各自权利人所有。
