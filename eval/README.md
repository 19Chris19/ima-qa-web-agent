# IMA QA Evaluation Set

This directory stores the first user-defined benchmark for the 3DGS shared knowledge base.

## Files

- `questions.jsonl`: 50 real-world questions grouped by topic and difficulty.
- `run-eval.mjs`: Batch runner that calls a running `/api/ask` service and writes JSONL + Markdown reports.

Each JSONL row has:

| Field | Meaning |
| --- | --- |
| `id` | Stable question ID used in reports. |
| `suite` | Benchmark suite name. |
| `category` | Topic group for aggregate stats. |
| `difficulty` | `basic`, `intermediate`, or `advanced`. |
| `question` | The user-facing question. |
| `expectedSourceHints` | Optional title/source keywords to fill after the first baseline run. |
| `expectedAnswerPoints` | Optional human-authored key points to fill after comparing against IMA native answers. |
| `mustNotInvent` | Optional entities, numbers, or claims the model must not fabricate. |

## Scoring

Run the same question against:

1. IMA native `@共享知识库`
2. Provider A: `ima-web-agent`
3. Provider B: `openapi-mimo`
4. Provider C: `local-rag-mimo`

Score each answer manually with 0/1/2 points:

| Metric | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Activeness | Over-refuses or misses known content | Gives clues but not a usable answer | Gives a direct useful answer |
| Correctness | Wrong or fabricated | Mostly right with gaps | Consistent with sources |
| Citation reliability | Citations do not support claims | Partially supported | Key claims are supported |
| Coverage | Misses main points | Covers part of the answer | Covers the main expected points |
| Boundary handling | Hallucinates or refuses too hard | Boundary is present but rough | Helpful and honest about gaps |

After the first baseline run, fill `expectedSourceHints`, `expectedAnswerPoints`, and `mustNotInvent` only for questions where manual review found stable expectations.

## Usage

Start the app first, then run the benchmark against that local service:

```bash
npm run eval:dry-run
npm run eval:run -- --base-url http://127.0.0.1:3117 --provider openapi-mimo
```

Useful options:

| Option | Meaning |
| --- | --- |
| `--base-url` | Running app URL, default `http://127.0.0.1:3000`. |
| `--provider` | Label written into the result, for example `openapi-mimo`, `ima-web-agent`, or `ima-native-manual`. |
| `--limit` | Run only the first N selected questions. Useful for smoke tests. |
| `--category` | Run one category, such as `training_workflow`. |
| `--difficulty` | Run one difficulty, such as `advanced`. |
| `--resume` | Resume from an existing JSONL result file and skip rows already marked `ok: true`. Uses `--from-results`, or `--out` when `--from-results` is omitted. |
| `--only-failed` | Select only question IDs that failed in a previous JSONL result file. Use with `--from-results` for clean retry output. |
| `--from-results` | Previous JSONL file used by `--resume` or `--only-failed`. |
| `--concurrency` | Parallel requests. Keep `1` for Web Agent unless explicitly testing queues. |
| `--delay-ms` | Wait after each question. Recommended for `openapi-mimo` full runs to avoid IMA OpenAPI frequency limits. |
| `--token` | Bearer token when `IMA_QA_API_TOKEN` is enabled. Defaults to env `IMA_QA_API_TOKEN`. |
| `--out` | JSONL result path. |
| `--report` | Markdown report path. |

For the first full Provider B run, prefer a conservative command:

```bash
npm run eval:run -- \
  --base-url http://127.0.0.1:3120 \
  --provider openapi-mimo-local \
  --out eval/results/provider-b.jsonl \
  --timeout-ms 180000 \
  --concurrency 1 \
  --delay-ms 5000 \
  --resume
```

If IMA OpenAPI returns `code=200005` / `请求超量，请明日再试`, the app returns `failureReason: "openapi_quota_exceeded"` and the runner stops before starting more questions. It still writes the JSONL rows completed so far and a partial Markdown report. Do not immediately rerun the full 50 questions after quota recovers.

Quota-safe retry commands:

