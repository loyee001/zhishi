# 阿里云部署

本项目计划使用现有 ECS 的 Node.js + systemd + Caddy，正式访问地址为 `https://zhi.qdfb.tech`。本说明是部署要求，不表示域名解析、证书签发或上线验收已经完成。不创建收费云资源。Node 只监听回环地址，独立域名的全部页面、静态资源与 API 均通过 HTTP Basic 登录保护。

部署前需将 `zhi.qdfb.tech` 的 DNS 记录指向目标 ECS 的公网入口，确认域名实际解析到该服务器。先配置单独的 HTTP challenge 站点，使用 `/var/lib/caddy/zhishi-zhi-qdfb-tech/webroot` 完成证书签发，再安装应用。完整证书链与私钥分别放在 `/var/lib/caddy/zhishi-zhi-qdfb-tech/tls/fullchain.pem`、`key.pem`，并确保 Caddy 服务可以读取。安装脚本会通过 OpenSSL 验证证书信任链、有效期、`zhi.qdfb.tech` 域名和私钥匹配，不负责申请或续签证书。续签后需重新加载 Caddy。不要以 DNS 配置已提交或 HTTP 可访问代替 HTTPS 验收。

## 文件布局

- `/opt/zhishi/releases/<版本>`：只读应用代码，与 GitHub 提交对应。
- `/opt/zhishi/current`：当前版本的符号链接。
- `/opt/zhishi/runtime/node`：Node.js 运行时。
- `/var/lib/zhishi`：持久化植物、用户照片、历史及配图缓存，代码更新不得覆盖。
- `/etc/zhishi.env`：环境配置，权限 0600。
- `/etc/systemd/system/zhishi.service`：独立非 root 服务。
- `/opt/zhishi/backups`：每次切换前的配置与植物 JSON 快照，权限 0700。

配置项见根目录 `.env.example`。实际启动不会自动读取 `.env`，本机测试请在命令行设置环境变量；线上由 systemd 加载。本次部署设置 `PUBLIC_ORIGIN=https://zhi.qdfb.tech`、`BASE_PATH=`，空路径表示独立域名根路径。服务不信任请求自带的 forwarded 主机信息。可选的子路径部署能力仍保留，例如 `BASE_PATH=/plants`；非空路径不以 `/` 结尾，代理需保留该前缀。

## 共享代理

服务器现有 Caddy 2.6 使用 `basicauth` 指令（新版名为 `basic_auth`）。为 `zhi.qdfb.tech` 增加以下独立站点块，保留现有 `f.qdfb.tech`、`ai.qdfb.tech` 的站点与证书配置：

```caddyfile
# BEGIN ZHISHI DOMAIN
http://zhi.qdfb.tech {
    @zhishiChallenge path /.well-known/acme-challenge/*
    handle @zhishiChallenge {
        root * /var/lib/caddy/zhishi-zhi-qdfb-tech/webroot
        file_server
    }
    handle {
        redir https://zhi.qdfb.tech{uri} 308
    }
}
https://zhi.qdfb.tech {
    tls /var/lib/caddy/zhishi-zhi-qdfb-tech/tls/fullchain.pem /var/lib/caddy/zhishi-zhi-qdfb-tech/tls/key.pem
    basicauth bcrypt "Zhishi" {
        zhishi REPLACE_WITH_BCRYPT_HASH
    }
    reverse_proxy 127.0.0.1:18188
}
# END ZHISHI DOMAIN
```

预置的 HTTP challenge 站点也要用上述 `BEGIN/END ZHISHI DOMAIN` 标记包围。安装脚本只替换这对标记间的块；没有标记时，仅在不存在未知 `zhi.qdfb.tech` 配置的情况下追加。标记重复、不完整，或标记外已有该域名配置时会停止，要求人工检查。

本次根路径部署无需路径改写。HTTP challenge 路径可用于证书校验，其余 HTTP 请求以 308 跳转 HTTPS；全部 HTTPS 页面、资源与 API 需要登录。不要把 Node 端口直接开放到公网。登录密码及其哈希不进入仓库；实际配置保存在服务器与本机受保护的交接文件中。

变更前备份当前 Caddyfile，先 `caddy validate`，再平滑 `systemctl reload caddy`。不要停止共享 Caddy、修改其他服务环境或恢复其他站点数据库。参考 [Caddy 认证](https://caddyserver.com/docs/caddyfile/directives/basic_auth) 与 [独立路由](https://caddyserver.com/docs/caddyfile/directives/handle)。

## 更新与回退

1. `npm test` 与 `npm run check`，提交 GitHub；仅打包已跟踪的代码。
2. 上传归档并验证 SHA-256，解压到新 release。
3. 备份 `/var/lib/zhishi/plants.json`（原子写入，可复制完整文件）及当前 release 链接。首次上线单独导入用户当前数据，此后更新不得导入本地数据。
4. 切换 `current`，重启 `zhishi`，检查本机 `/api/config` 与 `/api/state`、`https://zhi.qdfb.tech` 未登录 401、登录后的根页面/静态资源/API，以及原站点健康。`/api/config` 应返回 `basePath: ""` 和 `hosted: true`。
5. 回退时仅将 `current` 指回上一 release 并重启 `zhishi`，不得用旧 JSON 覆盖新养护记录。代理变更要比较后仅撤销本次路由。

安装脚本为网络检查设置超时，并在命令失败或收到 INT/TERM 时尝试恢复原应用链接、环境配置、服务文件、运行时及服务状态。恢复 Caddy 前会比较当前配置；如果部署期间其他操作修改了配置，会保留该修改并提示人工检查。植物数据始终保留，不随代码回退。

脚本运行完成后仍需使用实际登录信息验证页面、静态资源和 API 返回 200，并核对植物与养护记录；未登录返回 401 只能证明存在访问保护，不能代替登录验收。

运维：`systemctl status zhishi`、`journalctl -u zhishi -n 50`。本次部署的状态与配图接口均在 `https://zhi.qdfb.tech/api/` 下且需要认证。浏览器关闭或设备休眠后仍不能推送提醒；部署只使网页与数据可以跨设备访问。
