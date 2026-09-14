# Ceru Music NAS Sync

Ceru Music NAS Sync 是的澜音/Ceru Music 自部署多端同步方案，包含两个部分：

- `server/`：部署在 NAS、服务器、软路由、Docker 面板上的同步服务端。
- `plugins/ceru-nas-sync-service.js`：导入到澜音/Ceru Music 桌面端的服务插件。

它用于把桌面端的歌单、歌单歌曲、收藏关系备份到你自己的 NAS，并支持多台设备通过同一个 NAS 服务进行多端同步。

项目地址：

```text
https://github.com/maiga512/CeruMusic-NAS-Sync
```

Docker 镜像：

```text
ghcr.io/maiga512/ceru-music-nas-sync:latest
```

镜像支持 `linux/amd64` 和 `linux/arm64`，也就是常见 x86_64 服务器/NAS 和 ARM64 设备都可以使用。

## 功能

- 自部署 NAS 同步服务，不使用公共云地址。
- Web 管理后台：创建同步用户、生成长期绑定码、查看同步数据统计、删除用户、修改管理员账号密码。
- 多用户隔离：用户 1、用户 2、用户 3 使用同一个服务器地址，但各自使用自己的绑定码，数据独立保存。
- 桌面端插件登录后会首轮上传本机歌单，后续本机变更会自动备份。
- 服务端按 revision 返回变更事件，并支持 `/sync/wait` 长轮询；前台设备有变更时会被立即唤醒，不会反复拉完整歌单。
- 播客收藏、顺序和置顶状态会跟随服务器 revision 一起同步。
- 支持 Docker 部署和反向代理，Docker 镜像同时支持 x86_64 和 ARM64 架构。

## 隐私说明

运行时用户、绑定码、歌单、收藏和同步记录保存在你部署机器上的 SQLite 数据库里，默认路径是：

```text
server/data/ceru-sync.sqlite
```

这些运行时数据不会提交到 GitHub。仓库里的 `.dockerignore` 和 `.gitignore` 已经忽略：

```text
server/data
*.sqlite
*.sqlite-*
.env
```

请不要把自己的 `.env`、SQLite 数据库或真实绑定码手动上传到公开仓库。

## 快速开始：Docker Compose

### 1. 拉取项目

```bash
git clone https://github.com/maiga512/CeruMusic-NAS-Sync.git
cd CeruMusic-NAS-Sync/server
```

### 2. 创建环境变量

```bash
cp .env.example .env
```

编辑 `.env`，把 `CERU_SYNC_ADMIN_TOKEN` 改成你自己的长随机字符串：

```env
CERU_SYNC_HOST=0.0.0.0
CERU_SYNC_PORT=31231
CERU_SYNC_DB_PATH=/data/ceru-sync.sqlite
CERU_SYNC_ADMIN_TOKEN=change-this-admin-token
```

`CERU_SYNC_ADMIN_TOKEN` 只用于命令行重置管理员账号，不是插件登录码。

### 3. 启动服务

优先使用已发布镜像：

```bash
docker compose up -d
```

默认会使用：

```text
ghcr.io/maiga512/ceru-music-nas-sync:latest
```

这个镜像已经发布在 GitHub Container Registry，支持：

```text
linux/amd64  # x86_64 NAS、服务器、软路由
linux/arm64  # ARM64 NAS、服务器、开发板
```

如果你想本地构建：

```bash
docker compose up -d --build
```

### 4. 检查服务

```bash
curl http://你的NAS地址:31231/health
```

看到下面结果表示服务在线：

```json
{"status":"ok","service":"ceru-nas-sync-server"}
```

## NAS / 面板部署说明

这个项目本质是一个普通 Docker 服务，适合放在多种 NAS 或 Docker 面板里运行，例如群晖 Container Manager、飞牛、绿联、铁威马、1Panel、宝塔、CasaOS、Portainer 等。

通用参数：

