# My AI Framework PoC — Milestone Summary

This document summarizes what we have built so far for the proof‑of‑concept web framework that compiles plain English into a running Express.js application using an LLM as the "compiler".

## Vision Recap

- **Plain English Source**: A single file (`app.txt`) describes the site.
- **LLM Compiler**: On startup, we send `app.txt` + tool schemas to an LLM (Gemini OpenAI-compatible API) and receive structured `tool_calls`.
- **Runtime Build**: We execute those tool calls against a set of framework tools to build an Express app in memory.
- **Serve Fast**: The pre-built Express app serves requests with no additional LLM calls.

## Project Structure

```
/my-ai-framework
|-- index.js          # Server entry: compiles app and starts Express
|-- llm-compiler.js   # Core compiler: LLM call, executes tool calls, wires routes
|-- tools.js          # Framework tools + JSON tool definitions for the LLM
|-- app.txt           # Plain English source for the website
|-- config.json       # Local configuration (API key, model, base URL)
|-- package.json      # Node project config (ESM)
|-- .cache/compiled-plan.json  # Cached compiled tool plan (auto-generated)
|-- documentation.md  # How to use the framework, tools, and LLM keywords
|-- assets/           # Static files (e.g., images/) served at /assets
```

## What Works Today

- **LLM integration** (`llm-compiler.js`):
  - Reads `app.txt`.
  - Calls Gemini’s OpenAI-compatible `chat/completions` endpoint.
  - Sends a system prompt that instructs the model to respond with tool calls only.
  - Provides JSON `tools` (from `tools.js`) and `tool_choice: "auto"` so the model emits the right sequence of calls.
  - Extracts `choices[0].message.tool_calls` and executes them.
- **Tools implemented** (`tools.js`):
  - `create_page({ path, content })` stores page content in an in-memory `pages` store.
  - `add_dynamic_content({ path, placeholder, type })` marks placeholders for dynamic replacement (PoC supports only `CURRENT_TIME`).
  - `set_layout({ header_html, footer_html })` defines a shared header/footer layout applied to every page; `create_page.content` should be BODY-only.
  - `add_asset({ path, asset, alt, placement, placeholder, className, width, height })` inserts an asset (e.g., an image) from `assets/` into a page body. Supports append/prepend or placeholder replacement.
  - `toolDefinitions` expose JSON schemas for all tools so the LLM knows how to call them.
- **Dynamic content** (`llm-compiler.js`):
  - On each request, route handlers replace placeholders (e.g., `{{CURRENT_TIME}}`) with live values using `applyDynamicReplacements()`.
- **Routing**: After executing tool calls, we wire Express routes from the `pages` store and serve HTML directly.
- **Fallback**: If no pages are produced, a friendly fallback page renders at `/` to aid debugging.
- **Hot reload** (`index.js`): Changes to `app.txt` trigger a graceful server restart and recompilation via `chokidar`; no manual restarts needed.
- **Compilation cache** (`llm-compiler.js`): After a successful compile, the tool plan is saved to `.cache/compiled-plan.json`. On startup, if `app.txt` is unchanged since the cache was written, the LLM call is skipped and the app is built from the cached plan (fast, offline-friendly).
 - **Templates/layouts**: Route responses are stitched as `layout.header_html + page.content + layout.footer_html` when a layout is set.
 - **Static assets**: The local `./assets` directory is served at `/assets`. The system prompt includes an inventory of assets so the LLM can reference exact filenames. Cache invalidates if the asset inventory changes.

## Example Source (`app.txt`)

- Two pages: `/` (home) and `/about`.
- Home has a main heading and a paragraph; includes `{{CURRENT_TIME}}` to show server time.
- About has a heading and a paragraph.

## Configuration & Credentials (`config.json`)

- Primary configuration lives in `config.json`:

```json
{
  "gemini": {
    "apiKey": "YOUR_GEMINI_API_KEY",
    "model": "gemini-2.5-pro",
    "openAIBase": "https://generativelanguage.googleapis.com/v1beta/openai"
  }
}
```

- **Fallback to env vars** if any fields are missing:
  - `gemini.apiKey` ← `GEMINI_API_KEY`
  - `gemini.model` ← `GEMINI_MODEL` (defaults to `gemini-2.5-pro`)
  - `gemini.openAIBase` ← `GEMINI_OPENAI_BASE` (defaults to the value above)
