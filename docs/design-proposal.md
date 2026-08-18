# pi-data-masking 修改方案:来源追踪 + 结构保持占位符

> 状态:**已实现**(2025-08,对应本次修改;`git diff` 可查看全部改动)
> 目标版本:v0.3.0
> 来源:2025-08 设计讨论的整理结论。本文档为代码修改方案,讨论过程中的推理链见附录 A。
>
> 落地时的两处决策(原开放问题):**O1** 字面量规则统一适用首见定终身(已实现);**O3** `systemPromptGuidance` 默认关闭(已实现)。

---

## 1. 问题清单(现状缺陷)

以下问题在 v0.2.1 的"全量 mask + 全量注册"机制下成立:

| 编号 | 问题 | 机制 | 影响 |
|---|---|---|---|
| P1 | **动态映射表污染** | context 钩子对历史中 LLM 自己的输出也做 mask,regex 自造值被注册进 `dynamicMap`(只增不减,5000 条阈值) | 内存增长;unmask 扫描模式膨胀 |
| P2 | **统计污染** | `newMessages = messages.slice(lastContextLength)` 把上一轮 LLM 自己的输出当作"新增敏感值"计数 | 面板/`/masking-history` 虚报"拦截到敏感值" |
| P3 | **巧合还原** | `unmask()` 无意图感知:assistant 输出中任何等于已知占位符的文本都被还原成真实值 | 无关文本里出现真实秘密;占位符越短概率越高 |
| P4 | **语义断裂** | 格式保持只保形状不保语义:`"比如 123456 这种弱密码不行"` 被 mask 成 `"比如 834919 这种弱密码不行"` | LLM 视图出现假命题,推理质量下降;甚至可通过"834919 不像弱密码→原值大概是 123456"反推真实值(推断泄露) |
| P5 | **结构属性断言断裂** | `"这个 token 以 gs- 开头"` 不含完整值、不命中规则,断言幸存;值本身被 mask → 断言与占位符不一致 | 高熵值同样受影响,LLM 逻辑困惑 |
| P6 | **用户侧观感** | 秘密以原样(LLM 巧合输出)或错误还原(见 P3)形式出现在回复中 | 用户误判"脱敏失效",信任受损 |

---

## 2. 设计决策(讨论结论)

### D1 首见定终身(来源追踪,方案 A)

**规则:一个值"首次出现"的位置决定它在本会话中的终身状态。**

- 首次出现在**用户消息或工具结果**中 → 注册进 `dynamicMap`,此后所有消息(含 assistant 历史)一律 mask;
- 首次出现在 **LLM 输出**中 → 会话内永不注册、永不 mask(包括用户之后发送同值)。

**为什么这是安全的且不产生困惑**:

- 占位符是确定性的(`HMAC(real, sessionKey)`),同一个真实值处处映射同一个占位符 → LLM 视图内部自洽、用户视图内部自洽、往返(用户问→脱敏→LLM 答→还原)正确;
- LLM 无跨轮"意图记忆",每轮只重读上下文 → "首见定终身"下历史表示永不改变,不存在中途表示变化;
- 缓存友好:mask 后的 prompt 是 append-only,前缀缓存不失效;
- 泄露面(用户发送与 LLM 自造同值)集中在巧合场景;配合 D3(低熵不脱敏),实际泄露概率趋近于零。

### D2 否决的备选方案

| 方案 | 否决原因 |
|---|---|
| 混合 B(值先跳过,用户发送后注册,历史保留原样) | 旧 assistant 里真实 4822 与新用户消息占位符 7123 永久并存 → LLM 无法分辨 → 逻辑困惑 + 推断泄露 |
| 注册优先 + 回溯重写历史(C) | 中途改变历史表示 → 前缀缓存全失效 + 表示不稳定 |
| mask 但不注册 | 无法在 message_end 还原 LLM 对自造值的引用 → 占位符文本残留入库 |
| 逐位置(per-occurrence)状态 | 复杂、脆弱,不抵收益 |

### D3 低熵值不脱敏(规则设计原则)

P4/P3/P6 的根源集中在低熵值;而低熵值本身可猜测,脱敏的边际安全收益≈0。

**原则:只脱敏"语义透明"的高熵值**——key、token、ID、完整域名、完整手机号这类会话只把它当"一个值"引用、不断言其属性的值。对会话可能断言属性的值(弱密码、常见示例、短码)不脱敏。

### D4 属性保持占位符

任何改变值的脱敏都会改变它的属性,能做的是**保留"最常被断言、且最不敏感"的结构属性,随机化熵主体**。连接串(保 scheme/port/path)和域名(保 TLD)已是此哲学的现有实现,推广到通用值:

- 通用 token:保留第一个分隔符之前的段(如 `gs-`),HMAC 只作用于主体;
- IPv4:可配置保留前 N 段(私网推荐 2 段),其余段 0-255 随机;
- 长度天然保持(格式保持)。

### D5 统计按消息角色

`currentRoundMaskCount` 只累加**用户消息和工具结果**的 mask 数;assistant 消息的 mask(已注册回声)不计数、LLM 自造值本就不 mask。面板与 `/masking-history` 语义恢复为"拦截到用户/工具侧敏感值"。

