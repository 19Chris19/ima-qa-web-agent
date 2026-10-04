# 固定版本：Node 与 Docker

同一个 Release 提供同一份源码的 Node 与 Docker 部署路径，不存在另一个
独立的“本地版本”。v0.4.1 延续 v0.4.0 网站合同，增加已审查的 Docker 与扫码修复。

## Docker 镜像

镜像名：`ghcr.io/19chris19/ima-qa-web-agent:v0.4.1`。Linux AMD64 与 ARM64
使用同一个版本名，由 Docker 选择架构。Release 附件 `release-manifest.json`
记录源码提交、多平台镜像摘要与验收边界；部署时推荐固定 `@sha256:...`。
首次发布须核对包为 public 并验证匿名拉取，不以仓库 public 推断镜像 public。

```sh
docker pull ghcr.io/19chris19/ima-qa-web-agent:v0.4.1
npm ci
npm run setup:provider-a
docker compose -f compose.yaml -f compose.images.yaml up -d --no-build
```

上例沿用交互初始化；不想在宿主机安装 Node 时，在已下载的源码目录中：

```sh
docker run --rm -it --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" -w /workspace \
  node:22-bookworm-slim node scripts/setup-provider-a.mjs
docker compose -f compose.yaml -f compose.images.yaml up -d --no-build
```

初始化仍需操作者填写知识库配置和授权凭证，不能对已有 `.env` 或 runtime
重新执行初始化来升级。管理端口默认只在本机可访问。扫码路径见
[Docker 维护浏览器](DOCKER_BROWSER_ENROLLMENT.md) 与 [部署指南](DEPLOYMENT.md)。
维护机扫码工具需要兼容的源码版本；镜像不带桌面浏览器。

## 本地 Node

下载相同 tag 的源码，依次运行 `npm ci`、`npm run setup:provider-a`、`npm start`。
继续支持项目声明的 Node 范围，生产容器固定使用 Node 22。

## 升级和回退

先检查普通问答队列与接入任务空闲，私有备份配置和持久数据，再在维护窗口
修改 `PROVIDER_IMAGE` 为已验证摘要并重建服务。回退只切到前一镜像／代码，
继续挂载当前数据；不能用旧账号库覆盖当前账号或会话。破坏性数据迁移另行审查。
升级后人工完成一问一追问，核对流式正文、来源和历史；健康检查不能替代问答。

发布工作流只做网络关闭的空池启动和合成测试，不扫码、不请求 IMA。
真实账号复验、Linux 云主机长期运行和备份演练属于部署者验收。
