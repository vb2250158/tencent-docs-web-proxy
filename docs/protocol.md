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

## 0.2.0 网页工具扩展

完整公开工具清单来自腾讯文档 rainbow 工具箱配置与页面入口。工具编号、分类、调用方式、来源和验收状态统一保存在 src/tool-catalog.json，逐项投影见 toolbox.md。

权益查询保留各自的响应格式。PDF 转 Office 使用 rights/get 的权益编号 2、3、4，转换类型分别为 0、1、2。音视频和语音速记使用权益编号 25。原生速记源码对查询失败曾返回 Infinity，代理保留查询失败状态并使用已验证的余额响应。无限量只依据明确的 unlimit=true 或本地处理次数属性呈现。

AI 网页生成读取原始 SSE 的 controlMessage 和嵌套 content.content，保存 conversationId 与 messageId。生成文本确认结束后，另行创建文件并读取文件结果。原生 PPT 使用已观察到的默认模板 29000。网页剪存使用本机已配置的官方 MCP 授权和固定官方地址。

PDF、Office 和图片导入使用各自原生链路。Office 转 PDF 返回编辑页地址，原始 PDF 下载使用 POST /v2/drive/downloadURL 与 drive file_id。腾讯文档 D 前缀 URL 的尾段经 Base64 解码得到 drive I 前缀文件编号，已用真实合成输出核验。

智能翻译组件负责导入和向阅读器传递 translate_from、translate_language，最终翻译由阅读器继续。插件安装状态和授权需求由 /addon/addons/<addonId>?needAuthStatus=1 返回。第三方服务与电子合同通过原生界面完成。