```bash
# Retry only rows that failed in yesterday's run, writing a new result file.
npm run eval:run -- \
  --base-url http://127.0.0.1:3120 \
  --provider openapi-mimo-retry \
  --from-results eval/results/provider-b.jsonl \
  --only-failed \
  --out eval/results/provider-b-retry.jsonl \
  --timeout-ms 180000 \
  --concurrency 1 \
  --delay-ms 5000

# Run one category at a time after failed rows are cleared.
npm run eval:run -- \
  --base-url http://127.0.0.1:3120 \
  --provider openapi-mimo-rendering \
  --category rendering_application \
  --out eval/results/provider-b-rendering.jsonl \
  --timeout-ms 180000 \
  --concurrency 1 \
  --delay-ms 5000 \
  --resume

npm run eval:run -- \
  --base-url http://127.0.0.1:3120 \
  --provider openapi-mimo-troubleshooting \
  --category advanced_troubleshooting \
  --out eval/results/provider-b-troubleshooting.jsonl \
  --timeout-ms 180000 \
  --concurrency 1 \
  --delay-ms 5000 \
  --resume
```

The runner sends `X-IMA-QA-Eval: 1`, so Provider B can include safe EvidencePack diagnostics in JSON responses. Normal browser/API calls do not receive those diagnostics.

For Provider C v0.2, run one smoke question first, then category batches, then the full 50:

```bash
npm run eval:run -- \
  --base-url http://127.0.0.1:3121 \
  --provider local-rag-mimo \
  --out eval/results/provider-c-smoke.jsonl \
  --limit 12 \
  --timeout-ms 180000

npm run eval:run -- \
  --base-url http://127.0.0.1:3121 \
  --provider local-rag-mimo \
  --category capture_devices \
  --out eval/results/provider-c-capture.jsonl \
  --timeout-ms 180000

npm run eval:run -- \
  --base-url http://127.0.0.1:3121 \
  --provider local-rag-mimo \
  --out eval/results/provider-c-full.jsonl \
  --timeout-ms 180000
```

When `--provider` includes `local-rag`, the Markdown report is Chinese and uses per-question review blocks instead of the large manual-scoring table. Provider C diagnostics include planner type, first/second-pass candidate counts, disambiguation drops, evidence/public source counts, and coverage flags.

Each result row now includes:

| Field | Meaning |
| --- | --- |
| `failureReason` | Empty for normal successful evidence-backed answers; otherwise one of `openapi_quota_exceeded`, `network_failure`, `mimo_failure`, `no_evidence`, `timeout`, `http_error`, or `unknown`. |
| `queryVariantCount` | Number of query variants that contributed to the final EvidencePack. |
| `retrievedSourceCount` | Number of public sources returned to the answer generator. |
| `enrichedSourceCount` | Number of sources whose snippets were expanded through note/URL/PDF enrichment. |

Use these fields during manual review to separate retrieval problems from generation problems. For example, `retrievedSourceCount=0` / `no_evidence` means retrieval did not find usable evidence; high source count with a weak answer points more toward generation or prompt quality.

## 并发与会话隔离测试

批量质量评测的 `--concurrency` 主要服务于评测集，不适合验证多客户会话是否串线。专用探针会为每路请求生成独立的 `X-IMA-Client-Id`，读取对应会话详情，并检查历史中的测试标记：

```bash
# 当前双账号基线：两路独立首问
npm run test:concurrency -- \
  --base-url http://127.0.0.1:3117 \
  --concurrency 2

# 首问完成后，再并行追问各自会话
npm run test:concurrency -- \
  --base-url http://127.0.0.1:3117 \
  --concurrency 2 \
  --follow-up

# 用两路槽位承接十个请求，验证排队、超时和最终 active/queued 是否归零
npm run test:concurrency -- \
  --base-url http://127.0.0.1:3117 \
  --requests 10 \
  --concurrency 2 \
  --out runtime/concurrency-10.json
```

可用参数：`--mode json` 切换为 JSON 请求，`--questions path/to/questions.jsonl` 使用自己的问题集，或者重复传 `--question "问题"`，`--timeout-ms` 设置单请求超时，`--token` 传入服务端 Bearer Token。不要直接从 2 路跳到大规模公网压测；先看服务端 `healthz`、IMA 账号冷却和队列释放情况。
