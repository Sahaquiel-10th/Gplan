# GPlan 上线部署

## 1. 阿里云控制台准备

### RDS MySQL

你现在的 RDS MySQL 8.0 可以先用。需要做：

1. 创建应用数据库：`gplan`，字符集 `utf8mb4`
2. 创建经营数据库：`gplan_data`，字符集 `utf8mb4`
3. 创建账号：建议 `gplan_app`
4. 授权 `gplan_app` 访问 `gplan` 和 `gplan_data`
5. 白名单加入 ECS 私网 IP：`172.26.8.142`
6. ECS 和 RDS 在同地域同 VPC 时，优先使用 RDS 内网地址

可以在 DMS 或 RDS 控制台执行：

```sql
SOURCE deploy/mysql-schema.sql;
SOURCE deploy/gplan-data-schema.sql;
```

如果控制台不支持 `SOURCE`，分别复制 `deploy/mysql-schema.sql` 和 `deploy/gplan-data-schema.sql` 内容执行。

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

# 独立经营数据库；首批保存万里牛同步数据
DATA_DB_PROVIDER=mysql
DATA_MYSQL_DATABASE=gplan_data
DATA_MYSQL_CONNECTION_LIMIT=5

# DATA_MYSQL_HOST/PORT/USER/PASSWORD 未配置时复用上面的 MYSQL_* 连接信息
WANLINIU_APP_KEY=万里牛开放平台AppKey
WANLINIU_APP_SECRET=万里牛开放平台Secret
WANLINIU_BASE_URL=https://open-api.hupun.com/api
WANLINIU_REQUEST_TIMEOUT_MS=20000
# 首次手动同步并完成核对后再开启；店铺基础资料默认每 6 小时同步
WANLINIU_SHOP_SYNC_ENABLED=false
WANLINIU_SHOP_SYNC_INTERVAL_MINUTES=360

YYLX_API_KEY=你的yylx key，可不填，后续后台填
```

当前代码会在 `DB_PROVIDER=mysql` 时使用 `gplan.app_state` 持久化账号、智能体和聊天状态；如果 MySQL 里没有数据，会优先把本地 `data/db.json` 导入进去。经营数据独立保存到 `gplan_data`，不会进入 `app_state` JSON。

当前万里牛第一条真实同步链路为：店铺分页接口 → `gplan_data.ods_wln_shops`。每次同步同时写入 `data_sync_runs`，成功水位写入 `data_sync_cursors`。后台“检测凭证”会实际访问万里牛店铺接口，“手动同步”会执行真实落库。

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
