# Shadcn Explorer

**Search every shadcn registry in one place, with a live demo of each component.**

→ https://shadcn-explorer.inaridiy.com

shadcn/ui is copy-paste by design, so its components are spread across hundreds of third-party registries. Shadcn Explorer imports the registries listed in the [official shadcn directory](https://ui.shadcn.com/docs/directory), plus shadcn/ui itself. For each component it writes a short usage doc and builds a running demo, then lets you browse and search all of them together.

- **Gallery and search.** Browse across registries, or press ⌘K. Search matches keywords first, then adds results that are close in meaning or appearance. You can also search with an image.
- **Real previews.** Each demo is built with `shadcn add` and Vite in a sandbox, so the preview is the component as published, not a screenshot from its site. Animated components get animated thumbnails.
- **Install command.** Every component page shows the `npx shadcn add` command for it.
- **For coding agents.** An MCP server and a REST API expose the same search (see [Use it from an agent](#use-it-from-an-agent)).
- **Open build logs.** Every demo has a public build log, and `/live` shows imports as they happen.
- **Themes.** Each registry's theme (colors, fonts, radius) is detected from its install docs and applied to its previews.

Docs and demos are written by an LLM and can be wrong. Use the report links on each page if something looks off.

## Use it from an agent

The MCP endpoint is `https://shadcn-explorer.inaridiy.com/mcp` (Streamable HTTP, no API key needed). For Claude Code:

```bash
claude mcp add --transport http shadcn-explorer https://shadcn-explorer.inaridiy.com/mcp
```

For Cursor, VS Code and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "shadcn-explorer": { "type": "http", "url": "https://shadcn-explorer.inaridiy.com/mcp" }
  }
}
```

It provides three tools: `search_components`, `get_component` and `list_registries`. The same data is available over REST, for example:

```bash
curl "https://shadcn-explorer.inaridiy.com/api/v1/search?q=gradient+button&limit=5"
```

Requests are rate-limited per IP. If you need more, open an issue.

## Request a registry or report a problem

Feedback goes through GitHub Issues, each with its own form:

| You want to… | Open |
| --- | --- |
| Add a registry that isn't listed | [Registry request](https://github.com/inaridiy/shadcn-explorer/issues/new?template=registry-request.yml) |
| Report a broken or wrong preview | [Preview report](https://github.com/inaridiy/shadcn-explorer/issues/new?template=preview-report.yml) |
| Report a registry whose colors, fonts or radius look wrong everywhere | [Theme report](https://github.com/inaridiy/shadcn-explorer/issues/new?template=theme-report.yml) |
| Anything else | [New issue](https://github.com/inaridiy/shadcn-explorer/issues/new) |

The preview and theme forms are also linked from component and registry pages, with the fields filled in.

Registries in the official directory are imported automatically and marked **Official**. Requested registries are reviewed by hand and marked **Community**. Every registry is re-synced about once a week.

## Run it locally

You need Node.js (developed on 24), pnpm and Docker. No API keys are needed: local mode uses a fake LLM and fake previews.

```bash
pnpm install
cd apps/web
cp .dev.vars.example .dev.vars   # EXPLORER_MODE=local
pnpm db:migrate:local
pnpm dev                         # http://localhost:3000
```

The first `pnpm dev` takes a few minutes, because it builds the preview container image with Docker.

To run the tests and the type checker:

```bash
pnpm -r test
pnpm -r typecheck
```

## How it is built

It runs on Cloudflare Workers (TanStack Start, Hono, D1, R2, Vectorize, Queues, Workflows and Containers), with the core logic written in [Effect](https://effect.website).

```
packages/core            domain model, ports and use cases (pure, tested with in-memory adapters)
apps/web                 the Worker: UI, REST, MCP and the Cloudflare adapters
apps/web/preview-harness container image that builds and screenshots each demo
```

The design notes are in Japanese: [docs/DESIGN.md](docs/DESIGN.md) covers the architecture and its trade-offs, and [docs/OPERATIONS.md](docs/OPERATIONS.md) covers operating and deploying it.

## License

[MIT](LICENSE). Components shown on the site belong to their registries and keep their own licenses.
