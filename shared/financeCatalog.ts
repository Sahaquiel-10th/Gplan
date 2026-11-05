export const financeSources = [
  { id: 'alipay', name: '企业支付宝', stage: '已有凭证配置与只读检测', requirements: ['客户自有应用及查询权限', '应用私钥及支付宝公钥，或配套证书', '单日账单入库与对账待接通'] },
  { id: 'alipay_yulibao', name: '企业支付宝—余利宝', stage: '待确认产品与查询规范', requirements: ['实际产品名称与账户归属', '当前份额、资产及收益查询规范', '查询授权；不接申购赎回'] },
  { id: 'bocom', name: '交通银行', stage: '待银行开通与接口资料', requirements: ['查询专用银企直联授权', '当前接口包、证书及客户号', '确认UKey/前置与无人值守条件'] },
  { id: 'mybank', name: '浙江网商银行', stage: '待银行开通与接口资料', requirements: ['企业结算户银企直联申请', '证书绑定及必要复核', '当前银行接口包；非支付宝接口'] },
  { id: 'cmb', name: '招商银行', stage: '待选定产品与接口资料', requirements: ['直联/云直联/Open API具体产品', '查询产品开通及账户授权', '当前签名、证书及部署规范'] },
  { id: 'yhrcb', name: '浙江余杭农商银行', stage: '待银行确认官方通道', requirements: ['开户机构与支行全称', '本行官方只读直联/文件通道', '当前规范与技术支持'] },
  { id: 'hzbank', name: '杭州银行', stage: '待确认账务查询产品', requirements: ['适合自建系统的查询产品', '账户授权及当前接口包', '证书、前置及网络要求'] },
  { id: 'cmbc', name: '中国民生银行', stage: '待银行开通与接口资料', requirements: ['只读银企直联及账户授权', '当前接口包与查询证书', '测试环境及前置方式'] },
  { id: 'abc', name: '中国农业银行', stage: '待银行开通与接口资料', requirements: ['银企通/直联查询产品', '集团或逐主体账户授权', '当前规范、证书与前置条件'] },
  { id: 'icbc', name: '中国工商银行', stage: '待银行开通与接口资料', requirements: ['分行协助开通账务查询或官方文件服务', '当前协议与账户授权', '证书；SFTP须另核文件规范'] },
  { id: 'spdb', name: '上海浦东发展银行', stage: '待银行开通与接口资料', requirements: ['查询专用银企直连', '管理单位及成员账户授权', '当前接口包、证书与限流'] },
  { id: 'tailong', name: '泰隆银行', stage: '待银行开通与接口资料', requirements: ['需求评估、协议及测试验收', '查询专用UKey与官方软件', '成员授权及必要三方协议'] },
] as const;
export type FinanceSourceId = typeof financeSources[number]['id'];
export type FinanceDraftInput = { legalEntity: string; sourceId: FinanceSourceId; name: string; last4: string; currency: string; note: string };
export const financeCsvHeaders = ['公司名称', '银行/来源', '账户名称', '账号尾号', '币种', '备注'] as const;
export type FinanceImportRow = { rowNumber: number; action: 'create' | 'skip' | 'error'; values?: FinanceDraftInput; errors: string[] };
export type FinanceImportPreview = { digest: string; rows: FinanceImportRow[]; creates: number; skips: number; errors: number };
export type FinanceAccountView = FinanceDraftInput & {
  id: string; legalEntityId: string; revision: number; createdAt: string; updatedAt: string;
  credentialStatus: 'not_configured' | 'incomplete' | 'configured';
  checkStatus: 'not_tested' | 'partial' | 'available' | 'failed';
  syncStatus: 'not_enabled'; linkedAlipayId?: string;
};
export type FinanceDirectoryState = { sources: typeof financeSources; accounts: FinanceAccountView[]; entities: {id: string; name: string}[]; credentialConfigurationOpen: boolean };
