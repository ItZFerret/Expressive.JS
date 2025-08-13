// llm-compiler.js
// Core compiler that reads the plain English source, asks Gemini (OpenAI-compatible chat.completions)
// for a sequence of tool calls, executes those tools to configure an Express app, and returns it.

import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import fetch from 'node-fetch';
import { tools, toolDefinitions } from './tools.js';

function resolveProjectPath(rel) {
  return path.resolve(process.cwd(), rel);
}

function parseToolArgs(maybeJson) {
  if (maybeJson == null) return {};
  if (typeof maybeJson === 'object') return maybeJson; // Already parsed
  try {
    return JSON.parse(maybeJson);
  } catch (e) {
    throw new Error(`Failed to parse tool arguments as JSON: ${maybeJson}`);
  }
}

function applyDynamicReplacements(html, dynamic) {
  if (!Array.isArray(dynamic) || dynamic.length === 0) return html;
  let out = html;
  for (const entry of dynamic) {
    const { placeholder, type } = entry;
    if (!placeholder) continue;
    if (type === 'CURRENT_TIME') {
      const now = new Date().toLocaleString();
      // Replace all occurrences of the placeholder
      out = out.split(placeholder).join(now);
    }
  }
  return out;
}

// Recursively list asset files under the local ./assets directory.
// Returns POSIX-style paths relative to project root, e.g. 'assets/images/test.png'.
async function listAssetFiles() {
  const root = resolveProjectPath('assets');
  async function walk(dir, base) {
    let entries = [];
    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const it of items) {
        const abs = path.join(dir, it.name);
        const rel = path.join(base, it.name);
        if (it.isDirectory()) {
          entries = entries.concat(await walk(abs, rel));
        } else {
          // Normalize to POSIX-style
          entries.push(rel.split(path.sep).join('/'));
        }
      }
    } catch (_) {
      // If assets directory doesn't exist, return empty
    }
    return entries;
  }
  return walk(root, 'assets');
}

