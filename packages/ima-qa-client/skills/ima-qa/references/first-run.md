# 首次使用：从安装到扫码和取材

Skill 是操作流程，MCP 是工具桥，Provider 才保存 IMA 登录态并执行问答。单独复制 SKILL.md 不会获得账号或自动登录。先识别用户要哪种接入：

| 情况 | 执行路径 |
| --- | --- |
| 已有本机 Provider / 迁移运行数据 | 复用服务和数据，读 setup.md；不重新安装账号池，不要求再次扫码 |
| 使用维护者提供的远程 Provider | 维护者提供受保护地址与同应用的两类凭据；只装客户端，普通用户不管理远端账号 |
| 新电脑、自己的 IMA 账号、没有 Provider | 按下面部署自己的 Provider，然后由人扫码 |
| 已有服务但凭据失效或账号过期 | 读 troubleshooting.md，走既有后台维护；不新建第二套服务掩盖故障 |

## 新电脑的可执行流程

需要用户提供目标知识库的**官方分享链接**和已获权限的 IMA 账号。不要让用户找数字 ID、Cookie 或在聊天粘贴密钥。知识库固定在 Provider profile；提问时无需手工输入 @库名。

1. 查官方仓库 `https://github.com/19Chris19/ima-qa-web-agent/releases`，选择已发布稳定 Provider tag，读取该 tag 的 `docs/AGENT_DEPLOYMENT.md`。本客户端按 Provider v0.6.0 合同验证；不要用浮动 main 或不同版本的助手/镜像。若本机没有 checkout，下载/检出所选固定 tag 到专用目录；不执行下载来的任意远程 shell 管道。
2. 先只读检查已有安装、Docker/Compose、端口与平台。在所选 checkout 运行 `sh onboard.sh doctor`；Windows 用 `onboard.ps1`。缺系统工具时解释安装内容并等待授权；不绕过系统提示。
3. 用户已授权新安装且确认没有旧数据时，运行 `sh onboard.sh install --share-url '用户提供的官方分享链接' --project my-ima-qa --port 3117`。它固定镜像摘要、创建私有配置和专用维护浏览器。中断用 `resume`，不删除配置重新安装。Linux 无桌面时用匹配版本维护电脑和已授权 SSH 通路；不能声称服务器会弹本地窗口。
4. 打开引导器给出的本机管理页，用私有配置完成管理员登录；管理员凭证仅用于维护，不进入 MCP。点击“接入账号”前说明目标知识库，以及接入后的单次资格问答。人完成官方窗口中的微信扫码、手机确认及必要的加入；不能使用维护电脑微信快捷登录代替目标账号。需要人工操作时暂停等待。
5. 只在权限核验后保存加密登录态。`pending` / `verifying` 仍不可调度；真实资格问答须在本次授权范围内执行，成功原子提交后才可用。失败保留登录态，按后台显式重试，不要求无故重扫。扫码、权限通过、服务健康均不等于真实问答通过。
6. 配置客户端（下面路径仅为示例），不要展示私有文件：

   ```sh
   node /absolute/client/bin/ima-qa.mjs connect-local \
     --provider-env /absolute/provider/.onboarding/provider.env \
     --base-url http://127.0.0.1:3117 \
     --config /absolute/private/client.json
   node /absolute/client/bin/ima-qa.mjs setup --agent codex --config /absolute/private/client.json
   ```

   导入只读取本机部署文件，只复制普通/服务凭据并计算范围哈希，既不启动 Provider，也不保存管理员凭据、账号 Cookie 或账号库。旧单凭据安装标为 `legacy`，独立调用方应由维护者另配命名应用。多应用必须指定 `--application-id`，不能随意混搭凭据。
7. `doctor` / `ima_qa_status` 通过后，用户已要求问答时执行一问一追问，并将终态完整结果归档。报告“已安装”“已扫码”“资格通过”“真实问答通过”各自事实，未测试部分明确列出。

## 已经只安装了 Skill、没有客户端

从维护者指定的固定 `agent-vX.Y.Z` Release 下载客户端和 SHA256SUMS，核对摘要后解包；在 package 目录 `npm ci --ignore-scripts`。开发候选只能使用用户指定的 checkout，并说明尚未发布。客户端要求 Node 22+，不依赖全局 npm 发布包。之后使用上述连接和 setup 命令，唯一 Skill 随客户端更新。

macOS 首次扫码、Windows 真机和 Linux 远程维护是不同验收场景；不要拿已有账号的一次成功问答当作所有平台首次安装已经验收。
