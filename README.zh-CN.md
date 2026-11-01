# Omni-Code-Judge

> **Omni-Code-Judge：在 AI 时代，代码不仅要能跑，还要经得起资深架构师的审视。**

AI 驱动的代码架构与安全评级器。纯 TypeScript + Node.js，零原生 C++ 模块（Win7 / 8G 内存可跑）。对任意文件、目录或 Git Diff 从**五个维度**打分——复杂度、安全性、可维护性、测试覆盖率、设计模式——并生成一份带纯 CSS 雷达图的硬核架构审查战报。

## 工作原理

```
源码 / Diff ──▶ judge_core（AST 静态分析，@babel/parser）
                  │  复杂度 · 安全性 · 可维护性 · 覆盖 · 模式
                  ▼
              judge_ai（经 aether-llm 调用云端 LLM 架构师，离线兜底）
                  ▼
              judge_report（Markdown 战报 + 纯 CSS 雷达图）
                  ▼
              judge_cli（彩色终端裁决，CI 就绪退出码）
```

- **judge_core** —— 确定性 AST 分析。不依赖大模型、不联网：圈复杂度、循环嵌套层数、注入红线（`eval`、`innerHTML`、硬编码凭据、命令拼接）、函数长度 / 命名规范 / 注释率 / `any` 泛滥、同级测试发现 + 断言密度 + 函数纯度，以及 GoF 模式 / 反模式识别（上帝类、全局可变状态、导入爆炸……）。
- **judge_ai** —— 把代码与静态信号喂给云端 LLM，走 `aether-llm` 网关（OpenAI 兼容、限流、退避重试）。Prompt 设定首席架构师，要求输出强类型 JSON。没有 API Key？离线启发式架构师自动接管，功能完整不报错。
- **judge_report** —— Markdown「战报」：五维评级表、红黄牌警告、指标仪表盘、模式检出、AI 业务隐患清单，外加一张**纯 CSS 雷达图**（无 SVG、无 JS、无图片）。
- **judge_cli** —— `node bin/judge.js <target>` 彩色裁决；`--output` 落盘战报；`--json` 机器可读；**任一红牌触发退出码 1**，可直接卡 CI。

## 快速开始

```bash
npm install
npm run build

# 审查单个文件
node bin/judge.js examples/bad-code.ts --no-ai

# 审查整个目录（纯静态）
node bin/judge.js src --no-ai

# 开启 AI 架构师（需 AETHER_INKSTONE_API_KEY 或 OPENAI_API_KEY；
# 没有密钥时自动降级为离线启发式架构师）
node bin/judge.js examples/bad-code.ts --ai

# 生成 Markdown 战报
node bin/judge.js examples/good-code.ts --no-ai --output reports/good.md

# 机器可读结果
node bin/judge.js src --no-ai --json

# 跑测试套件（13 个测试，零额外依赖）
npm test
```

## 命令行参考

```
node bin/judge.js <target> [options]

target            文件、目录、git diff、"- "（stdin）或内联代码

  --ai            启用 LLM 架构师（有密钥时默认）
  --no-ai         仅静态分析
  --diff          把输入当作 unified diff
  --model <name>  覆盖路由模型
  --context <txt> 喂给 AI 架构师的业务上下文
  --output <path> 战报落盘路径
  --json          输出 JSON
  --no-color      关闭 ANSI 彩色
  --cwd <path>    同级测试发现的工作目录
```

## 五个维度

| 维度 | 权重 | 衡量什么 |
| --- | --- | --- |
| 复杂度 Complexity | 25% | 圈复杂度、循环/分支嵌套深度、函数长度、参数个数 |
| 安全性 Security | 30% | eval 家族、`innerHTML`/`document.write`、硬编码凭据、命令拼接、弱摘要、SQL 拼接 |
| 可维护性 Maintainability | 20% | 函数长度、命名规范、注释率、`any` 泛滥、TODO 积压、死导出 |
| 测试覆盖 Test coverage | 15% | 同级测试文件、断言密度、函数纯度、导出率（无需插桩） |
| 设计模式 Design patterns | 10% | 单例 / 依赖注入 / 观察者 / 工厂 / 策略识别；上帝类、全局可变状态、导入爆炸 |

总分 = 加权汇总；开启 live LLM 时与 AI 分按 70/30 融合。评级：**S ≥ 95 · A ≥ 85 · B ≥ 70 · C ≥ 60 · D ≥ 40 · F < 40**。

## 出牌规则

- **红牌 🔴（critical）** —— `eval`、`new Function`、`innerHTML` 赋值、硬编码凭据、拼接 shell 命令。任一红牌把安全性封顶 45，CLI 退出码 1。
- **黄牌 🟠（major）** —— 弱摘要、`document.write`、SQL 拼接、上帝类、缺测试、决策点爆炸。
- **🟡 minor / 🔵 info** —— TODO 标记、JS 里的 snake_case、`any` 满天飞、超长文件。

## 项目结构

```
omni-code-judge/
├── bin/judge.js            # CLI 入口（dist 缺失时自动编译）
├── src/
│   ├── core/               # judge_core：parser、complexity、security、
│   │                       #   maintainability、coverage、design、编排器
│   ├── ai/                 # judge_ai：aether 网关、架构师 prompt、judge
│   ├── report/             # judge_report：markdown + 纯 CSS 雷达
│   ├── cli/                # judge_cli：参数、着色、输出
│   ├── judge.ts            # 顶层编排（静态 × AI 融合）
│   └── types.ts            # 共享类型契约
├── tests/smoke.test.ts     # 13 个 node:test 测试
├── examples/               # bad-code.ts（F 级 6 红牌）& good-code.ts（B+）
└── reports/                # 生成的战报落 here
```

## AI 网关

LLM 层复用 aether-llm —— 零依赖 OpenAI 兼容客户端，滑动窗口限流、429/5xx 指数退避、快/强两档模型路由。

```bash
# InkStone 舰队（默认）：fast=atriadawn，strong=deepseek-v4.1
export AETHER_INKSTONE_API_KEY=sk-...

# 或直接 OpenAI 密钥
export OPENAI_API_KEY=sk-...

# 或指向任意 OpenAI 兼容端点
export AETHER_LLM_BASE_URL=https://your-host/v1
```

没有密钥 → **离线启发式架构师**从静态信号推导 AI 分，断网机器也能出完整战报。

## 遵守的环境红线

- 纯 TypeScript + Node.js —— 无原生 C++ 模块，Win7 / 8G 内存主机可运行。
- 运行时依赖仅 `@babel/parser` 一个，外加可选的 `aether-llm` 网关。
- 测试用内置的 `node:test`，不引入额外框架。

## 协议

MIT —— 见 [LICENSE](LICENSE)。English: [README.md](README.md).
