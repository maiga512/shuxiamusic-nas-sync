# NAS 免密访问 & 部署说明（给 AI / 自动化）

> 目的：AI 或脚本无需知道 NAS 登录密码，即可登录并以 root 权限管理同步服务器。
> **本文件不包含任何密码。凭据只有那把本地私钥。**

## 登录方式（免密钥登录）

用 SSH host 别名，私钥认证，无需密码：

```bash
ssh shuxia-nas            # = 18523520567@192.168.5.11 -p 10088
```

- host 别名定义在本机 `~/.ssh/config` 的 `Host shuxia-nas`
- 私钥：`~/.ssh/shuxia_nas_ed25519`（保管好这台 Mac，就是唯一密钥）
- 已在 NAS 上授权（`~/.ssh/authorized_keys`）

## root 权限（免密 sudo）

该账号已配置免密 sudo，任何 root 操作都不用输密码：

```bash
ssh shuxia-nas 'sudo -n whoami'    # -> root
```

- 授权文件：NAS 上 `/etc/sudoers.d/shuxia-ai`（`18523520567 ALL=(ALL) NOPASSWD: ALL`）
- `sudo -n` = 非交互，缺密码会直接失败，可用来检测配置是否还在

## 同步服务器位置

- 运行容器：`ceru-nas-sync`（`ssh shuxia-nas 'sudo -n docker ps'` 可见）
- compose / 源码目录：`/zspace/zsrp/zdocker/compose_config/ceru-nas-sync/nas-sync-server`
- 本机源码（source of truth）：`/Users/songsong/Movies/树夏Music-Desk-tauri/nas-sync-server`

## 常用部署命令

```bash
# 看容器状态
ssh shuxia-nas 'sudo -n docker ps --filter name=ceru-nas-sync'

# 同步本机最新源码到 NAS（示例，按需调整）
rsync -avz -e "ssh" --rsync-path="sudo rsync" \
  /Users/songsong/Movies/树夏Music-Desk-tauri/nas-sync-server/src/ \
  shuxia-nas:/zspace/zsrp/zdocker/compose_config/ceru-nas-sync/nas-sync-server/src/

# 重新构建并重启容器
ssh shuxia-nas 'cd /zspace/zsrp/zdocker/compose_config/ceru-nas-sync/nas-sync-server && sudo -n docker compose up -d --build'

# 看日志
ssh shuxia-nas 'sudo -n docker logs --tail 100 ceru-nas-sync'
```

## 安全须知

- 免密 sudo = 谁拿到这台 Mac 上的私钥 `shuxia_nas_ed25519`，谁就等于 NAS 的 root。请像保护密码一样保护该私钥文件。
- 若要收回权限：删除 NAS 上 `/etc/sudoers.d/shuxia-ai`，并从 `~/.ssh/authorized_keys` 移除对应公钥。
- 不要把这把私钥或 NAS 密码贴进任何对话 / 提交进 git。
