# Agent 部署与扫码接入

## 当前交付状态

三路径选择器、只读依赖预检和 `--allow-bootstrap` 是从 v0.4.2 开始开发的**后续候选**，已发布 v0.4.2 不包含本页新增 CLI 语法。以下原安装器说明沿用 v0.4.2；部署必须固定与入口语法匹配的源码。Gateway 同样是独立候选，不可据本页宣布已发布或共享可用。

本流程对应 **v0.4.2** 源码；v0.4.1 没有这套统一引导入口。先确认 GitHub Releases 中存在对应正式版本及镜像验收清单。若尚未发布，只能使用经审查的候选源码和候选镜像隔离演练，不能把不存在的 tag 当作已发布版本。

Agent 必须先查 Releases，选择最新已发布稳定 tag 和对应镜像。不要直接部署浮动 main，不混用 tag 的工具和其他版本镜像。不要求人手工寻找知识库数字 ID。

管理体验采用展开式账号列表，不采用此前的表格／详情抽屉方案。维护时间来自运行中的调度器，未知到期时间不得猜测；管理页查看状态不会触发真实问答。重新登录扫到其他身份时可显式选择“作为新账号接入”，保留原账号；取消或超时清理暂存状态。参见 [后台说明](./ADMIN_EXPERIENCE.md)、[维护状态](./ACCOUNT_MAINTENANCE.md)、[账号接入](./ACCOUNT_ENROLLMENT.md)。已有定制服务必须先比对额外合同，不得因为版本号较新就覆盖机器人等依赖的运行版本。

## 先询问三条路径

在 clone、运行时 bootstrap、依赖安装或服务安装之前，用 Agent 原生提问工具问用户；没有原生提问时显示编号菜单并等待：

1. `online`：使用运营方提供的网站，无本机安装。私有 Explorer 需要独立访问权限，公开 Provider 不授予该权限。
2. `shared`：等待运营方邀请，共享 Explorer 不安装 Provider。当前入口仅返回 `pending_invitation`，不实现 gateway 开通，不要求粘贴 cookie、token、管理员凭证或原始上游秘密。
3. `independent`：独立运行公开 Provider 通用问答服务。它是本仓库的主要部署用途，不等于获得私有 Explorer 源码或网站部署权限。

不得根据系统环境、已有 Docker 或“帮我部署”猜测路径。选择不是安装授权；依赖安装、服务安装、真实 QA 分别确认。用户未回答时停下，不继续 bootstrap。已有检出可运行 `sh onboard.sh choose` 或 `.\onboard.ps1 choose`；菜单没有默认项，EOF 取消。非交互必须传 `--deployment-mode`，缺省返回非零 `deployment_mode_required`。

`choose`、`doctor`（预检别名）和 `preflight` 只读，不 clone、不下载、不写配置、不启动服务或浏览器。online/shared 不探测本机 Docker。`--deployment-mode` 与已有 `--mode desktop|server` 完全不同；后者不能代替用户选择。选择不持久化，每次命令都需显式模式。

### 共享候选与网络阻塞

Gateway 是另行开发的候选，**不在 v0.4.2 内**，本分支也不包含其实现。只有取得该候选时才参考其中的 `docs/SHARED_GATEWAY.md`：运营方 CLI 为 `node scripts/shared-gateway.cjs`，`SHARED_GATEWAY_CONFIG` 指向 Git 外的私有配置文件。这里记录的是候选合同，不是要求用户立即执行的命令；选择器不读取、生成或输出该配置。共享 Explorer 接入者不安装 Provider，运营方凭证留在运营方服务端。

2026-10-07 用户提供的 Air 状态：PATH 和 `/Applications` 均未发现 Tailscale，Provider 3117 仍为 `*` 监听。此状态下真实共享开放被阻塞，须另行审批网络配置并核验访问控制和监听边界。此记录不是本任务执行的实时探测。本任务不改监听、不安装 Tailscale、不启动 gateway、不开放隧道或端口；不能宣称 ready、shared working 或可供外部使用。

## 给 Agent 的提示词

