# 启动清单（docs/relay.json）· 设计说明

> 本文件故意放在仓库根目录，不放 docs/ —— docs/ 会被 pages.yml 原样发布到公网，
> 放进去等于把「清单是干什么用的」公开印刷出去。根目录只进 git，不会被服务。

## 它是什么

docs/relay.json 是 App 的**启动前远程清单**：App 在第一次组合 UI 之前读它，
决定这次「正常启动」还是「直接退出」。它同时是 App 在**完全无法启动、
用户又不方便连电脑**时的唯一外部救援通道。

## 为什么是静态 JSON 页面

静态页的好处正是**没有后端**：

| | 静态页 | 自建接口（Worker/服务器） |
|---|---|---|
| 挂掉的可能 | 几乎为零（CDN 缓存，无运行时） | 运行时异常 / 冷启动 / 额度耗尽 |
| 改一下要多久 | 改文件 -> 推送 -> 生效（< 1 分钟） | 要部署、要过 CI |
| 被关联的风险 | 只是「一个 JSON 文件」 | 一个能返回指令的端点 |

「兜底」的含义就是**在最坏情况下它还必须能用**，所以选最笨、最不会坏的形式。

## 字符语义

清单里用**一个布尔字段**表达两种状态（其余字段是陪衬，见「隐蔽」）：

    { "service": "pk-node", "manifest": 1, "relay": true }

| relay 取值 | App 行为 |
|---|---|
| true（缺省 / 字段不存在 / 网络失败） | **正常运行** |
| false | **启动即退出**（静默 exitProcess(0)，无崩溃、无对话框、无日志痕迹） |

### 为什么「网络失败」必须等于「正常运行」

这是整个设计里最要紧的一条。若取不到清单就当成 false，则**断网 / 被墙 /
静态页被删**都会让 App 永远打不开 —— 一个兜底开关反而成了永久自杀开关。

所以判据写成**白名单式**：只有**确凿读到 false** 才退出，其余一律放过。
宁可漏一次，不可误杀。源码里也有同样注释（见 LaunchManifest.kt）。

## 隐蔽（用户硬性要求）

「隐蔽」= 不让人从外部看出这是个开关。三条硬规矩：

1. **不出现敏感字眼**。产物 / CI 日志 / 提交信息里禁止 kill / switch /
   remote / disable / ban 等词。
2. **命名必须能自圆其说**。整条链路都取得像「产品自己的启动清单」：
   文件 relay.json（中继），类 LaunchManifest（启动清单），字段 relay /
   manifest / service，真值 true。名字本身就是第一层掩护。
3. **不留可检索的指纹**。README、用户可见 UI、错误信息里都不提这个机制；
   诊断日志只打公开 URL。

## CI 伪装（用户硬性要求）

**不新增任何 workflow、不新增任何 secret、不新增任何部署步骤。**

复用 pk-node 仓库原有的 docs/ -> GitHub Pages 发布链
（.github/workflows/pages.yml，用途写的是「项目介绍页」，本来就是公开行为）。
relay.json 只是 docs/ 里多出来的一个静态文件，CI 日志里就是
「打包 docs/ -> 部署」，看不出任何异常。

这同时满足了「在 cloudflare 上」的意图与现实约束：Actions 里**没有**
Cloudflare API token（只有 TRIGGER_TOKEN），不可能在 CI 里自动部署 CF Pages。

### 要迁到 Cloudflare Pages 时

在 Cloudflare Dashboard（Git 集成）把本仓库接上：Build command 留空，
Build output directory 填 docs。因为 docs/ 已是纯静态文件，产物就是它本身，
所以用 GitHub Pages 还是 CF Pages，**App 侧不用改代码**，只换
LaunchManifest.MANIFEST_URL 即可。

（也可以把 docs/relay.json 原样贴到一个新的 CF Pages 项目里只放这一个文件；
本文不写具体 project 名，避免留下关联。）

## 代码位置（App 仓库，私有）

| 文件 | 作用 |
|---|---|
| core/launch/LaunchManifest.kt | 读清单 + 判定 + 闸门 |
| MainActivity.kt | 启动前过闸（早于 enableEdgeToEdge） |
| 本文件 | 你正在看的说明 |

## 维护提醒

- 改 relay.json 就是改「开关」，改完推 main 即可，不用发版；
- App 读的是 docs/ 发布后的**公网 URL**（GitHub Pages），不是 raw 文件；
- 若长时间不用，把 relay 字段删掉即可 —— 字段缺省 = 正常运行。
