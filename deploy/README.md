# 阿里云部署

本项目使用现有 ECS 的 Node.js + systemd + Caddy，地址为 `https://f.qdfb.tech/plants/`。不创建收费云资源。Node 只监听回环地址，HTTPS 入口对整个 `/plants` 与 `/plants/*` 设置独立的 HTTP Basic 登录保护。

## 文件布局

- `/opt/zhishi/releases/<版本>`：只读应用代码，与 GitHub 提交对应。
- `/opt/zhishi/current`：当前版本的符号链接。
- `/opt/zhishi/runtime/node`：Node.js 运行时。
- `/var/lib/zhishi`：持久化植物、用户照片、历史及配图缓存，代码更新不得覆盖。
- `/etc/zhishi.env`：环境配置，权限 0600。
- `/etc/systemd/system/zhishi.service`：独立非 root 服务。
- `/opt/zhishi/backups`：每次切换前的配置与植物 JSON 快照，权限 0700。

配置项见根目录 `.env.example`。实际启动不会自动读取 `.env`，本机测试请在命令行设置环境变量；线上由 systemd 加载。`PUBLIC_ORIGIN` 必须为明确的 HTTPS origin；服务不信任请求自带的 forwarded 主机信息。`BASE_PATH` 不以 `/` 结尾。

## 共享代理

服务器现有 Caddy 2.6 使用 `basicauth` 指令（新版名为 `basic_auth`）。在现有 `https://f.qdfb.tech` 站点内增加以下路由，保留原同班记兜底代理：

```caddyfile
@zhishi path /plants /plants/*
handle @zhishi {
    basicauth bcrypt "Zhishi" {
        zhishi REPLACE_WITH_BCRYPT_HASH
    }
    reverse_proxy 127.0.0.1:18188
}
handle {
    reverse_proxy 127.0.0.1:18080
}
```

不要剥离 `/plants` 前缀。不要把 Node 端口直接开放到公网。登录密码及其哈希不进入仓库；实际配置保存在服务器与本机受保护的交接文件中。

变更前备份当前 Caddyfile，先 `caddy validate`，再平滑 `systemctl reload caddy`。不要停止共享 Caddy、修改其他服务环境或恢复其他站点数据库。参考 [Caddy 认证](https://caddyserver.com/docs/caddyfile/directives/basic_auth) 与 [独立路由](https://caddyserver.com/docs/caddyfile/directives/handle)。

## 更新与回退

1. `npm test` 与 `npm run check`，提交 GitHub；仅打包已跟踪的代码。
2. 上传归档并验证 SHA-256，解压到新 release。
3. 备份 `/var/lib/zhishi/plants.json`（原子写入，可复制完整文件）及当前 release 链接。首次上线单独导入用户当前数据，此后更新不得导入本地数据。
4. 切换 `current`，重启 `zhishi`，检查本机 API、公开 HTTPS 未登录 401、登录后 API/页面，以及原站点健康。
5. 回退时仅将 `current` 指回上一 release 并重启 `zhishi`，不得用旧 JSON 覆盖新养护记录。代理变更要比较后仅撤销本次路由。

运维：`systemctl status zhishi`、`journalctl -u zhishi -n 50`。状态与配图接口均在 `/plants/api/` 下且需要认证。浏览器关闭或设备休眠后仍不能推送提醒；部署只使网页与数据可以跨设备访问。