> 请先用原生提问或编号菜单问我选择 online、shared 还是 independent，并等待我回答。不要先 clone、bootstrap 或安装。公开 Provider 主要用于独立通用服务，私有 Explorer 需要另行授权。online 只确认运营方网址与访问权限；shared 等待邀请，不索取原始秘密；independent 先只读预检，报告 stage/missing/next。缺依赖时解释官方 Docker 安装、许可和人工系统步骤，得到明确同意再安装。选择路径不等于安装同意。独立安装按最新稳定发布版文档检查端口、已有安装和固定镜像，不覆盖数据、不开放管理接口、不输出凭证。Linux 使用维护电脑和 SSH 扫码。扫码、手机确认和知识库加入由我完成；真实问答单独征得授权，普通检查不提问，不仅凭健康检查宣布成功。

适用于具备终端能力的 Codex、Claude Code 等 Agent，不依赖厂商插件。

## 预检与首次安装

只读选择不需要 Node、Docker、Git 或下载工具。独立服务预检检查 OS/架构、Docker CLI、daemon 可达性、权限、Compose v2、Node 22+ 和现有维护依赖；Node 可以来自系统或原有私有缓存，不要求全局安装。缺项停止并返回结构化结果，不隐式安装。缺 CLI 与 daemon 停止/不可达是不同状态，未知失败不冒充“未安装”。完整依赖、官方来源和人工步骤见 [DEPENDENCIES.md](./DEPENDENCIES.md)。Windows 尊重执行策略，不使用 Bypass。

Mac/Linux:

```sh
sh onboard.sh choose
sh onboard.sh preflight --deployment-mode independent
# 以下命令仅在用户分别授权所需的下载、浏览器与服务操作后运行。
sh onboard.sh runtime --deployment-mode independent --allow-bootstrap
sh onboard.sh resolve --deployment-mode independent --share-url '你提供的官方 IMA 分享链接'
sh onboard.sh install --deployment-mode independent --share-url '你提供的官方 IMA 分享链接' --project my-ima-qa --port 3117
sh onboard.sh check --deployment-mode independent
```

Windows PowerShell:

```powershell
.\onboard.ps1 choose
.\onboard.ps1 preflight --deployment-mode independent
.\onboard.ps1 runtime --deployment-mode independent --allow-bootstrap
.\onboard.ps1 install --deployment-mode independent --share-url '你提供的官方 IMA 分享链接' --project my-ima-qa --port 3117
.\onboard.ps1 check --deployment-mode independent
```

只有显式 `runtime` 或 `install`、`--deployment-mode independent`、`--allow-bootstrap` 三者同时满足时，入口才允许原有私有 Node 22.22.3 下载/校验与 `npm ci --omit=dev` 准备路径。该标志表示用户已明确批准下载及执行锁定依赖，不授权 Docker 安装、系统修改或真实 QA。只读命令拒绝该标志；其他命令可以复用已备齐的系统或私有运行时，但不自动 bootstrap。SHA-256 校验、HTTPS、已有目标不覆盖及私有权限保护保留。

Compose 门禁检查 `docker compose version --short` 是否成功且主版本 >=2，兼容 5.x 等更新主版本，不要求输出恰为 2.x。`compose_v2` 是保留的错误标识，不代表拒绝所有更高主版本；预检仍不执行容器命令。

独立服务安装获授权且依赖备齐后，原安装器仍会下载与容器 Playwright 相同版本的专用 Chromium，创建独立私有连接密钥：Mac 使用用户 LaunchAgent，Windows 使用用户登录计划任务。不会接管日常 Chrome/Ego 或本机微信账号。服务器模式不安装 Chromium。

### 下游 Wrapper 语法变更

这是候选工具的破坏性 CLI 变更，不改写已发布 v0.4.2。现有 Explorer 的 `onboard.sh` 和 `onboard.ps1` 在调用 Provider `runtime` 前没有部署模式参数，需要下游 installer 同步更新，不能原样配套发布。

仅在用户已选 independent 且批准私有运行时/依赖准备后，下游替换为：

```sh
NODE=$(sh "$SOURCE/onboard.sh" runtime --deployment-mode independent --allow-bootstrap)
```

```powershell
$node = (& (Join-Path $source 'onboard.ps1') runtime --deployment-mode independent --allow-bootstrap | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0) { throw 'Provider runtime preparation failed' }
```

运行时已备齐时可以省略 `--allow-bootstrap`，但不能省略 `--deployment-mode independent`。新增语法只适用于本候选，旧 tag 不识别该参数，须固定匹配的版本合同。Explorer 的 online/shared 分支必须在 Provider clone/runtime 调用前退出，不安装 Provider；预检也不能为了找 Node 调用带 bootstrap 的 runtime。`node scripts/onboard.mjs` 不执行 bootstrap，依赖准备必须经过上述原生 wrapper。此任务不修改 Explorer 文件；跨仓库集成仍待其 installer 负责人完成。

