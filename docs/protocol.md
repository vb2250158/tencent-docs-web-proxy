# 网页协议记录

本项目根据公开网页代码观察请求字段，独立实现客户端。没有复制网页打包代码或候选项目代码。记录日期：2026-11-11。

## 现有项目检索

检索 GitHub 的 `tencent-docs`、`腾讯文档 转写`、`docs.qq.com av-to-text` 和网页接口代理相关关键词，并查看候选仓库内容。

| 项目 | 观察到的范围 | 与本项目的差异 |
| --- | --- | --- |
| [snomiao/qqdocs](https://github.com/snomiao/qqdocs) | 官方 MCP 的 CLI 与调用库 | 不是网页音视频转写代理 |
| [Wscats/tencent-docs-markdown](https://github.com/Wscats/tencent-docs-markdown) | 登录、Markdown 创建与管理 | 未发现转写调用；检索时 GitHub 未返回许可证 |
| [Tencent Docs Plugin for AI Agent](https://github.com/akashmahedy/Tencent-Docs-Plugin-for-AI-Agent) | 官方 MCP 的客户端插件 | 没有覆盖本次转写链路 |
| [F-SG1133/tencent-docs-AI](https://github.com/F-SG1133/tencent-docs-AI) | 前端协作演示及 Gemini 服务 | 不是腾讯文档转写接口客户端 |

上述结果只说明本次检索未找到可直接复用的实现，不是对全部开源项目的穷尽判断。

## 请求来源

- [腾讯文档音视频转文字网页](https://docs.qq.com/open/toolkit/av-to-text.html)
- [网页转写入口脚本](https://docs.gtimg.com/docsopen/open-toolkit/av-to-text-972238f368.js)
- [网页上传相关脚本](https://docs.gtimg.com/docsopen/open-toolkit/5418-5525110fc7.js)
- [网页 Cookie/XSRF 工具脚本](https://docs.gtimg.com/docsopen/open-toolkit/8169-e4241ef243.js)

请求目标固定为 `https://docs.qq.com`，Cookie 来自用户主动登录的会话。`xsrf` 查询参数使用该会话的 `TOK`，不进行签名猜测或访问控制绕过。

| 操作 | POST 路径 | 关键请求 / 响应 |
| --- | --- | --- |
| 转写额度 | `/v2/vipcenter/rights/get` | `{id:[25]}` → `result.info[0].rest / total`，单位秒 |
| 临时上传授权 | `/v2/drive/tmp/cred` | `null` → `result.cred`，含 bucket、region、resource 和 credential |
| 媒体时长 | `/api/ai/mediatransform/get_media_info` | `{objKey,isTemp:true}` → `result.mediaInfo.audio.length` |
| 创建转写 | `/api/ai/mediatransform/media_to_tdoc/trans` | `{cosURL,objKey,objName,language,speakerDiarization,parentName}` → `result.taskId` |
| 查询任务 | `/api/ai/mediatransform/media_to_tdoc/get_record` | `{taskId}` → `result.record` |
| 转写历史 | `/api/ai/mediatransform/media_to_tdoc/get_records` | `{}` → `result.records` |

上传由腾讯 COS SDK 使用临时密钥完成。上传完成后查媒体时长，再提交转写。任务 `progress=100` 表示完成，`progress=-1` 表示失败；`errCode!=0` 也是失败。结果文档地址来自 `record.fileUrl`。

本表是观察到的网页协议，真实运行以验证记录为准。新网页字段、风控、登录过期或套餐变化应显式报错，不能被归零余额、空历史或伪造成功掩盖。
