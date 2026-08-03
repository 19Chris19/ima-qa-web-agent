# IMA QA Web Agent

这是 IMA 共享知识库问答的 Provider A 发布版。服务通过已授权 IMA 账号调用 IMA 网页端的共享知识库问答能力，保留流式回答、多轮会话、来源卡片、账号池与登录态刷新。

发布和部署只需要 Provider A，不需要 IMA OpenAPI、MIMO Key、本地语料或本地索引。

`npm start` 与 Docker 镜像都会校验 `IMA_QA_PROVIDER=ima-web-agent`，其他 Provider 配置会拒绝启动。这让交付给客户的标准路径只运行 Provider A。

## 准备事项

部署者需要准备四样东西：

1. 一个 IMA Web 共享知识库的数字 ID。从网页地址中的 `knowledgeBaseId=` 获取；它不是 OpenAPI 的 Base64 ID。
2. 一个或多个已经合法加入该共享知识库的 IMA 账号。
3. 一台运行服务的服务器，以及一台能打开 Chrome、Chromium 或 Ego Lite 的维护机。两者可以是同一台电脑。
4. Docker Compose，或 Node.js 18.18 以上版本。

## 最短部署路径

```bash
git clone <你的 GitHub 仓库地址>
cd <GitHub 仓库目录>
npm ci
npm run setup:provider-a
docker compose up -d --build
```

初始化向导只会询问共享知识库 ID 和可选的网页域名，自动创建私有 `.env`、管理员 token 与 `runtime/` 数据目录。启动后：

- 问答页：`http://服务器地址:3117/`
- 嵌入页：`http://服务器地址:3117/embed.html`
- 账号管理页：`http://服务器地址:3117/admin.html`

接入第一个账号：

```bash
npm run admin:enroll -- --name account-a --server-url http://127.0.0.1:3117
```

命令会先校验管理员 token、目标共享库和账号名称，再打开一个与其他账号隔离的浏览器窗口。扫码或登录后，它会检查该账号能否初始化目标共享知识库会话，成功才保存；随后自动关闭并清理临时浏览器 profile。再接入账号时，只需换名字：

```bash
npm run admin:enroll -- --name account-b --server-url http://127.0.0.1:3117
```

扫码没有成功、账号没有加入该共享库或 IMA 页面拒绝会话时，不会写入账号池。

账号名称不能重复，避免误覆盖旧登录态。确认要给同名账号重新扫码绑定时，显式追加 `--replace`。

## 账号管理

访问 `/admin.html`，输入 `.env` 中的 `IMA_QA_ADMIN_TOKEN`。管理页只显示脱敏状态，可查看：

- 可用、忙碌、冷却和停用账号数。
- 每个账号的令牌到期时间、最近错误和使用状态。
- 检查、刷新、启用、停用、删除账号的操作。
- 当前共享库对应的逐账号接入命令。

管理页和普通用户问答页都不会返回 cookie、refresh token、账号加密密钥、IMA session ID 或内部账号凭证。

## 服务器没有图形界面时

浏览器扫码必须在有 GUI 的维护机上完成，不能在纯 Linux 服务器里“弹出到你的电脑”。推荐用 SSH 隧道把服务器的管理接口只暴露到维护机：

```bash
# 在维护机执行，保持该窗口开启
ssh -N -L 3117:127.0.0.1:3117 deploy@your-server

# 在维护机的项目副本中执行。值从服务器私有 .env 获取，不要提交或发送。
IMA_QA_ADMIN_TOKEN='你的管理员 token' \
npm run admin:enroll -- \
  --name account-a \
  --kb '共享库 Web 数字 ID' \
  --server-url http://127.0.0.1:3117
```

扫码脚本会在维护机本地打开浏览器，但捕获到的凭证通过隧道写入服务器的加密账号库。浏览器临时 profile 会在成功后自动删除。

## 登录态与备份

- 账号库使用 AES-256-GCM 加密，密钥单独保存在 `runtime/ima-web-agent-accounts.key`。默认不会生成包含 cookie 的明文账号 env；加密账号库是运行期唯一真源。
- 服务每分钟检查账号认证状态，并在 access token 接近到期前十分钟尝试 refresh。IMA 最终的 token 时长和风控策略由上游控制，不能承诺固定天数。
- refresh 失败、账号登出或共享库权限失效时，只影响该账号；在 `/admin.html` 检查后，重新运行该账号的接入命令即可。
- 备份必须整体保存 `runtime/`，并以私有权限保存。只有 JSON 文件没有 key 文件无法解密账号；不要把它们上传 GitHub、网盘公开链接或日志系统。
- 稳定基线是每个账号同时只处理一条 IMA 问答。账号池容量默认自动跟随已启用账号数：接入两个账号即并行两条，接入第六个账号即扩为六条，不改配置、不重启服务。更多账号提升的是总并发，不是单账号并发。

旧版本如果已经生成过 `runtime/web-agent-accounts/*.env`，先预览再执行一次迁移，最后重启服务：

```bash
npm run admin:seal-runtime
npm run admin:seal-runtime -- --apply
```

迁移只处理受管的逐账号明文导出，不会自动删除旧的全局启动 env 或浏览器 profile，避免影响仍依赖它们的历史部署。

## 嵌入与公网

嵌入现成界面：

```html
<iframe
  src="https://qa.example.com/embed.html"
  style="width: 100%; height: 640px; border: 0"
  title="共享知识库问答"
></iframe>
```

公网反代需要关闭 SSE buffering，并设置 `TRUST_PROXY=true`。容器默认仅监听服务器本机 `127.0.0.1`，由 Nginx 提供 HTTPS 和公网入口；外站 iframe 和前端直调 API 都要把精确的 `https://` 域名写入 `ALLOWED_ORIGINS`。iframe 会生成独立浏览器标识，避免第三方 Cookie 策略导致历史丢失。Nginx 示例、账号接入故障处理、备份和发布检查见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

将当前子目录作为独立 GitHub 仓库发布、以及部署者从克隆到逐账号扫码接入的完整说明见 [docs/GITHUB_RELEASE.md](docs/GITHUB_RELEASE.md)。

## 验证

```bash
npm test
curl http://127.0.0.1:3117/healthz
```

并发与会话隔离请用脚本测试，不要靠手动同时点击：

```bash
npm run test:concurrency -- \
  --base-url http://127.0.0.1:3117 \
  --concurrency 2 \
  --follow-up
```

开源发布前，确认 Git 中不含 `.env`、`runtime/`、浏览器 profile、token、cookie、共享库原文或真实问题历史。