配置写入 `.onboarding/`，权限私有，必须在 Git 和备份分享中排除。初始化会检查已有配置、端口、Compose 项目、镜像摘要和 Playwright 协议版本。即使容器已删除，同项目标签的遗留卷或将使用的同名数据卷也会阻止新安装；卷查询失败同样停止，不自动接管或删除数据。保留原安装配置并使用 `resume`，或经审查选择独立项目名。检测到旧安装时停止，不生成新密钥覆盖它。维护源码目录及依赖必须保持固定，不能移走正在使用的助手脚本。

`install` 开始启动时使用固定镜像摘要、独立数据卷、loopback 管理端口，不使用 host 网络。安装中断后执行 `resume`；不要删除配置重新 init。

## 桌面扫码与知识库授权

1. 工具报告管理页地址后，Agent 用私有配置中的管理员凭证在管理页登录，但不把凭证写进对话、日志或代码。普通、服务和管理员凭证分离。
2. 点击接入账号前显示：**请使用已加入目标知识库的 IMA 账号**，附目标官方分享链接。管理页明确说明接入可能执行一次知识库问答验证；这不是普通健康轮询。
3. 添加账号会先检查扫码通路，再打开独立官方 IMA 登录窗口。人完成微信扫码和手机确认。Agent 不代替扫描、不使用快捷登录。
4. 授权尚未证实时不会写入可用账号池。已明确未加入或等待批准时显示“等待加入知识库”；网络或结构变化时显示“无法确认访问权限”。在同一官方窗口人工处理后，点“已处理，继续验证”。有效登录态不必重新扫码。
5. 只有授权通过后才保存到服务端加密账号库，首次写入即为待验证停用，classic 与 knowledge-agent 均不可调度。已声明的一次问答验证成功后，绑定身份、凭证和状态的 CAS 原子提交资格并启用；手动/迁移停用仍保留。验证失败、取消或超时保留加密登录态和停用状态，可在账号列表显式重试一次问答，无需重复扫码（凭证失效除外）。普通“启用”不能绕过待验证状态；创建会话成功也不能代替问答资格。

登录/授权阶段默认五分钟，`expiresAt` 仅代表该阶段；membership 请求另有十五秒上限。保存后关闭临时浏览器并清理 QR/内存凭证，再进入独立默认六十秒的单次 probe，不沿用旧登录截止时间。取消和 shutdown 会取消未提交的 probe，迟到 QR/结果不能恢复任务或启用账号。若资格已原子提交，再取消会返回已完成；需要暂停请显式停用。详见 [状态与期限](./ACCOUNT_ENROLLMENT.md)。

隔离阶段或提交后的池同步失败都会维持本机调度隔离。必须同时看 `commitApplied` 与 `warning`：`commitApplied=true` 且 `warning=pool_sync_failed` 表示资格已提交但本机不可调度，取消/关闭不会撤销已提交的启用状态；不能报告为“已取消并停用”。`commitApplied=false` 则表示尚未提交。两者均须核对同步故障，不自动重新提问。

上述新资格门禁适用于扫码捕获、管理 API 捕获/运行态文本导入及本地 CLI 接入，不是所有入口的统一新 proof 要求。启动 `env-seed` 保留既有兼容行为，可能在 classic 模式下无需新 proof 即可使用；不在本候选中强制迁移。

分享页明确要求登录或未返回已识别的元数据时，桌面引导器会打开独立官方窗口，等待人工扫码/确认后重新解析。登录凭证仅留在临时上下文，窗口完成或超时后关闭；不写进目标配置文件。网络故障、错误链接或无法确认的结构仍停止，不猜 ID、不把 shareId 当数字 ID。该登录回退目前通过合成测试，尚未用真实登录受限链接验收。

## Linux 服务器与维护电脑

Linux 安装同一 Docker 版本，自动选择 server 模式。没有桌面浏览器是预期状态，不承诺服务器能弹出本地窗口。

若分享页需要登录才能识别，先在桌面维护机运行：

```sh
sh onboard.sh resolve --deployment-mode independent --mode desktop --share-url '官方分享链接' --target-file .onboarding/resolved-target.json
```

