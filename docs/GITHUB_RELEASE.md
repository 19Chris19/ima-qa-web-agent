# GitHub 发布与维护

这份发布物只交付 Provider A：IMA Web Agent 账号池。它不包含任何真实账号登录态、共享库原文、会话记录、OpenAPI 凭证或 MIMO 凭证。

公开仓库地址：[https://github.com/19Chris19/ima-qa-web-agent](https://github.com/19Chris19/ima-qa-web-agent)。普通部署者只需要克隆该仓库，不需要理解或执行 subtree 同步。

## 给部署者

```bash
git clone https://github.com/19Chris19/ima-qa-web-agent.git
cd ima-qa-web-agent
npm ci
npm run setup:provider-a
docker compose up -d --build
```

初始化只询问 IMA 网页共享知识库的数字 ID 和可选的允许来源域名。它会生成私有 `.env` 与管理员 token；没有任何 IMA 账号或登录态会随仓库下载。

接入首个账号：

```bash
npm run admin:enroll -- --name account-a --server-url http://127.0.0.1:3117
```

脚本会先验证管理员 token、共享库和账号名称，再为该账号打开独立临时浏览器窗口。完成官方登录或扫码，并确保该账号已加入目标共享知识库。工具验证共享库会话后加密保存服务端凭证、关闭浏览器并清理临时 profile。每增加一个账号，只需改账号名称后重复一次；同名重新绑定必须显式使用 `--replace`，不会静默覆盖旧账号。

纯 Linux 服务器不能显示扫码窗口。此时按照 [DEPLOYMENT.md](DEPLOYMENT.md#远程服务器--本机扫码) 在有图形界面的维护机上通过 SSH 隧道接入账号。

## 给发布维护者

当前应用的源代码维护在主仓库 `apps/ima-qa-web` 子目录；公开仓库 `main` 从该子目录同步。只有维护者需要在主仓库根目录运行：

```bash
git subtree split --prefix=apps/ima-qa-web > /tmp/ima-qa-web-release-commit
git push github-ima-qa "$(cat /tmp/ima-qa-web-release-commit):main"
```

这只更新独立仓库的 `main`，不会把主仓库里的其他目录推送出去。推送前必须先确认 `github-ima-qa` 指向上述公开仓库，且暂存区不含私有运行数据。

发布前必须确认以下私有内容未进入 Git：

```bash
git status --short
git ls-files .env runtime node_modules
```

后一个命令不应输出任何内容。不要通过 GitHub Actions、Release 附件、Issue、截图或日志发送 `.env`、`runtime/`、cookie、refresh token、账号库 key 或真实问答历史。

## 交付边界

- Docker 和 `npm start` 只会启动 `ima-web-agent`。若 `.env` 被改为其他 Provider，服务会明确拒绝启动。
- 一个账号稳定处理一条 IMA 问答；全局问答容量自动跟随已启用账号数。每接入一个新账号，服务立即增加一条上游并发，不改配置、不重启；多余请求继续等待空闲账号，不会并发挤进同一个 IMA 登录态。
- 浏览器只用于扫码接入，不参与运行期问答。运行期凭证默认只存在服务器私有 `runtime/` 的加密账号库，并由 refresh token 尽量续期；默认不生成 cookie 明文 env 文件。
- IMA 控制 token 最终有效期和风控策略。refresh 失败、账号登出或共享库权限变化时，只重新接入受影响账号。
- Docker 默认只监听服务器本机 `127.0.0.1`。公开部署通过 Nginx 提供 HTTPS；外站 iframe 和前端直调 API 都要配置精确 `ALLOWED_ORIGINS`，它同时控制 iframe 的 CSP 嵌入白名单。
