# Optional chat presentation view

`presentation=chat_v1` is an additive read view for the native chat and branded BFF. Authentication, application identity, conversation ownership, idempotency keys and task event IDs are unchanged. It is not an account-pool initialization or a deployment instruction.

Use the view on:

- `GET /api/tasks/:id?presentation=chat_v1`
- `GET /api/tasks/:id/events?after=0&presentation=chat_v1`
- `GET /api/conversations/:id?presentation=chat_v1`
- The corresponding `/internal/provider-a/tasks` reads, after normal service authentication.

Task creation and cancellation keep their current contracts. Default reads continue to provide operational source records. Bot-contract streams retain their existing text sanitizer and do not emit the new browser-only stage/recommendation events.

## Citation association

The source array's `index` is a legacy arrival index. It must never be used to resolve an inline web reference. The explicit Markdown target determines the lookup key:

```text
[7](@index-ref?id=42)    -> citationMap["index:42"]
[3](@context-ref?id=91)  -> citationMap["context:91"]
```

```json
{
  "citationMap": {
    "index:42": {
      "type": "web",
      "displayNumbers": ["7"],
      "sources": [{"url":"https://example.org/paper","title":"Example","snippet":"Upstream excerpt"}]
    },
    "index:5": {"type":"knowledge","displayNumbers":["2"]}
  }
}
```

`displayNumbers` is optional and collected from explicit links outside code/formulas. A key may have multiple web sources; the card displays each rather than choosing by title or arrival. Multiple keys may point to the same URL. Late metadata merges by explicit key and exact URL. Conflicting knowledge/web provenance leaves an unknown, static citation. Ordinary numbers are not references.

Structured `reference_indexes.indexes` keys are authoritative. Its `type` enum is distinct from `sourceType`: reference `type=1` means web and `type=2` means media; `sourceType=0` means web and `1/2` means knowledge/media recall. The enum and dictionary lookup were checked against the [first-party web client](https://fe-static.ima.myqcloud.com/ima/assets/chat/assets/app-DNcHlL3P.js) on 2026-10-13. This static protocol evidence does not replace real-answer acceptance on the deployed transport.

Context-reference dictionaries and legacy reference arrays need explicit keys and proved web provenance. An absent association/provenance remains static. No link is guessed from a media array's position, URL alone or title. Publisher names are not excerpts. HTTP(S) URLs with credentials and IMA knowledge-page URLs are not preview targets.

The view removes legacy source titles/snippets and search-summary text. Knowledge entries contain only type and citation associations; web entries may contain supplied title, URL and excerpt. `sourceCount` and existing answer-evidence counts remain available. Unknown process metadata produces an empty event payload, preserving the event ID and cursor continuity.

## Events, storage and completion

`sources` carries the cumulative `citationMap`. `suggestions` carries at most three distinct question strings, extracted from `SUGGEST_QUESTION` text fields; tool/knowledge-base metadata is discarded. Malformed recommendation payloads are ignored. Other unknown semantic events still fail closed.

`process` uses stable IDs `chat:knowledge`, `chat:web`, `chat:answer`, with phases `knowledge`, `web`, `answer` and statuses `running`, `completed`, `failed`, `cancelled`. Retrieval completion is shown only after actual source evidence; generation begins with received answer text. No elapsed retrieval time, invented percentage or unobserved agent action is generated.

Supported late citation metadata and recommendations are consumed through upstream EOF. They enter the durable event log, completion journal and conversation history before the single local `done`. Snapshots, reconnects, history reloads and schema-v1 history export preserve the same optional presentation metadata. No old record is replayed upstream or given a guessed mapping.

## Rollout boundary

Validate synthetic replay first. Real IMA questions and production deployment need separate approval. Deploy the compatible Provider backend before either frontend, preserve private state and the migration compatibility patches, and retain a private backup plus code rollback patch. Never replace the running migration checkout with GitHub main. The Air bot, tunnels and credentials are not changed by this feature.