Agent 通过已授权的 SSH/SCP 将这份仅含名称、分享链接、数字 ID 的文件传至服务器的私有目录，然后给 `install` 同时传 `--share-url` 和 `--target-file`。此文件不是访问授权或账号凭证，不能让账号跳过后续权限校验。不要传送浏览器配置、账号库或登录态。目标文件已经存在时核对 URL 与 ID，不覆盖；出错需审查后重新解析，不能手改一个猜测的 ID。

在有桌面的 Mac/Windows 维护电脑拉取同一 Provider tag，然后用 SSH 配置别名（主机密钥由人确认，不关闭校验）：

```sh
sh onboard.sh remote-prepare --deployment-mode independent --ssh my-server --remote-env /absolute/path/to/provider/.onboarding/provider.env
# 此命令只在私有目录保存维护所需管理员凭证，不输出值，不复制账号库。
sh onboard.sh tunnel --deployment-mode independent --ssh my-server --remote-port 3117 --local-port 13317
```

隧道保持运行，在另一个终端：

```sh
sh onboard.sh enroll --deployment-mode independent --env .onboarding/remote-admin.env --server-url http://127.0.0.1:13317 --name account-a
```

Windows 将 `sh onboard.sh` 换为 `.\onboard.ps1`。CLI 打开新的临时官方窗口，人工扫码/加入后按 Enter 继续验证，输入 cancel 取消；账号最终只保存到服务器。服务器收到账号时再次检查目标知识库权限，并以待验证停用状态保存。CLI 不自动执行真实问答，保存成功后需在管理页单独授权一次验证才能启用。运行态文本导入也保持待验证停用。私有维护凭证仍有管理权限，请妥善保管，用后可删除维护电脑上的这一份。

## 检查、修复、卸载与回退

```sh
sh onboard.sh check --deployment-mode independent
sh onboard.sh repair --deployment-mode independent --env .onboarding/provider.env
sh onboard.sh resume --deployment-mode independent
sh onboard.sh uninstall --deployment-mode independent
```

`repair` 仅补齐本工具创建的助手，不重新初始化账号和会话；给现有服务补连接配置不会自动重启 Provider，必须申请空闲维护窗口。`uninstall` 只撤销本项目的助手任务及其私有连接文件，**不删除 Provider 配置、账号或数据卷**；卸载后扫码不可用，需要重新安装助手。旧连接配置的清理也必须在维护窗口完成。

升级前保留 `deployment.json` 中镜像摘要和整个私有运行卷的加密备份；先测候选，再在空闲窗口切代码。回退使用旧镜像和**当前**数据，不能拿旧备份覆盖新账号/会话。不要执行 `down -v` 或删除运行目录。现有 Node 部署继续支持，维护工具推荐 Node 22；服务的公开 Node 支持范围未变。

## 验收用语

开发候选可运行无网络、空账号池检查；脚本只创建并删除自己的临时容器，不挂载既有数据，不访问 IMA：

```sh
node scripts/verify-onboarding-container.mjs YOUR_REVIEWED_IMAGE
node scripts/check-onboarding-helper.mjs --directory YOUR_PRIVATE_HELPER_DIRECTORY --image YOUR_REVIEWED_IMAGE
```

第二条只验证容器到桌面助手的 Playwright 连接，不创建网页或发起登录。

| 阶段 | 可以报告 | 不代表 |
|---|---|---|
| service_started | 服务与管理鉴权通过 | 可问答 |
| browser_ready | 专用浏览器通路通过 | 扫码完成 |
| waiting_for_scan | 等待人扫码 | 已登录 |
| waiting_for_membership / access_unverified | 尚未保存，需处理或重试 | 一定没有加入 |
| authorizationStatus=joined | 目标权限已核验 | 真实问答通过 |
| pending / verifying | 登录态已保存，待验证或验证中，仍停用 | classic 可调度 |
| 单次 probe 成功并原子启用 | 本账号本次知识库资格通过 | 手动停用已解除或全平台验收通过 |
| 真实一问一追问 | 本次已验证流式、来源及会话连续性 | 长期生产稳定性 |

目前合成测试不接 IMA。Windows 真机、远程 Linux、新账号扫码、登录态续期及真实 QA 均须单独验收；参见 [候选验收记录](ONBOARDING_ACCEPTANCE.md)。

[Playwright 版本匹配要求](https://playwright.dev/docs/api/class-browsertype#browser-type-connect) · [Docker Desktop 宿主机连接](https://docs.docker.com/desktop/features/networking/)
