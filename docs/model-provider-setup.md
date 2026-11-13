# DeepSeek 与豆包官方接入

在管理后台验证原有模型后台密码，进入模型管理，选择接入方式。服务地址、协议、展示名称、默认模型会自动填写；填写对应官方 API Key 后先测试连接，再保存并在聊天窗口选择。新接入不会自动替换当前默认模型，除非管理员勾选“设为新聊天默认模型”。

| 接入方式 | 默认服务地址 | 默认模型 | 最少填写 |
|---|---|---|---|
| DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-flash` | DeepSeek API Key |
| 豆包／火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-2-1-pro-260915` | 方舟 API Key；账号尚未开通默认模型时，需先开通或改填账号的模型／`ep-` 接入点 ID |

二者通过 Chat Completions 接入。官方预设默认关闭深度思考，避免短测试只消耗推理额度而没有正文；可按需启用。Key 留空编辑时保留原 Key，切换服务商则必须重新提供新服务商的 Key。连接测试只发送无业务数据的短问题，会消耗少量服务商 API 额度。Key 不返回浏览器，不放入 URL，不出现在测试结果中。

DeepSeek 的旧名称 `deepseek-chat`、`deepseek-reasoner` 不作为新接入默认值。豆包公开模型的开通、区域及接入点权限以本账号控制台为准，填 Key 不会替账号自动开通计费模型。

## 对比方式

连接成功只证明凭证、地址和模型可调用，不代表问数质量已通过。比较回答前，先核对企业数据来源展示里的日期、所需指标、字段和执行步骤。应将同一份结构化结果与相同问题交给不同模型；不要把不同日期或不同范围的数据称为模型能力对比。

当前模型名称、请求模型 ID、服务商配置和上游返回是调用证据；中转商对实际底层模型身份的声明无法由本系统独立认证。聊天模型的自报身份也不作为核验依据。

## 官方依据

核实日期：2026-11-13。模型版本可能更新，模型 ID 可在后台编辑。

- [DeepSeek 首次调用](https://api-docs.deepseek.com/quick_start/agent_integrations/)
- [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- [火山方舟 Chat API](https://www.volcengine.com/docs/82379/1494384)
- [火山方舟模型列表](https://www.volcengine.com/docs/82379/1330310)
