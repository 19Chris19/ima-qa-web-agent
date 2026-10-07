# 受邀网站的私有连接

这是共享网关候选的维护者手册，不是 v0.4.2 已包含功能，也不向公开项目用户承诺任何现成账号池。网关合同见 [SHARED_GATEWAY.md](SHARED_GATEWAY.md)。

```text
同事浏览器 -> 同事网站 BFF -> Tailscale HTTPS :443
                                  -> 本机网关 127.0.0.1:8790
                                  -> 本机 Provider -> IMA
```

## 开放前必须检查

1. 使用独立网关进程、独立私有配置、稳定的部署 ID 和随机的每站接入密钥。不要给同事 Provider 普通、内部或管理员凭证。不要把配置放进仓库、聊天记录、命令参数或报告。
2. 经用户批准安装官方 Tailscale，由用户登录和批准设备。Node BFF 在其所在机器验证网络；Docker BFF 还必须从容器内验证 DNS、HTTPS 和取消传播，宿主机连通不代表容器连通。
3. 查看当前 Serve/Funnel 配置及 tailnet 全部 ACL/grants。授权仅指批准的 BFF 设备到网关 HTTPS，不是同事所有设备到 Air 所有端口。已有宽泛允许规则会使新窄规则失去限制作用；不能仅追加规则就宣布隔离成功。
4. 检查 Provider 监听、局域网、防火墙、IPv4/IPv6、其他隧道和路由。若远端能绕过网关直达 Provider，停止开放。先评估现有 Docker/机器人连接，再另安排维护修复；不要直接改变绑定导致业务中断。
5. 保留 Provider 当前队列与全部可用容量。共享站点与其他调用方竞争容量，没有独占保证，也不另设一并发限制。管理员可以撤销站点密钥；已有流是否立即终止见网关合同。

## Tailscale 配置示意

下面是由维护者在策略编辑器审查的示意，不是可以覆盖现有策略的完整配置。标签必须由管理员控制，只有被批准的设备才能取得客户端标签。

```json
{
  "grants": [
    {
      "src": ["tag:qa-approved-bff"],
      "dst": ["tag:qa-gateway"],
      "ip": ["tcp:443"]
    }
  ]
}
```

先保存现有网络配置的私有备份，确认 443 未被其他 Serve 服务占用。只在检查通过、明确授权后执行：

```sh
tailscale serve status --json
tailscale funnel status
# 以下是改变配置的命令，不属于只读预检：
tailscale serve --bg --https=443 http://127.0.0.1:8790
```

禁止开启 Funnel，禁止直接映射 3117、管理页或内部 API。不要使用 `tailscale serve reset` 清掉其他服务。撤回本功能时，核对映射仍属于本项目后只关闭这一条：

```sh
tailscale serve --https=443 off
```

Serve 负责私有 HTTPS；它不替代站点凭证、访客隔离或 tailnet 权限检查。详见官方 [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve) 和 [grants 示例](https://tailscale.com/docs/reference/examples/grants)，命令核对日期为 2026-10-07。

## 凭证交付和恢复

通过受控私密通道交付固定 HTTPS 地址与该站点密钥，仅写入同事 BFF 的私有配置。不得放入浏览器环境变量、前端代码或构建产物。站点自身生成 Cookie 签名密钥。

轮换时保持部署 ID 和网关 HMAC 密钥不变；原站点先更新私有配置，再移除旧 token 并重载站点注册表。不得通过更换部署 ID 来撤销单个 token，否则会改变历史归属。备份网关 HMAC 密钥和 Provider 数据分别存放，不用旧备份覆盖新会话。

## 验收记录模板

| 项目 | 需要的证据 |
| --- | --- |
| 获批 Node BFF | 有效证书、能力接口、合成 SSE、取消、无重定向 |
| 获批 Docker BFF | 从容器内完成同样检查，不能仅测试宿主机 |
| 未获批设备 | 网关连接被网络策略拒绝 |
| 旁路 | 原 Provider 端口和其他 Air 服务不可访问，覆盖 IPv4/IPv6 |
| 路径 | `/admin`、`/internal/` 和未知路径被拒绝 |
| 身份 | 两站同名访客历史隔离，跨站详情/删除拒绝，轮换保留历史 |
| 问答 | 另行授权的一问一追问；健康检查不得代替 |

没有第二台批准设备时，网络隔离和真实 Tailscale 链路填“未验收”。本机合成测试不得写成远端已通过。Air 休眠、断网或 Docker 停止可能使网站不可用；共享安装适合联调，不是 24 小时服务承诺。
