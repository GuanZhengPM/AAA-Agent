Replace exact text in one existing workspace file. You MUST `read` every affected line first and copy its current snapshot `hash`.

Input:

```json
{
  "path": "src/example.ts",
  "hash": "A1B2C3D4E5F6",
  "edits": [
    {
      "oldText": "return `Hi, ${name}`;",
      "newText": "return `Hello, ${name}!`;"
    }
  ]
}
```

Each `oldText` MUST occur exactly once and touch only lines returned by `read`. Include surrounding text when a fragment repeats. Multiple edits MUST NOT overlap. Snapshot mismatch? Re-`read`; NEVER guess a hash.
