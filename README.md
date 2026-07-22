# 企业 AI 工作台

一个从零搭建的企业内部 AI 网页，支持账号登录、管理员后台、多模型 API 接入、对话记录审计，并预留办公软件机器人 API。

## 功能

- 普通用户：登录后像 ChatGPT 一样聊天，可在顶部快速切换可用模型。
- 对话：每个对话首次发送前选择模型，发送后锁定模型，保证上下文连续；支持 Markdown 渲染、复制 Markdown、归档/删除、工作空间分组。
- 管理员：开通/停用账号，管理模型接入，查看所有用户对话记录。
- 管理员后台：管理员登录后左侧会出现独立“管理后台”页面入口。
- 模型接入：支持 OpenAI Chat Completions 兼容接口，国内模型网关只要提供兼容的 `/chat/completions` 即可接入。
- 机器人 API：支持用 Bearer Token 调用 `/api/integrations/chat`，后续可接入钉钉、飞书、企业微信等办公软件。

## 本地运行

```bash
npm install
npm run dev
```

前端地址：http://localhost:5173，如果端口被占用 Vite 会自动换到 5174/5175。

后端地址：http://localhost:3001

初始管理员：

```text
账号：admin
开发环境初始密码：admin123（生产环境必须通过 `ADMIN_INITIAL_PASSWORD` 配置强密码）

模型充值后台使用独立的 `ADMIN_TOOLS_PASSWORD`；未配置时使用项目内置初始密码，正式环境建议在 `.env` 中覆盖。
```

首次部署后请立即修改管理员密码，或者删除 `data/db.json` 后调整 `server/db.ts` 中的初始化逻辑再启动。

只有管理员账号，即 `role=admin` 的账号，登录后会看到左侧“管理后台”入口。普通用户只能进入 AI 对话。

修改管理员密码：用管理员登录后，进入“管理后台 -> 账号”，点 `admin` 这一行的“编辑”，在“新密码，留空不改”里填新密码并保存。普通用户看不到管理后台入口，登录页也不会展示默认管理员账号。

## 配置模型

进入“管理后台 -> 模型”，新增模型：

- 展示名称：给用户看的名称，如“通义千问 Plus”
- Base URL：兼容 OpenAI 的 API 根地址，如 `https://api.openai.com/v1`
- API Key：供应商密钥
- 模型 ID：真实模型名，如 `gpt-4o-mini`、`qwen-plus`
- System Prompt：这个模型的默认系统提示词，可留空

系统会调用：

```text
POST {Base URL}/chat/completions
Authorization: Bearer {API Key}
```

## yylx 接入

yylx 的 OpenAI 兼容地址填写：

```text
https://app.yylx.io/v1
```

已内置三个模型配置：

| 展示名称 | 类型 | 模型 ID |
| --- | --- | --- |
| Claude 4.7 | 聊天模型 | `claude4.7` |
| GPT 5.5 | 聊天模型 | `gpt5.5` |
| Image 2 | 图片模型 | `gpt-image-2` |

如果启动前设置了环境变量 `YYLX_API_KEY`，这三个模型会自动写入 API Key 并启用。否则进入后台逐个填写 API Key 后启用。

用户聊天页只会显示“已启用且已配置 API Key”的模型。后台已有模型可以点“编辑”补充 API Key、修改名称、Base URL、模型 ID、类型和启用状态。

图片模型会调用：

```text
POST https://app.yylx.io/v1/images/generations
Authorization: Bearer {API Key}
```

上传参考图片时会改用兼容 OpenAI 的图片编辑接口：

```text
POST https://app.yylx.io/v1/images/edits
Content-Type: multipart/form-data
Authorization: Bearer {API Key}
```

在普通 GPT 聊天中明确提出“生成图片”“画一张图”“把这张图改成……”等请求时，服务端会自动转调同供应商已启用的图片模型；普通图片分析仍由当前聊天模型处理。聊天输入框支持直接粘贴剪贴板图片。

## 机器人 API

进入“管理后台 -> API Token”生成 Token。

API Token 用于钉钉、飞书、企业微信等办公软件机器人服务端调用本系统接口，不是网页登录账号密码。后台会默认用星号隐藏 Token，可以点“显示”查看，也可以一键复制。

调用示例：

```bash
curl -X POST http://localhost:3001/api/integrations/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer bot_xxx" \
  -d '{"content":"帮我总结这段话","modelId":"可选模型ID"}'
```

返回：

```json
{
  "reply": "模型回复内容",
  "imageUrl": "图片模型返回时存在",
  "modelId": "实际使用的模型ID"
}
```

## 上线部署

上线部署说明在 [deploy/README.md](/Users/machao/Desktop/小象G计划/deploy/README.md)。

核心步骤：

1. 在阿里云 RDS 创建 `gplan` 数据库和应用账号
2. RDS 白名单加入 ECS 私网 IP
3. ECS 安装 Node.js、Git、Nginx、PM2
4. 拉取 GitHub 仓库
5. 配置 `.env`
6. `npm ci && npm run build`
7. `pm2 start ecosystem.config.cjs`
8. Nginx 反向代理到 `127.0.0.1:3001`

## 数据存储

默认使用 `data/db.json` 做本地持久化。上线设置 `DB_PROVIDER=mysql` 后会使用 MySQL 的 `app_state` 表保存业务数据。

当前 MySQL 版本采用单表 JSON 状态，适合快速上线和从本地 JSON 平滑迁移。后续用户量稳定后，建议再拆成 `users`、`models`、`conversations`、`messages`、`workspaces`、`settings` 等标准表。