```text
镜像: ghcr.io/maiga512/ceru-music-nas-sync:latest
容器端口: 31231
宿主机端口: 31231
数据目录: /data
环境变量:
  CERU_SYNC_HOST=0.0.0.0
  CERU_SYNC_PORT=31231
  CERU_SYNC_DB_PATH=/data/ceru-sync.sqlite
  CERU_SYNC_ADMIN_TOKEN=你自己的长随机字符串
```

数据卷示例：

```text
宿主机目录 /你的路径/ceru-nas-sync/data  ->  容器目录 /data
```

## Web 管理后台

部署完成后打开：

```text
http://你的NAS地址:31231/admin
```

首次登录：

```text
账号: admin
密码: password
```

登录后建议先修改管理员密码。修改密码后会强制退出，需要重新登录。

管理后台可以：

- 新建同步用户。
- 为每个用户生成长期绑定码。
- 复制服务端地址。
- 查看每个用户的歌单、歌曲、收藏、登录设备数量。
- 删除用户。删除时需要输入 `我要删除` 确认。
- 修改管理员用户名和密码。

## 插件下载和导入

插件文件在仓库里：

```text
plugins/ceru-nas-sync-service.js
```

GitHub 原始下载地址：

```text
https://raw.githubusercontent.com/maiga512/CeruMusic-NAS-Sync/main/plugins/ceru-nas-sync-service.js
```

在澜音/Ceru Music 桌面端：

```text
设置 -> 插件 -> 添加插件 -> 澜音插件 -> 本地导入 -> 选择 ceru-nas-sync-service.js
```

插件配置：

```text
启用 NAS 同步: 打开
NAS 同步服务器地址: http://你的NAS地址:31231
登录绑定码: Web 管理后台为当前用户生成的绑定码
```

如果你配置了 HTTPS 反向代理，服务器地址填写反代地址，例如：

```text
https://music-sync.example.com
```

不要把管理员账号密码填到插件里。插件只需要服务器地址和绑定码。

## 同步逻辑

1. 第一次在插件里登录成功后，桌面端会立刻进行首轮上传，把本机歌单、歌单歌曲和收藏关系写到 NAS 服务端。
2. 之后本机歌单发生新增、删除、加歌、删歌等变化，会延迟几秒合并备份到 NAS，避免频繁请求。
3. 其他设备通过轮询 `/sync?sinceRevision=...` 获取变更事件，然后拉取变更内容写入本地。
4. 服务端以 revision 记录事件，每个同步用户的 revision 独立，不会混到其他用户。

## 反向代理

推荐使用独立域名或子域名反代到服务根路径：

```text
https://music-sync.example.com -> http://NAS_IP:31231
```

Nginx 示例：

```nginx
server {
  listen 443 ssl http2;
  server_name music-sync.example.com;

  location / {
    proxy_pass http://NAS_IP:31231;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

不建议反代到子路径，例如 `/ceru-sync`，因为插件和后台接口默认使用 `/admin`、`/auth/pair`、`/sync`、`/me` 等根路径。

## 找回管理员账号或密码

如果忘记 Web 管理后台密码，可以用 `.env` 里的 `CERU_SYNC_ADMIN_TOKEN` 重置：

```bash
curl -X POST http://你的NAS地址:31231/admin/reset-admin \
  -H "Content-Type: application/json" \
  -H "x-admin-token: 你的CERU_SYNC_ADMIN_TOKEN" \
  -d '{"username":"admin","password":"新的管理员密码"}'
```

也可以进入容器离线重置：

```bash
docker compose exec ceru-nas-sync node src/resetAdmin.ts admin 新的管理员密码
```

这个操作只重置管理后台账号，不会删除用户、绑定码、歌单、收藏或同步数据。

## 开发

需要 Node.js 22。

```bash
cd server
yarn install
yarn typecheck
yarn start
```

## License

AGPL-3.0-only
