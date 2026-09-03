-- 经营驾驶舱查询索引。只增加索引，不修改业务数据。
-- 首次部署驾驶舱时在 gplan_data 执行一次。
ALTER TABLE gplan_data.ods_wln_sale_outbound
  ADD INDEX idx_wln_sale_outbound_dashboard
    (company_id, bill_date, gross_amount, actual_payment),
  ALGORITHM=INPLACE,
  LOCK=NONE;
