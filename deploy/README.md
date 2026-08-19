# GPlan 上线部署

## 1. 阿里云控制台准备

### RDS MySQL

你现在的 RDS MySQL 8.0 可以先用。需要做：

1. 创建数据库：`gplan`，字符集 `utf8mb4`
2. 创建账号：建议 `gplan_app`
3. 授权 `gplan_app` 访问 `gplan`
4. 白名单加入 ECS 私网 IP：`172.26.8.142`
5. ECS 和 RDS 在同地域同 VPC 时，优先使用 RDS 内网地址

可以在 DMS 或 RDS 控制台执行：

```sql
SOURCE deploy/mysql-schema.sql;
```

如果控制台不支持 `SOURCE`，直接复制 `deploy/mysql-schema.sql` 内容执行。

### ECS 安全组

开放：

- `80/tcp`：HTTP 访问
- `443/tcp`：HTTPS，配置证书后再用
- `22/tcp`：SSH，仅建议限制你的办公 IP

不要开放 `3001/tcp` 到公网，Node 服务只给 Nginx 本机代理。

## 2. 服务器安装依赖

```bash
ssh root@114.55.168.249

dnf install -y git nginx
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
npm install -g pm2
```

## 3. 拉代码

```bash
mkdir -p /opt
cd /opt
git clone https://github.com/Sahaquiel-10th/Gplan.git gplan
cd /opt/gplan
npm ci
npm run build
```

## 4. 配置环境变量

在 `/opt/gplan/.env` 写入：

```bash
PORT=3001
NODE_ENV=production
JWT_SECRET=换成一段至少32位的随机字符串

DB_PROVIDER=mysql
MYSQL_HOST=你的RDS内网地址
MYSQL_PORT=3306
MYSQL_USER=gplan_app
MYSQL_PASSWORD=你的数据库密码
MYSQL_DATABASE=gplan
MYSQL_CONNECTION_LIMIT=10

YYLX_API_KEY=你的yylx key，可不填，后续后台填

WANLINIU_APP_KEY=你的万里牛AppKey
WANLINIU_APP_SECRET=你的万里牛Secret
HUPUN_API_CLI_PATH=/opt/hupun/hupun-api-cli

# 经营数据独立数据库（可以与主库在同一个 RDS 实例）
DATA_DB_PROVIDER=mysql
DATA_MYSQL_HOST=你的RDS内网地址
DATA_MYSQL_PORT=3306
DATA_MYSQL_USER=有gplan_data读写权限的应用账号
DATA_MYSQL_PASSWORD=该应用账号密码
DATA_MYSQL_DATABASE=gplan_data
DATA_MYSQL_CONNECTION_LIMIT=5
WANLINIU_COMPANY_ID=company_default
WANLINIU_SYNC_ENABLED=false
WANLINIU_SYNC_INTERVAL_MINUTES=15
WANLINIU_INITIAL_LOOKBACK_DAYS=30
WANLINIU_PRODUCT_INITIAL_START=2000-01-01T00:00:00+08:00
WANLINIU_SYNC_OVERLAP_MINUTES=10
```

当前代码会在 `DB_PROVIDER=mysql` 时使用 MySQL 的 `app_state` 表持久化数据；如果 MySQL 里没有数据，会优先把本地 `data/db.json` 导入进去。

“管理后台 -> AI问数测试”通过万里牛官方 `hupun-api-cli` 发起签名请求。部署前请按万里牛 AI Skill
安装说明准备与服务器架构匹配的 CLI，并把绝对路径写入 `HUPUN_API_CLI_PATH`。AppKey 和 Secret
只配置在服务端环境变量中，不要写入前端或提交到仓库。

经营数据同步通过“管理后台 -> 数据接入 -> 万里牛 ERP -> 手动同步”触发。第一次会全量同步
店铺、商品和当前库存，并回溯最近 30 天的销售出库和采购入库；后续按修改时间增量同步。
确认首轮数据和 `data_sync_runs` 留痕正常后，再把 `WANLINIU_SYNC_ENABLED` 改为 `true`
并重启服务。同步游标只会在某类资源全部分页成功后推进，失败任务可安全重跑。

## 5. 启动 Node

```bash
cp deploy/ecosystem.config.cjs /opt/gplan/ecosystem.config.cjs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## 6. 配置 Nginx

```bash
cp deploy/nginx-gplan.conf /etc/nginx/conf.d/gplan.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx
```

访问：

```text
http://114.55.168.249
```

后续绑定域名后，把 `server_name _;` 改成你的域名，并配置 HTTPS 证书。

## 7. 发版流程

```bash
cd /opt/gplan
git pull
npm ci
npm run build
pm2 restart gplan-ai
```