export async function compileApp() {
  // 1) Read the plain English source file
  const sourcePath = resolveProjectPath('app.txt');
  const sourceText = await fs.readFile(sourcePath, 'utf8');

  // 2) Load config (optional) and check cache before any network calls
  let cfg = {};
  try {
    const cfgPath = resolveProjectPath('config.json');
    const raw = await fs.readFile(cfgPath, 'utf8');
    cfg = JSON.parse(raw) || {};
  } catch (e) {
    // config.json is optional; ignore if missing or invalid
  }

  // Build an assets inventory and signature so the LLM can pick known files,
  // and so cache validity can account for asset list changes.
  const assetsList = await listAssetFiles();
  const assetsSignature = JSON.stringify([...assetsList].sort());

  const cacheDir = resolveProjectPath('.cache');
  const cachePath = resolveProjectPath(path.join('.cache', 'compiled-plan.json'));
  let toolCalls = null;
  let useCache = false;
  try {
    const [sourceStat, cacheStat] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(cachePath),
    ]);
    if (cacheStat.mtimeMs >= sourceStat.mtimeMs) {
      const cachedRaw = await fs.readFile(cachePath, 'utf8');
      const cached = JSON.parse(cachedRaw);
      if (Array.isArray(cached?.toolCalls) && cached?.assetsSignature === assetsSignature) {
        toolCalls = cached.toolCalls;
        useCache = true;
        console.log('[my-ai-framework] Using cached compiled plan.');
      } else if (Array.isArray(cached?.toolCalls)) {
        console.log('[my-ai-framework] Cache present but assets inventory changed; recompiling.');
      }
    }
  } catch (_) {
    // Cache not present or invalid; proceed to LLM call
  }

  if (!useCache) {
    // 3) Prepare LLM request (OpenAI-compatible chat/completions to Gemini)
    const apiKey = cfg?.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key is missing. Provide it in config.json under gemini.apiKey or set GEMINI_API_KEY.');
    }
    const model = cfg?.gemini?.model || process.env.GEMINI_MODEL || 'gemini-2.5-pro';
    const base = (cfg?.gemini?.openAIBase || process.env.GEMINI_OPENAI_BASE || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
    const url = `${base}/chat/completions`;

    // Provide environment context and authoring guidance to the model.
    const assetList = assetsList.length ? `Available assets (relative to /assets):\n- ${assetsList.map(a => a.replace(/^assets\//, '')).join('\n- ')}` : 'No assets found.';
    const systemPrompt = [
      'You are a web compiler. Translate a plain-English description into a sequence of tool calls to build a website.',
      'Rules:',
      '- Return tool calls only, with valid JSON arguments. No commentary.',
      '- Use set_layout() for the shared wrapper (document start, metadata, title, open body; and close body/end document).',
      '- Use create_page() for BODY-only content. The user writes in plain English; you generate the HTML.',
      '- Use add_dynamic_content() to mark placeholders like {{CURRENT_TIME}}.',
      '- Use add_asset() to insert images from the local assets/ directory; prefer exact filenames from the inventory below.',
      '',
      'Environment:',
      '- Static files are served from /assets (mapped to the local ./assets directory).',
      assetList,
    ].join('\n');

    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sourceText },
      ],
      tools: toolDefinitions,
      tool_choice: 'auto',
      temperature: 0,
    };

    // 4) Make the API call
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gemini chat.completions failed: ${resp.status} ${resp.statusText} - ${text}`);
    }

    const data = await resp.json();
    toolCalls = data?.choices?.[0]?.message?.tool_calls || [];

    // Persist the compiled plan for future fast/reliable startups
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      const sourceStat = await fs.stat(sourcePath);
      const payload = {
        toolCalls,
        createdAt: new Date().toISOString(),
        sourceMTimeMs: sourceStat.mtimeMs,
        model,
        openAIBase: (cfg?.gemini?.openAIBase || process.env.GEMINI_OPENAI_BASE || 'https://generativelanguage.googleapis.com/v1beta/openai'),
        assetsSignature,
      };
      await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
      console.log(`[my-ai-framework] Cached compiled plan at ${path.relative(process.cwd(), cachePath)}`);
    } catch (e) {
      console.warn('[my-ai-framework] Failed to write cache:', e?.message || e);
    }
  }

  // 4) Initialize Express app and in-memory pages store
  const app = express();
  let pages = {};
  let layout = { header_html: '', footer_html: '' };

  // Serve static files from the local ./assets directory at /assets
  app.use('/assets', express.static(resolveProjectPath('assets')));

  // 5) Execute each tool call against our runtime tools
  for (const call of toolCalls) {
    const name = call?.function?.name || call?.name;
    const argsRaw = call?.function?.arguments ?? call?.arguments;
    if (!name) {
      console.warn('Skipping tool call with no name:', call);
      continue;
    }
    const fn = tools[name];
    if (typeof fn !== 'function') {
      console.warn(`Unknown tool '${name}', skipping.`);
      continue;
    }

    const args = parseToolArgs(argsRaw);
    // ctx object carries references the tools might need; expand as framework grows
    const ctx = { app, pages, layout };
    // Tools are async to allow future I/O if needed
    // eslint-disable-next-line no-await-in-loop
    await fn(ctx, args);
  }

  // 6) Wire Express routes from the pages store
  const pageEntries = Object.entries(pages);
  if (pageEntries.length === 0) {
    // Fallback page if the LLM did not provide any tools (defensive for PoC)
    pages['/'] = {
      content:
        '<!doctype html><html><head><meta charset="utf-8"><title>LLM Compiler</title></head><body><h1>LLM compilation produced no pages</h1><p>Please check your API key and model, or adjust app.txt.</p></body></html>',
      dynamic: [],
    };
  }

  for (const [routePath, page] of Object.entries(pages)) {
    app.get(routePath, (req, res) => {
      const body = applyDynamicReplacements(page.content || '', page.dynamic || []);
      const header = layout?.header_html || '';
      const footer = layout?.footer_html || '';
      const fullHtml = (header || footer) ? `${header}${body}${footer}` : body;
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(fullHtml);
    });
  }

  return app;
}
