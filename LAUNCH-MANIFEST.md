# 启动清单（deploy/pages/relay.json）· 设计说明

> 本文件故意放在仓库根目录，**不进静态目录**（`deploy/pages/` 会被原样上传到公网）——
> 那等于把「清单是干什么用的」公开印刷出去。根目录只进 git，不会被任何主机服务。

## 它是什么

deploy/pages/relay.json 是 App 的**启动前远程清单**：App 在第一次组合 UI 之前读它，
决定这次「正常启动」还是「直接退出」。它同时是 App 在**完全无法启动、
用户又不方便连电脑**时的唯一外部救援通道。

**线上地址**：https://pk-node.pages.dev/relay.json  （Cloudflare Pages）

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

## 部署方式（用户要求：用 Cloudflare，不用 GitHub Pages）

用户原话（2026-10-04）：

> 「还是用 cloudflare 部署吧，github 有时候过内访问不了」

说得对：`sxd91.github.io` 在国内时通时不通，而这份清单**只在「打不开 App」时
才被需要** —— 它在最需要的时候恰恰不能掉链子。所以改用 `pages.dev`。

### 为什么搭在现有的 `pk-node` Pages 项目里

同账号下已有 `pk-node.pages.dev`（里面有一条代理 function：`/*` 转发到 Worker，
就是为绕开国内对 `workers.dev` 的阻断而加的）。
把清单放进**同一个项目**，好处：

- 不新建项目（少一个可被关联的点）；
- 同样是改一个静态文件，无需构建；
- `pages.dev` 国内可达性已验证。

### 与代理 function 的隔离（重要）

`deploy/pages/_routes.json` 里把本文件**排除**在 function 之外：

```json
{ "version": 1, "include": ["/*"], "exclude": ["/relay.json"] }
```

否则它会被 function 转发到 Worker（那样就变成「一个能返回指令的端点」了，
而且多一跳）。部署后实测两条都正常：

- `https://pk-node.pages.dev/relay.json` → 200，直出 JSON
- `https://pk-node.pages.dev/`            → 200，仍是管理后台

### 怎么改（维护就是跑这一条命令）

```sh
export CLOUDFLARE_API_TOKEN=<令牌>
export CLOUDFLARE_ACCOUNT_ID=13182625f8c268f652dca7e33d52ed52
cd deploy/pages && wrangler pages deploy . --project-name=pk-node --branch=main
```

**不新增任何 workflow**（所以 CI 日志里看不出异常）；
本文不写令牌本身（令牌只在本地环境变量里）。

> 注意：Pages 的每次部署都是「整个目录的快照」——
> 所以 `functions/[[path]].js` 必须**一起上传**，否则会把代理 function 冲掉。
> 用上面那条命令（cwd = `deploy/pages`）就是完整包，不会丢。

### 想换成 GitHub Pages 也行

早期版本曾搭在 GitHub Pages（`docs/relay.json`，那份还在，内容相同）。
App 侧换地址**只改一行** `LaunchManifest.MANIFEST_URL`。

## 代码位置（App 仓库，私有）

| 文件 | 作用 |
|---|---|
| core/launch/LaunchManifest.kt | 读清单 + 判定 + 闸门 |
| MainActivity.kt | 启动前过闸（早于 enableEdgeToEdge） |
| 本文件 | 你正在看的说明 |

## 维护提醒

- 改 relay.json 就是改「开关」，改完推 main 即可，不用发版；
- App 读的是部署后的**公网 URL**（当前：https://pk-node.pages.dev/relay.json），不是 raw 文件；
- 若长时间不用，把 relay 字段删掉即可 —— 字段缺省 = 正常运行。