- **Auth**: We use the Authorization header (`Bearer <apiKey>`) with the OpenAI-compatible `chat/completions` endpoint.

## Endpoint & Request Shape

- **Endpoint**: `${openAIBase}/chat/completions`
- **Headers**: `Content-Type: application/json`, `Authorization: Bearer <apiKey>`
- **Body** includes:
  - `model`
  - `messages` (system + user)
  - `tools` (from `tools.js`)
  - `tool_choice: "auto"`
  - `temperature: 0`

## Error Handling

- **Missing/invalid credentials**: Clear error if no API key can be found in `config.json` or env.
- **HTTP errors**: We surface Gemini response details for faster diagnosis (e.g., 400 Missing Authorization header).
- **No pages compiled**: We mount a fallback page to guide the developer.
- **Stale or corrupted cache**: Delete `.cache/compiled-plan.json` or modify `app.txt` to force recompilation.

## How to Run (Windows)

Prereqs: Node.js 18+

1) Install dependencies
```powershell
npm install
```

2) Put your API key in `config.json` (recommended) or set env vars
```powershell
# optional env fallback
$env:GEMINI_API_KEY = "<YOUR_KEY>"
$env:GEMINI_MODEL = "gemini-2.5-pro"
$env:GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
```

3) Start the server
```powershell
npm start
```

Tip: With hot reload enabled, edit and save `app.txt` — the server will automatically recompile and restart.

Note: After the first successful compile, restarts use the cached plan if `app.txt` hasn’t changed. No API calls or credentials are needed for cached startups.

4) Visit
- Home: http://localhost:3000/
- About: http://localhost:3000/about

## Design Choices

- **ESM** project (`"type": "module"`) for modern JS ergonomics.
- **Simple in-memory state** for PoC clarity and speed.
- **Single-pass compile**: All LLM interaction happens at boot; serving is fast and deterministic.
- **Strict tool schemas**: Tools are described with JSON Schema so the LLM emits valid arguments.

## Potential Next Steps

- **More tools**: `serve_static`, `fetch_data`, `add_form`, `add_styles`.
- **Partials/slots**: Build on layouts by adding partials/slots and simple templating.
- **Validation**: Add JSON Schema validation on tool arguments at runtime.
- **Testing**: Unit tests for tools and compiler; mock LLM responses for deterministic builds.
- **CLI**: `myai build`, `myai dev`, `myai inspect` (view last tool plan).
- **Observability**: Structured logs for tool execution, timing, and errors.

## Troubleshooting

- **400 Missing Authorization header**: Ensure we’re using the `Authorization: Bearer <apiKey>` header (we are) and the API key is valid.
- **Invalid base URL**: Confirm `openAIBase` is `https://generativelanguage.googleapis.com/v1beta/openai` or your correct endpoint.
- **Network issues**: Check proxies/firewalls; retry with `npm start` in a clean shell.
- **Empty output**: If no routes are generated, verify `app.txt` clarity and that the model supports tools.
- **Stale or corrupted cache**: Delete `.cache/compiled-plan.json` or modify `app.txt` to force recompilation.

## Changelog (Highlights)

- Added `package.json` with ESM, scripts, and deps (Express, node-fetch).
- Created `app.txt` example with two pages and `{{CURRENT_TIME}}` placeholder.
- Implemented `tools.js` with `create_page` and `add_dynamic_content` plus tool schemas.
- Built `llm-compiler.js` to call Gemini, execute tool calls, and wire routes.
- Implemented dynamic content replacement for `CURRENT_TIME`.
- Added `index.js` server entrypoint.
- Enabled hot reload of `app.txt` via `chokidar` with graceful restart in `index.js`; includes SIGINT cleanup.
- Introduced `config.json` and updated compiler to read config first, env vars second.
- Switched auth to **Authorization header** (Bearer) for Gemini.
 - Added `set_layout` tool and layout stitching (header + BODY + footer) across all routes.
- Added file-based cache for compiled tool plan at `.cache/compiled-plan.json`; skips LLM when `app.txt` is unchanged and supports offline restarts.
 - Added `add_asset` tool; compiler now serves `./assets` at `/assets` and includes an asset inventory in the system prompt. Cache also keys off an assets signature.
