# dsh-plugin-usage-dashboard

在 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 底部状态栏显示 DeepSeek 用量与估算花费：按会话聚合 token 成本、余额预算告警。

Estimated token cost & usage dashboard for DSH: per-session token/cost aggregation with a low-balance budget alert, right in the bottom status bar.

![screenshot](docs/balance.png)

## Features

- 状态栏 chip：`DS ¥12.34 · 估算花费`，余额低于阈值时变橙色 `⚠ 余额偏低`
- 悬停查看明细：总花费 / 会话数 / token 数 + 按会话 Top 8 的成本排行
- 每 30 秒自动刷新，点击立即刷新
- 数据完全来自 dsh 自己的投影缓存（`tokenUsage` / `sessionStats`），**零核心改动、零运行时依赖**
- 余额告警复用 `DEEPSEEK_API_KEY` 凭据（与余额插件同一条链路），无需再配置
- 中英文自动跟随 DSH 界面语言

## Install

> 需要 DSH 0.1.0-rc.x（Web profile）。

### 1. 安装到 profile

```bash
cd ~/.dsh/profiles/web
npm install dsh-plugin-usage-dashboard
# 本地开发：npm install /path/to/dsh-plugin-usage-dashboard
```

### 2. 加入 composition

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: usage-dashboard
      name: dsh-plugin-usage-dashboard
```

### 3. 重启 dsh

```bash
dsh --profile web
```

## Configuration

无配置项。Key 复用 `DEEPSEEK_API_KEY`（Models 设置页或环境变量）。

**成本为估算值**：按 DeepSeek 公开定价（CNY/1M tokens）折算——缓存命中输入 ¥0.5、未命中输入 ¥2、输出 ¥8。如需调整，编辑 `lib/index.js` 顶部的 `PRICE` 常量；余额告警阈值 `BALANCE_ALERT_THRESHOLD`（默认 10 CNY）同理。

## How it works

```
Browser client.js          dsh Host process
┌──────────────┐   GET    ┌───────────────────────────┐
│ composer.dock│ ───────► │ /dsh-usage                │
│  chip        │ ◄─────── │   ├─ sessionQuery         │
└──────────────┘  JSON    │   │   .listSessions()     │
                          │   ├─ sessionProjections   │
                          │   │   .snapshot()          │
                          │   │   (tokenUsage,         │
                          │   │    sessionStats,       │
                          │   │    title)              │
                          │   ├─ credentials.resolve() │
                          │   └─ fetch /user/balance   │
                          └───────────────────────────┘
```

## Development

```bash
lib/index.js    # Host half：聚合用量 + 余额告警，注册 /dsh-usage 路由
lib/client.js   # Client half：状态栏 chip（__ModuleLoader__ bundle）
```

## License

[MIT](LICENSE)
