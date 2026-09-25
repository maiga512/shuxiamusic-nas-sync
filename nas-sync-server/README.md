# Ceru NAS Sync Server

Ceru Music 的自部署歌单同步服务。它用 SQLite 保存用户、歌单、歌曲和收藏关系，桌面端通过 NAS 同步插件连接它。

## 目录

```text
nas-sync-server/
├── src/                  # 服务端源码
├── data/                 # SQLite 数据目录，运行后生成
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## 端口和环境变量

默认监听 `31231`。

```bash
CERU_SYNC_HOST=0.0.0.0
CERU_SYNC_PORT=31231
CERU_SYNC_DB_PATH=/data/ceru-sync.sqlite
CERU_SYNC_ADMIN_TOKEN=change-this-admin-token
```

`CERU_SYNC_ADMIN_TOKEN` 是命令行管理接口的备用 token。日常使用建议直接打开 Web 管理页面，用管理员账号登录。

## Docker 部署

在本目录创建 `.env`：

```bash
cd nas-sync-server
cp .env.example .env
```

编辑 `.env`，把 `CERU_SYNC_ADMIN_TOKEN` 改成你自己的值。

启动：

```bash
docker compose up -d --build
```

检查服务：

```bash
curl http://你的NAS地址:31231/health
```

看到类似结果说明服务已启动：

```json
{"status":"ok","service":"ceru-nas-sync-server"}
```

数据会保存在：

```text
nas-sync-server/data/ceru-sync.sqlite
```

## Web 管理页面

部署完成后，在浏览器打开：

```text
http://你的NAS地址:31231/admin
```

第一次登录：

```text
账号: admin
密码: password
```

登录后请先在页面里修改管理员密码。

管理页面可以做这些事：

- 查看 NAS 同步服务是否在线
- 修改管理员密码
- 创建多个同步用户，例如 `user1`、`user2`、`user3`
- 为每个用户单独生成插件登录绑定码
- 查看每个用户的歌单数、歌曲数、收藏数和已登录设备数
- 复制插件需要填写的服务器地址

多用户规则：

- 所有用户共用同一个服务器地址，例如 `http://NAS_IP:31231`
- 每个用户使用自己的绑定码登录插件
- 服务端按用户账号隔离数据，用户 1 看不到用户 2、用户 3 的歌单和收藏
- 每个用户的同步记录、歌单、歌曲、收藏、revision 都是独立保存的

管理员账号只用于打开 NAS 管理页面，不要填到插件里。插件只需要服务器地址和当前同步用户的绑定码。

## 忘记管理员账号或密码

管理员密码只保存在 NAS 服务器本地数据库里，无法反查原密码。如果忘记了，使用 `.env` 里的 `CERU_SYNC_ADMIN_TOKEN` 重置管理员账号和密码。

Docker 部署时可以这样执行：

```bash
curl -X POST http://你的NAS地址:31231/admin/reset-admin \
  -H "Content-Type: application/json" \
  -H "x-admin-token: 你的CERU_SYNC_ADMIN_TOKEN" \
  -d '{"username":"admin","password":"新的管理员密码"}'
```

重置成功后，用上面的 `username` 和 `password` 登录 Web 管理页面。这个操作只会重置管理后台账号，不会删除用户、绑定码、歌单、收藏或同步数据。

如果 Web 管理接口也无法访问，但可以进入 Docker 容器，也可以离线重置：

```bash
docker compose exec ceru-nas-sync node src/resetAdmin.ts admin 新的管理员密码
```

如果你的容器名不同，先用 `docker ps` 查看容器名，再把 `ceru-nas-sync` 换成实际名称。

## 普通 Node 部署

需要 Node.js 22。

```bash
cd nas-sync-server
yarn install
CERU_SYNC_ADMIN_TOKEN=你的管理token yarn start
```

也可以指定数据路径：

```bash
CERU_SYNC_ADMIN_TOKEN=你的管理token \
CERU_SYNC_DB_PATH=/你的数据目录/ceru-sync.sqlite \
yarn start
```

## 命令创建用户（可选）

如果你不想用 Web 管理页面，也可以用 `.env` 里的 `CERU_SYNC_ADMIN_TOKEN` 调用管理接口。

```bash
curl -X POST http://你的NAS地址:31231/admin/users \
  -H "Content-Type: application/json" \
  -H "x-admin-token: 你的管理token" \
  -d '{"username":"song","password":"你的用户密码","nickname":"Song"}'
```

## 命令生成插件登录绑定码（可选）

绑定码是当前用户的长期绑定码。每个用户只需要生成一次，后续复制同一个绑定码到插件里登录即可。

```bash
curl -X POST http://你的NAS地址:31231/admin/pair-codes \
  -H "Content-Type: application/json" \
  -H "x-admin-token: 你的管理token" \
  -d '{"username":"song"}'
```

返回里的 `pairCode` 填到桌面端 NAS 同步插件里。

## 桌面端插件导入

插件文件在项目根目录：

```text
plugins/ceru-nas-sync-service.js
```

桌面端操作：

```text
设置 -> 插件 -> 添加插件 -> 澜音插件 -> 本地导入 -> 选择 ceru-nas-sync-service.js
```

配置插件：

```text
服务器地址: http://你的NAS地址:31231
登录绑定码: Web 管理页面为当前用户生成的 pairCode
```

点击 `登录 NAS 同步服务`，状态显示 `已连接` 后即可同步。

## 反向代理建议

局域网内可以直接用 `http://NAS_IP:31231`。

如果要公网访问，建议放到 HTTPS 反向代理后面，例如：

```text
https://music-sync.example.com -> http://127.0.0.1:31231
```

不要把 `CERU_SYNC_ADMIN_TOKEN` 写进前端或插件。它只用于服务端管理接口。

## 同步轮询

桌面端会低频请求：

```text
GET /sync?sinceRevision=上次revision
```

服务端只返回变更事件，不会每次传完整歌单。桌面端收到变更后再刷新歌单列表或当前歌单，因此 CPU、内存和网络压力都很低。
