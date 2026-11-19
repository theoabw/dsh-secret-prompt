# @theoabw/dsh-secret-prompt

[![npm](https://img.shields.io/npm/v/@theoabw/dsh-secret-prompt?label=npm)](https://www.npmjs.com/package/@theoabw/dsh-secret-prompt)

[English](https://github.com/theoabw/dsh-secret-prompt/blob/main/README.md) | 中文

本文件是英文文档的翻译。若两者不一致，以英文版为准；`SECURITY.md` 与 `docs/` 中的安全说明只提供英文，以免翻译滞后带来错误陈述。

一个 dsh web 插件，提供 `prompt_secret` 工具：Agent 向用户索要一个密钥（密码、
API token、私钥等），用户把它输入到 **GUI 的掩码输入框**里。值不会到达 Agent：

- 模型看到的工具结果只有 `{ handle, env: "DSH_SECRET_<handle>", prompt }`。
- 值只存在于宿主进程内存（不落盘、不写日志、不进会话事件、不进轨迹），按发起
  请求的会话隔离，并在**空闲**时间（默认 60 分钟）后过期：只要某个命令拿到了这个
  变量，计时窗口就重新开始，因此比窗口更长的任务会在中途保住凭据，而不是丢掉它。
- Agent 在 bash 命令里引用 `$DSH_SECRET_<handle>`；harness 通过受管的 `DSH_*`
  环境变量注册表把真正的值注入命令环境，与 `DSH_SESSION_ID` 是同一条通道。
- `tools/post-execute` 监听器会把模型可见的每条工具结果里出现的活动密钥值改写，
  并清洗为截断输出写出的 bash 溢出文件。
- `revoke_secret <handle>` 可以提前忘记一个密钥（幂等）。

## 空闲窗口，以及为什么它不是生命周期

计时器原本只在收集密钥时设置一次、之后不再变动，于是比 `ttlMinutes` 更长的任务会在中途
失去凭据，所有者不得不再次提供。现在，每当值被交给所属会话的某个命令时窗口就重新
开始，因此 `ttlMinutes` 是密钥在**不被使用**的情况下能活多久。

这个信号比“命令读取了变量”更粗：环境变量贡献者对会话的每条命令都会被调用，所以
一条没有提到该变量的命令同样会刷新窗口。这是刻意的。按命令文本去匹配变量名，会在
一段恰好没有提到它的长时间工作中让凭据过期，而这正是本次改动要消除的失败。

`ttlRefreshOnUse: false` 恢复从收集时刻起算的固定生命周期，适合偏好硬上限的部署。
此时的内存边界是“没有超过 `ttlMinutes` 的密钥”；开启刷新时则是“没有空闲超过
`ttlMinutes` 的密钥”，后者才符合密钥实际被需要的时间。服务重启仍然会立刻忘记
一切，因为没有任何东西落盘。

## 安全模型

受保护的内容：

- 值不会出现在 Agent 的上下文、对话、会话 JSONL，或任何 logger 里。
- GUI 输入是掩码的（`<input type="password">`），并带有显示/隐藏开关，让用户能
  核对自己输入的内容。
- 工具输出会被脱敏（`[redacted]`），作为意外泄漏的安全网，包括溢出文件。

刻意的限制（原因）：一个被允许在任意命令中**使用**密钥的模型总能把它外带（例如
`echo $DSH_SECRET_x | base64`）；值必须经过命令的进程空间才可用。脱敏拦截的是
直接和意外的泄漏；刻意外带会在轨迹里表现为被脱敏的输出，属于用户可见的策略违规。
短于 `minRedactLength`（默认 4）的值刻意**不**脱敏，这样一个病态地短的密钥
（比如单独一个横线）不会毁掉每条工具结果的可读性；真实的 token、密码和 PIN 至少
4 个字符，仍然会被完整脱敏。达到或超过下限的值总是被脱敏，所以像 "card" 这样的
4 字符密钥会把输出里每一处 "card" 抹掉，宁可多脱敏，也不会漏掉真正的密钥。

密钥从不落盘，因此 dsh 重启会立刻忘记一切。

## 工作原理

宿主侧（`src/index.ts`）：

- `prompt_secret` 调用 `ctx.userQuestions.ask()`，每个密钥字段一个问题，`header`
  都设为标记 `dsh-secret`。web provider 把问题以 JSON 转发，所以标记搭在 schema
  化的 `header` 字段上：浏览器的线上 schema 会剥掉未知字段（zod 严格对象），
  自定义的 `input` 字段会静默消失。标记约定正是为此存在。多字段调用按字段发一个
  问题，并把对话框标题以冒号形式放在第一个问题的 header 里
  （`dsh-secret: <title>`）；整批必须一起回答，因此多个凭据在一次对话框中收集。
- 答案按字段以 `{ id, selected: [], custom: "<value>" }` 到达，存入内存中的
  `SecretStore`，使用随机的 80 位 handle；每个 handle 有一个
  `ctx.shellEnv.register(...)` 贡献者，只对所属会话的 shell 执行暴露为
  `DSH_SECRET_<handle>`。所有答案都在任何一条写入存储之前完成校验，因此半填的
  批次不会留下部分密钥。
- `revoke_secret` 删除存储条目、释放它的环境变量贡献者，并取消它的 TTL 计时器。
- `tools/post-execute` 监听器（以 `prepend: true` 注册，沿用 `dsh-spill-policy`
  的模式）会替换结果内容、block 反馈和值替换载荷里的密钥出现，并清洗结果中或
  "full output: <path>" 提示里点名的溢出文件。
- 一个 `tool:secret-prompt` 系统提示区段把每个 Agent 引向该工具（“用
  prompt_secret 收集凭据，永远不要让用户把密钥打进聊天”），让后续会话无需文档
  也能发现它。

浏览器侧（`src/client`）：

- 以 `priority: -20` 注册一个 `conversation.composer` 链条目，因此它先于通用的
  问题 composer（默认优先级 0）被尝试。链把 Session 的 `pendingInteraction` 交给
  每个条目，并保留第一个 `select` 返回非 null 的条目，所以
  `selectSecretQuestion` 只在卡片中的**每一条**问题都带 `dsh-secret` header
  时认领这张问题卡片。其他情况返回 `null`，由通用 composer 处理。
- 渲染一张每个问题一个输入框的卡片，除非所有者揭示，否则输入是掩码的
  （`type="password"`）。揭示控件是带标签的按钮（`Show` / `Hide`、眼睛图标、
  `aria-pressed`），而不是无标签图标：值默认隐藏，显示是一次有意的点击。共享
  凭据逐字段掩码，卡片从不把值作为文本渲染，除非它已被揭示。
- 通过卡片自己的通道回答（`card.answer({ answers })`、`card.dismiss()`），因此
  宿主的 `ask()` 落定方式与通用 composer 回答时完全一致。卡片是鸭子类型的
  （`kind`、`questions`、`answer`、`dismiss`），因为插件 bundle 不能依赖动态
  client 包（模块表只预置平台行）；只读的 review 卡片永远不被认领：它重放一个
  已落定调用的答案，而那些答案不能被重新提交。

## 目录结构

- `src/index.ts`：宿主插件：工具、密钥存储、环境变量注入、脱敏。
- `src/client/`：浏览器插件：composer 条目、掩码输入卡片、文案。
- `scripts/smoke-test.mjs`：宿主侧测试：把构建出的 `lib/index.js` 加载到 mock
  上下文上，驱动完整的密钥生命周期（存储、按会话注入、内容/反馈/值载荷/溢出文件
  的脱敏、容量、空闲窗口）。
- `scripts/client-test.mjs`：浏览器侧测试：通过桩模块加载器加载构建出的
  `lib/client.js`，断言路由选择器的决定和卡片的标记（默认掩码、带标签的揭示控件、
  转义后的文案）。
- `scripts/deploy.sh`：构建、安装到 web profile、写入 loader 条目、重启
  `dsh.service`（当 dsh bash 沙箱内无法访问 `systemctl --user` 时回退到用户
  systemd 的 D-Bus API）。

## 安装

```sh
dsh plugin --profile web add @theoabw/dsh-secret-prompt
```

然后把 loader 行加入你的 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: secret-prompt
      name: '@theoabw/dsh-secret-prompt'
```

本插件有宿主侧和一个浏览器 bundle，因此需要重启来挂载该行，两半才会出现。重启会
结束当前活动中的会话，请在可以接受时进行。

### 从源码安装

```sh
git clone https://github.com/theoabw/dsh-secret-prompt
cd dsh-secret-prompt
pnpm install
bash scripts/link-deps.sh   # 把运行中的 dsh 的 @deepseek-ai 包链接进来
bash scripts/deploy.sh      # 构建、作为 file: 依赖安装、写入 loader 行、重启
```

`scripts/deploy.sh` 默认针对 `web` profile；对其他 profile，设置 `DSH_PROFILE`，
以及 `DSH_HOME`（如果 harness home 不是 `~/.dsh`）。`lib/` 是构建产物，不提交：
`pnpm run build` 生成它，`pnpm test` 需要它已存在。

## 配置

所有选项都在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `secret-prompt` loader
条目里：

```yaml
- insert:
    - id: secret-prompt
      name: '@theoabw/dsh-secret-prompt'
      config:
        ttlMinutes: 60            # 密钥被忘记前的空闲分钟数（默认 60）
        ttlRefreshOnUse: true     # 使用密钥会重新开始该窗口（默认 true）
        maxSecretsPerSession: 20  # 每会话同时存在的密钥上限（默认 20）
        minRedactLength: 4        # 会被脱敏的最短值（默认 4）
```

## 升级 dsh

升级 dsh 时有三处约定可能漂移，第一处已经漂移过：

- `conversation.composer` 链的交互对象。到 dsh 0.2.1 为止，条目的 `select` 收到
  `{ interactions }`，匹配到的值是一个带 `payload.questions` 和
  `respond(decision)` 包装的临时载体。0.2.2 起，所有者 props 是
  `{ sessionId, session, pendingInteraction }`，交互对象就是问题卡片本身
  （`questions`、`answer()`、`dismiss()`、`review`），崩溃的选择器会被当作拒绝
  吞掉，所以过期的插件会静默回退到不带掩码的通用问题卡片，而不是大声失败。
  `src/client/index.ts` 按已安装的 `ComposerChainProps` 为选择器定型，
  `scripts/client-test.mjs` 把这些决定固定下来。
- 浏览器里问题的线上 schema（`askUserQuestionItemSchema`）：如果它将来长出可以
  替代 `header` 标记约定的字段，优先使用它。
- `tools/post-execute` 的决定形状，以及 `@deepseek-ai/dsh-tools` 的导出
  （`JsonValue` 在 0.2.2 移到了 `@deepseek-ai/dsh-util-values`）。
  `pnpm run typecheck` 能同时发现两者。

`@deepseek-ai/dsh-client-ui-primitives` 被编译进 web shell，没有 npm 副本，因此
它的接口在 `src/client/css-modules.d.ts` 里以 ambient 方式声明；图标名在版本之间
会变动（0.2.2 删掉了 `Icon*16` 系列），这就是这张卡片自己绘制图形的原因。

## 测试

```sh
pnpm run typecheck
pnpm run test          # client-test + smoke-test，都针对 lib/
```

## 另见

[dsh-secrets](https://github.com/theoabw/dsh-secrets) 是同一作者的 broker 一半：
它不收集单个临时凭据，而是按会话授予对某个 provider（密码库 CLI，或进程内
Bitwarden 登录）的、有范围有期限的访问，并把值放进命令环境变量，且永不回到模型。
