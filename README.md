# FirstThousand

A launch brief for your indie game, where every claim cites the Qloo taste data behind it.

> Status: in development for the Qloo Agentic Hackathon. The pipeline, verifier and UI run against test doubles; live Qloo runs start once the event API key is issued.

## What it does

You describe your game and name one to three comparable games. The agent:

1. **Core research.** Resolves the comparable games in Qloo, pulls their taste tags, asks for cross-domain recommendations (music artists, films, podcasts, brands, TV shows, similar games) and where the audience is concentrated in your main market. With a second direction, it compares the two audiences.
2. **Follow-up.** A model reads that evidence and may make a few more Qloo calls where results were empty or vague.
3. **Writing.** The model writes the brief as structured claims. Each claim lists the names it mentions and the evidence ids (E1, E2, ...) it relies on.
4. **Checking.** Code, not the model, checks every named item against the cited Qloo results and labels each claim: grounded, partial, not in evidence, or interpretation.
5. **Comparison.** The same model writes a brief without Qloo. Up to eight of its named items are looked up in Qloo to show which exist at all.

Each evidence item keeps the harness provenance (the GET path and query sent to Qloo), so a reader can see exactly which request a sentence depends on.

## Why Qloo is central

Without Qloo the brief is the model's general knowledge: plausible names with no source. With Qloo, the cross-domain links (what fans of these games also listen to, watch and buy, and where they are) come from Qloo's taste graph, and the app can show which sentences are backed and which are not.

## Run locally

Requires Node.js 22.19 or newer.

```bash
npm install
QLOO_API_KEY=... GEMINI_API_KEY=... npm start   # http://localhost:8080
npm test                                         # runs without keys
```

Environment variables:

| Name | Purpose | Default |
|---|---|---|
| `QLOO_API_KEY` | Qloo event credential, passed to `qloo mcp` | required for live runs |
| `GEMINI_API_KEY` | Model for follow-up, writing and the LLM-only brief | required for live runs |
| `GEMINI_MODEL` | Model id | `gemini-2.5-flash` |
| `PER_IP_PER_HOUR` / `DAILY_CAP` | Live-run limits to protect the shared quota | 6 / 120 |
| `DATA_DIR` | Cache of finished briefs | `./data` |

Keys are read only by the server process. The browser talks to this server, never to Qloo or the model directly.

## Architecture

```
browser ── POST /api/brief (SSE) ──> Node server
                                      ├─ qloo mcp (official @qloo/qloo-harness, stdio)
                                      ├─ Gemini (follow-up, writer, baseline)
                                      └─ verifier (plain code)
```

- `src/qloo.js` MCP client for the harness; parses the result envelope
- `src/agent.js` core plan, follow-up loop, writer, baseline
- `src/evidence.js` evidence store and name extraction
- `src/verify.js` claim verification
- `src/server.js` HTTP, streaming, cache, rate limits, saved examples

## Limits

- Qloo results are aggregate taste affinities. They are not predictions about any person and not sales forecasts.
- The verifier checks that named items appear in the cited evidence. It does not judge whether the advice is good.
- Name matching is normalized string matching, so a renamed or abbreviated title can be marked as missing.
- No personal data is sent to Qloo. Inputs are game descriptions and public game titles.

## License

MIT
