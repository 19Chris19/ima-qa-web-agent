# 升级

`ima-qa update --version agent-vX.Y.Z`（或使用已记录的 node + CLI 绝对路径）从本项目固定 GitHub Release 下载客户端和 SHA256SUMS，校验后安装。主入口名字不变，references 随整个版本更新。必须使用真实已发布标签，不猜测最新版本。

开发 checkout 可 npm ci 后再次 setup，更新同一个托管安装。修改过的 Skill/客户端不会被覆盖；先保留并合并用户修改。Skill 内部模块不是独立 Skill，不另行注册。

安装失败尝试恢复之前的 Skill 和 MCP 配置；报告 rollback_failed 时人工核验状态。旧版本目录保留，可从旧目录入口运行 setup 恢复。卸载使用 uninstall --agent codex，只移除匹配的 Skill 和 MCP 注册；保留 Provider、凭据、问答归档和版本目录。