### D6 system prompt 引导(兜底,可选)

对无法结构保持的属性断言,通过 system prompt 告知 LLM 处理方式,降低困惑概率。与"格式保持看起来真实"的哲学有轻微冲突,故默认关闭。

---

## 3. 详细规格

### 3.1 来源追踪(`index.ts` + `masker.ts`)

**新增会话级集合** `llmInventedValues: Set<string>`(与 `dynamicMap` 同生命周期,仅 `session_start` 清空;复用 `DYNAMIC_MAP_WARN_THRESHOLD` 做膨胀警告)。

**`masker.ts` API 变更**:

```ts
// 新增选项
interface MaskOptions {
  /** true: 新发现的匹配值注册进 dynamicMap(仅用户/工具消息传 true) */
  discover?: boolean;
}

mask(text: string, opts?: MaskOptions): MaskResult;
maskValue(value: unknown, opts?: MaskOptions): { value; count; details };
```

`discover=false` 时(assistant 消息):

- 值已在 `dynamicMap` → 照常 mask(保护"回显还原后的用户秘密");
- 值未注册 → **跳过**(不 mask、不注册、不计数)。

`discover=true` 时(用户/工具消息):行为同现状(mask + 注册)。

**`index.ts` context 钩子按角色处理**:

```
for msg of newMessages:
  role = msg.role
  user / tool  → maskValue(msg, { discover: true })  → count 累加
  assistant    → maskValue(msg, { discover: false }) → 不计数;
                 扫描过程中未注册的匹配值 → 加入 llmInventedValues(按消息顺序)
```

**user 消息的"首见定终身"豁免**:user 消息命中规则,但该值已在 `llmInventedValues` → 不 mask、不注册(用户接受的巧合泄露场景,配合 D3 实际不发生)。

**tool 消息忽略 `llmInventedValues`**:工具结果始终 mask + 注册(真实数据来源,与用户方案一致)。

**其余钩子**:

- `message_end` / `tool_call`:还原逻辑不变;
- `before_provider_request`:按角色与 context 同规则,不计数;`system`/`prompt` 字段按 `discover: true` 处理;
- `before_agent_start`:不变(系统提示词 mask),若启用 D6 则追加引导段。

**生命周期**:`llmInventedValues` 仅存在于内存,不落盘;`session_compact` 不重置(与 `dynamicMap` 一致)。

### 3.2 低熵规则防护(`config-loader.ts` + 文档)

- **字面量规则**:`real` 长度 < 8 → 加载时 `warning`("low-entropy value, consider not masking; it can cause semantic contradictions and coincidental restores");
- **regex 规则**:启发式检测常见低熵形态(如 `\d{1,4}`、`[A-Za-z]{1,4}` 片段)→ 同款 warning(实现为对 pattern 的简单正则探测,不引入完整熵分析);
- 规则可显式声明 `"lowEntropy": true` 跳过警告(知情使用);
- `masking.config.example.json` 与 README 更新"规则设计标准"章节(见 §5)。

### 3.3 属性保持占位符(`placeholder-gen.ts` + 规则字段)

**规则新增可选字段**:

```jsonc
{
  "id": "prod_api_key",
  "real": "sk-prod-abc123456789",
  "preserveStructure": {
    "keepPrefix": true,        // 或 number:保留前 N 字符(到分隔符为止)
    "keepIPv4Octets": 2        // 仅 IPv4 生效;私网推荐 2
  }
}
```

**`generatePlaceholder` 签名变更**:

```ts
generatePlaceholder(real, sessionKey, attempt = 0, opts?: {
  keepPrefix?: boolean | number;
  keepIPv4Octets?: number;
})
```

实现要点:

- `keepPrefix`:截取第一个分隔符(`- _ . : / @`)之前的段作为保留前缀,`deriveKeyStream` 仅以主体为输入 → 保持确定性(同 real+key+attempt 同结果);
- `keepIPv4Octets`:复用现有 `replaceIPv4` 路径,前 N 段原样保留,其余段 0-255 独立随机;
- 连接串/域名的现有保留行为(scheme/port/TLD)不变,作为文档示例。

### 3.4 统计(`index.ts`)

- `currentRoundMaskCount` 仅累加 `discover: true`(用户/工具)消息的 count;
- assistant 消息即使发生 mask(已注册回声)也不计数;
- `before_provider_request` 拦截数保持"不进入面板"的现状(仅 notify)。

### 3.5 system prompt 引导(`index.ts` + `options`)

```jsonc
{ "options": { "systemPromptGuidance": false } }   // 默认关闭
```

启用时,`before_agent_start` 在 mask 后的 system prompt 末尾追加:

> "Some values in this conversation are masked placeholders. Treat them as opaque tokens: never infer their original values from their appearance, never transform or derive from them, and note that any text describing a value's properties (prefix, format, strength) may refer to the original value, not the placeholder."

---

## 4. 各文件改动清单

| 文件 | 改动 |
|---|---|
| `masker.ts` | `mask`/`maskValue` 增加 `{ discover }` 选项;`discover=false` 时跳过未注册值的替换;`collectMaskSpans` 支持"仅已注册"模式 |
| `index.ts` | `llmInventedValues` 集合(生命周期、膨胀警告);context 钩子按角色处理 + 计数规则;`before_provider_request` 角色感知;D6 引导段 |
| `placeholder-gen.ts` | `generatePlaceholder` 增加 `keepPrefix`/`keepIPv4Octets`;连接串/域名行为不变 |
| `config-loader.ts` | 解析 `preserveStructure`、`lowEntropy` 字段;低熵警告 |
| `masking.config.example.json` | 移除/注释低熵规则示例;新增 `preserveStructure` 示例;更新注释 |
| `README.md` | 新章节:规则设计标准、来源追踪语义、残余风险、新选项 |
| `tests/*` | 见 §5 |

---

## 5. 测试计划

**`masker.test.ts`**:

1. `discover=false` 时,未注册值原样保留、已注册值照常替换;
2. `discover=false` 时不写入 `dynamicMap`、不改变 `usedPlaceholders`;
3. 用户消息命中 `llmInventedValues` 中值 → 跳过(首见定终身);
4. 工具消息命中同一值 → 照常注册(忽略豁免)。

**`placeholder-gen.test.ts`**:

5. `keepPrefix` 确定性:同 real+key 两次生成一致;前缀段保留、主体随机;
6. `keepIPv4Octets`:前 N 段原样、其余段在 0-255 内;确定性;
7. 无 `preserveStructure` 时行为与现状完全一致(回归)。

**`config-loader.test.ts`**:

8. 低熵字面量(<8 字符)产生 warning;`lowEntropy: true` 抑制;
9. `preserveStructure` 字段解析与默认值。

**集成(可选,手测脚本)**:长会话模拟——LLM 自造值不注册不计数、用户秘密回显还原后下轮仍 mask、往返一致。

---

## 6. 残余风险(接受并文档化)

| 残余 | 说明 | 缓解 |
|---|---|---|
| 巧合还原(P3) | 已注册占位符仍可能被 LLM 输出巧合命中而错误还原;概率随占位符熵上升而下降 | D3(低熵不脱敏)+ 长占位符;无法归零 |
| 首见定终身泄露 | 用户发送与 LLM 自造同值的字符串 → 明文直发 | D3 后高熵值巧合概率≈0;文档声明 |
| 主体片段断言 | 指向值主体片段的断言("mxr 那段")仍会断裂 | 按片段敏感度二选一:保留=泄露,不保留=断裂;规则级配置 |
| 语义属性断言 | 对高熵值断言"常见/弱"等语义属性(罕见) | D6 引导;文档声明 |

---

## 7. 开放问题(已决议)

- **O1 字面量规则是否适用首见定终身**:已决议——**统一适用**。LLM 首次输出字面量 `real` 值时与 regex 值同样标记为 invented,永不 mask;用户在先则照常 mask。实现:`protectedValues` 按值统一判定,与规则类型无关。
- **O2 `llmInventedValues` 膨胀**:已实现——与 `dynamicMap` 共用 `DYNAMIC_MAP_WARN_THRESHOLD`(5000)阈值,`context` 钩子触发一次性警告;`session_compact` 不清理(与 `dynamicMap` 一致)。
- **O3 `systemPromptGuidance` 默认值**:已决议——**默认关闭**(行为兼容),`options.systemPromptGuidance: true` 显式开启。

> 实现备注:`mask(text, opts)` 的默认行为(不传 `opts`)保持向后兼容(等价 `discover: true`),assistant 消息由 `index.ts` 显式传 `{ discover: false }`。

---

## 附录 A:讨论溯源(推理链摘要)

1. **场景确认**:用户输入不匹配规则、LLM 输出匹配规则 → 下一轮 context 重发历史时,LLM 自造值被注册进动态表 → 映射表、统计、unmask 模式三处污染(P1/P2/P3)。
2. **方案对比**:来源追踪是必要第一步;"只还原用户来源的值"正确,但管不了"单次出现是否有意"(巧合还原残余)。
3. **混合方案否决**:旧历史保持真实 + 新用户消息 mask → 永久跨消息不一致(LLM 困惑 + 推断泄露);注册优先 + 回溯 → 缓存失效。均否决。
4. **关键洞察**:占位符确定性(HMAC(real, key))使"注册时机"无关紧要 → 现状代码与首见定终身在一致性/缓存上等价,分歧只在"LLM 自造值注册与否"。
5. **风险修正**:巧合概率由**秘密熵**决定而非规则;低熵常见值(123456)概率高,高熵随机值概率低于均匀假设;"LLM 能生成就不重要"在弱凭据上不成立。
6. **语义断裂(P4)**:格式保持保形状不保语义,"834919 是弱密码"假命题 + 反推泄露 → 低熵值不脱敏(D3)。
7. **结构断言断裂(P5)**:断言文本不命中规则而幸存,值与断言不一致;高熵值也受影响 → 属性保持占位符(D4) + system prompt 引导(D6)。
