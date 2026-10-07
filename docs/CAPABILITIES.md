# Capabilities: what the agent can show and make beyond text

Research reference for syrup (OpenCode engine, Next.js/React UI, local or Vercel Sandbox per workspace). Written 2026-10-07. Facts marked **verify** were taken from secondary sources or memory and should be re-checked before they drive a decision. Sizes are minified+gzipped unless stated.

---

## Executive summary (one screen)

- **The product gap is not "more widgets", it is "a rendering contract".** Every competitor that renders beyond text picked one of three contracts: the agent **writes code** (Claude Artifacts, Bolt, v0, Lovable), the agent **emits a declarative spec** (A2UI, json-render, thesys C1), or the agent **calls a tool whose structured result the host renders** (Vercel AI SDK tool parts, MCP Apps, OpenAI Apps SDK). We should run all three, layered, because each covers what the others cannot.
- **Layer 0, build first: rich fenced blocks in markdown.** The agent already streams markdown. Teach the markdown renderer to turn closed fences into visuals: ` ```mermaid `, ` ```vega-lite `, ` ```svg `, ` ```html ` (sandboxed), ` ```abc `, ` ```markmap `, ` ```d2 `, ` ```csv `, `$$ math $$`. Zero engine changes, works with every free model, streams naturally, and already covers charts, diagrams, trees, sheet music, math, and small live previews. Effort S–M. Breadth per effort is unmatched.
- **Layer 1: file artifacts rendered in the existing Preview tab.** The agent writes `.html`, `.svg`, `.md`, `.csv`, `.json`, `.excalidraw`, `.vl.json`, `.ipynb` into the workspace; `file-preview.tsx` already renders several of these in a `sandbox="allow-scripts"` srcdoc frame. Extend the kind table. This is how a coding agent naturally works, and user edits round-trip through the file system in both local and cloud modes. Effort S per kind.
- **Layer 2: structured tool results.** Ship a small set of OpenCode custom tools (`.opencode/tools/*.ts`, `tool()` helper, Zod args) such as `show_chart`, `show_table`, `show_diagram`, `ask_form`. The UI keys a renderer registry on `ToolPart.tool`. Tool output to the model stays short; the payload goes to a file under `.syrup/artifacts/` or into `ToolState.metadata`. Effort M. Gives guaranteed-valid specs and forms that round-trip answers.
- **Layer 3: live app preview.** Vercel Sandbox publishes up to 4 ports declared at create time (`sandbox.domain(port)` gives an `https://*.vercel.run` URL); local mode proxies `localhost`. Iframe it in the Preview tab with a device-width switcher. Effort M. This is the Bolt/Lovable/Replit experience without WebContainers (whose commercial license we should avoid).
- **Layer 4: editable canvases.** Embed Excalidraw (MIT) in the Preview tab for `.excalidraw` files; later a minimal SVG "frame + rect + text" design editor of our own. Avoid tldraw for now (license key, watermark on hobby tier since SDK 4.0). Effort L. Edits save back to the file; the agent reads the file on the next turn, which is the round-trip.
- **Speed rules.** Nothing new in the main chunk. Each renderer is a `next/dynamic` chunk loaded on first use, prefetched on idle. Render a fence only when it closes; show a skeleton while it is open. Hash-cache rendered SVG. Heavy runtimes (Excalidraw ~1 MB, DuckDB-WASM 2.5 MB wasm, Pyodide ~10 MB) load only on an explicit open, never in the chat column. On phones, render the static thumbnail in chat and open the interactive version in the panel.
- **Recommended first 8 (ordered):** 1) fenced Mermaid + SVG + math, 2) fenced Vega-Lite charts, 3) richer tables (CSV/JSON → sortable virtualized grid), 4) HTML/React single-file preview with sandbox hardening, 5) live port preview, 6) structured `ask_form`/`show_*` tools, 7) Excalidraw editable diagrams, 8) sheet music + mind maps + D2 as cheap add-ons. Items 1–4 are achievable in days each; 5–7 in a week or two each.
- **Do not copy:** WebContainers (license), tldraw (license), a monolithic Monaco (2+ MB), rendering trusted React from agent code in our own origin, a separate "Canvas mode" that forks the chat. **Top risks:** agent-written code in the browser (needs a separate origin or strict sandbox + CSP, no `allow-same-origin`), bundle creep, Mermaid/Vega syntax errors from weaker free models (auto-repair loop), and phone layouts.

---

## 1. Scope and how to read this

- **Question.** What should syrup render or let the agent make beyond markdown and tool rows, how, and in what order?
- **Constraints taken as given.** Free-first routing (weak models must still produce valid output). Speed first: time to first token and smooth UI during waits. Local and cloud frontends must match; only the backend may differ. 1 vCPU sandbox. Phones matter.
- **Sections.** §2 what exists today. §3 the landscape. §4 library catalog. §5 the big taxonomy. §6 architecture. §7 build order. §8 what not to copy. §9 risks. §10 open questions and sources.

---

## 2. What syrup renders today (ground truth from the repo)

- **Message parts** come from OpenCode's SSE stream as typed `Part`s: `text`, `reasoning`, `tool`, `file`, `patch`, `step-finish`, `retry`, `compaction` (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`). `src/components/parts.tsx` switches on `part.type`.
- **Text** renders through `react-markdown` + `remark-gfm` (`src/components/markdown.tsx`) with a typewriter effect, file-path links, copy buttons on code blocks, and tables that scroll inside themselves.
- **Tool parts** render as collapsible rows keyed by `part.tool` (`TOOL_LABEL`/`TOOL_VERB` maps). `ToolStateCompleted` carries `output: string`, `title`, `metadata: Record<string, unknown>`, and optional `attachments: FilePart[]`. That `metadata` field is the natural hook for structured renderers.
- **Side panel** (`src/lib/panel.tsx`) has three tabs: `changes`, `files`, `preview`. Width 320–680 px; a prefill-composer event exists (`syrup:prefill`), which is a ready-made round-trip primitive.
- **Preview tab** (`src/components/file-preview.tsx`) already renders one workspace file by kind: `html` in a sandboxed srcdoc iframe (scripts allowed, no same-origin), `svg` only as `<img>`, `pdf` via the browser viewer, `markdown`, `csv`/`tsv`, `json`, `code` with syntax highlighting, images, binary fallback. It reloads when the agent changes files. The HTML inliner (`src/lib/html-inline.ts`) resolves local assets.
- **Attachments** (images/files as data URLs) exist. **Changes panel** shows engine snapshot diffs or touched files.
- **Cloud** runs one Vercel Sandbox per workspace; only OpenCode's port is public today. The browser talks to OpenCode directly with Basic auth.
- **Takeaway.** Layers 0 and 1 below are extensions of code that exists. Nothing requires a new transport.

---

## 3. Landscape: what existing agent products render beyond text

### 3.1 Three delivery contracts

| Contract | Agent emits | Host does | Strengths | Weaknesses | Who uses it |
|---|---|---|---|---|---|
| **A. Code** | HTML/JSX/SVG/Python, a whole file or app | Runs it in a sandboxed iframe or sandbox VM | Unlimited expressiveness; any model can do it; matches what a coding agent does anyway | Security (untrusted code), slow (needs a bundler or runtime), fragile with weak models, hard to make editable | Claude Artifacts, ChatGPT Canvas, Gemini Canvas, Bolt, v0, Lovable, Replit, AI Studio Build, Perplexity Labs |
| **B. Declarative spec** | JSON (or DSL) describing UI/chart/diagram against a known catalog | Validates and renders with native components | Safe, fast, progressive, consistent styling, editable by design | Only what the catalog can express; needs schema-following models; another format for the model to learn | A2UI, json-render, thesys C1, Vega-Lite/Mermaid fences, MCP-UI "remote DOM" |
| **C. Structured tool result** | A tool call with typed args; tool returns structured data | Maps tool name → React component | Validated by Zod at the boundary; round-trips naturally (the UI can call tools back); fits OpenCode's tool loop | Needs tool plumbing per capability; results also enter the model's context (token cost) | Vercel AI SDK tool parts, MCP Apps, OpenAI Apps SDK, CopilotKit/AG-UI, assistant-ui tool UIs |

- **Observation.** Nobody wins with one contract. Claude Artifacts (A) added Mermaid (B). MCP Apps (C) wraps an HTML app (A). json-render (B) exposes actions that call tools (C). The layered plan in §6 mirrors this.

### 3.2 Chat assistants

| Product | Contract | Surface | Round-trip | Notes and sources |
|---|---|---|---|---|
| **Claude Artifacts** | A (+ Mermaid, SVG, Markdown as B) | Side panel, single-file payload in a sandboxed iframe on `claudeusercontent.com` with CSP and `sandbox` attr | Edit via chat; "versions" | Allowed libs are a fixed cdnjs list: lucide-react, recharts, mathjs, lodash, d3, Plotly, three r128, Papaparse, SheetJS; `localStorage` blocked. https://simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts , https://github.com/Microtechx-GmbH/claude-artifacts-guide |
| **ChatGPT Canvas** | A for code; a shared document editor for prose | Side pane with targeted edits, comments, "suggest edits" | Yes: the user edits the doc, the model edits parts of it | Strength is collaborative editing, not visuals. https://unmarkdown.com/blog/claude-artifacts-vs-chatgpt-canvas |
| **Gemini Canvas** | A | Side pane; one-click "turn into infographic / quiz / web page / audio overview"; export to Docs/Slides/Colab | Partial | Fast generation is its reputation. https://gemini.google/overview/canvas/ , https://bootstrapcreative.com/chatgpt-vs-claude-vs-gemini-terminology/ |
| **Perplexity Labs** | A (Python + web app) | "Apps" pane: dashboards, charts, slides, deployed to a page | Low | Charts come from code execution, not from a spec. https://www.datacamp.com/tutorial/perplexity-labs |
| **Julius AI** | A (Python/R executed server-side) | Inline chart images and GIFs | Low | Data-analyst chat; the chart is an image of code output. https://pythonlibraries.substack.com/p/julius-ai-review-mind-blowing-data |
| **Google AI Studio Build** | A (React frontend + Node runtime) | Full app with preview, "AI chips" to add features | Via prompts | Server-side runtime with secrets. https://ai.google.dev/gemini-api/docs/aistudio-build-mode |

### 3.3 App builders

| Product | Contract | Runtime | Notes and sources |
|---|---|---|---|
| **Bolt.new** | A | **WebContainers** (Node in the browser) | Zero server; no inbound webhooks, no persistent DB in preview. WebContainers need a commercial license for for-profit production. https://addyo.substack.com/p/ai-driven-prototyping-v0-bolt-and , https://webcontainers.io/enterprise |
| **v0** | A (shadcn/ui React) | Server-side preview | Component-focused; "design mode" edits props. https://aicoolies.com/comparisons/bolt-new-vs-v0-vs-lovable |
| **Lovable** | A (React + Tailwind + Vite, Supabase) | Hosted preview, visual editor for layout tweaks | Visual editor is a small round-trip for non-coders. https://blog.tooljet.com/bolt-vs-lovable/ |
| **Replit Agent 4** | A + spatial canvas | **Design Canvas**: infinite board where each frame is a live browser instance at 390×844 / 768×1024 / 1280×720; agent generates variants side by side; pick one to write back to the codebase | Strongest "many previews on one canvas" precedent. https://docs.replit.com/references/design/canvas , https://abduzeedo.com/replit-canvas-spatial-ui-design-tool |

### 3.4 Coding agents and editors

| Product | What it renders beyond text | Notes and sources |
|---|---|---|
| **Cursor** | Inline diffs, agent mode, an integrated browser for previews | Users still ask for Lovable-style visual preview. https://forum.cursor.com/t/visual-preview-just-like-lovable-dev/52337 |
| **Windsurf / Devin Desktop** | Cascade multi-file diffs; previews with element selection and error capture | https://docs.devin.ai/zh/desktop/previews.md |
| **Devin** | Own shell, browser, editor; works from Slack | https://www.morphllm.com/comparisons/devin-vs-cursor |
| **Zed** | Agent panel; multibuffer review with keep/reject per hunk; diff preview cards in the thread; "Review Diff" from branch view | Best-in-class diff review UX to copy. https://zed.dev/docs/ai/agent-panel |
| **Warp** | Typed **blocks** (command, stdout/stderr, exit code, cwd, time) in one scroll with agent conversations; GPU renderer | Block model is the right mental model for our tool rows. https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment |
| **OpenCode TUI / web** | Text, tool rows, diffs; the web client is basic by their own description | We are the UI; the engine exposes everything needed (parts, snapshots, PTY). |

### 3.5 Protocols and libraries for generative UI

| Name | Contract | Shape | Fit for syrup | Sources |
|---|---|---|---|---|
| **Vercel AI SDK Generative UI** | C (tool parts rendered client-side) or RSC `streamUI` (experimental) | Message parts with `tool-*` types mapped to components; RSC path not recommended for production | OpenCode already speaks AI SDK internally; our client gets OpenCode `ToolPart`s, so "tool name → component" is the same idea | https://vercel.com/blog/ai-sdk-3-generative-ui , https://ai-sdk.dev/v4/docs/reference/ai-sdk-rsc |
| **Vercel AI Elements** | UI kit | 20+ shadcn-style components: Conversation, Message, Reasoning, Tool, PromptInput; copied into your repo, not an npm dep | Good reference for tool/reasoning affordances; we own a comparable set already | https://vercel.com/changelog/introducing-ai-elements |
| **MCP Apps (SEP-1865)** | C wrapping A | Tool declares `_meta.ui.resourceUri` → `ui://` resource with `text/html;profile=mcp-app`; host renders in a sandboxed iframe; JSON-RPC over `postMessage`; host declares capability at initialize | OpenCode supports MCP servers. Rendering MCP App resources in our UI would make any MCP App usable in syrup. Shipped in Claude, ChatGPT, VS Code, Goose | https://blog.modelcontextprotocol.io/tags/apps/ , https://modelcontextprotocol.net/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp , https://www.morphllm.com/mcp-apps |
| **mcp-ui** | C wrapping A (HTML, external URL, Remote DOM) | Community predecessor to MCP Apps; TS/Ruby/Python SDKs | Historical; follow MCP Apps instead | https://mcpui.dev/guide/apps-sdk |
| **OpenAI Apps SDK** | C wrapping A | Tool returns `structuredContent` (model sees), `content` (narration), `_meta` (widget only); `_meta["openai/outputTemplate"]` → `ui://` resource; widget reads `window.openai.toolOutput` | Same three-payload split we should adopt: short text for the model, big payload for the UI | https://developers.openai.com/apps-sdk/build/chatgpt-ui , https://alpic.ai/blog/inside-openai-s-apps-sdk-how-to-build-interactive-chatgpt-apps-with-mcp |
| **A2UI (Google)** | B | JSONL messages: `surfaceUpdate`, `dataModelUpdate`, `beginRendering`, `deleteSurface`; client-defined catalog maps component types to native widgets; progressive by design | A clean spec for "UI as data"; heavier than we need at first but the data model/catalog split is the right shape for forms and dashboards | https://a2ui.org/specification/v0.8-a2ui/ , https://a2ui.org/reference/messages/ , https://developers.googleblog.com (via https://sdtimes.com/ai/google-launches-a2ui-project-to-enable-agents-to-build-contextually-relevant-uis/) |
| **AG-UI (CopilotKit)** | Event protocol | Typed SSE events: messages, tool calls, state patches, lifecycle | We already have an equivalent (OpenCode SSE). Not needed | https://www.copilotkit.ai/blog/introducing-ag-ui-the-protocol-where-agents-meet-users |
| **json-render (Vercel Labs)** | B | Zod-defined catalog of components and actions; LLM emits JSON constrained to it; streaming progressive render; React/Vue/Svelte renderers; Apache-2.0; 13k+ stars since Jan 2026 | Strong candidate for our Layer 2 "UI spec" renderer instead of inventing one | https://github.com/vercel-labs/json-render , https://www.infoq.com/news/2026/03/vercel-json-render |
| **thesys C1** | B as a hosted LLM API | OpenAI-compatible endpoint that returns a typed UI spec; self-heals invalid output; catalog: charts, tables, forms, cards, slides, reports | Paid API; conflicts with free-first. Learn from the catalog | https://docs.thesys.dev/guides/what-is-thesys-c1 |
| **assistant-ui / CopilotKit** | C | React chat primitives with tool UIs, generative UI slots, human-in-the-loop | Reference only; we own our chat | https://www.copilotkit.ai/blog/generative-ui-explained-how-agents-now-ship-their-own-interfaces |

---

## 4. Library catalog (client-side rendering candidates)

Columns: size (gz, approximate), license, maturity, how it runs (client React / sandboxed iframe / worker / sandbox VM), notes. **Avoid** means a license or weight problem for a free product.

### 4.1 Charts

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **Vega-Lite** (+ vega, vega-embed) | ~85 KB vega-lite + ~170 KB vega (**verify**) | BSD-3 | Very high | Client, can render in worker to SVG/canvas | Declarative JSON with a published JSON Schema → validate with Ajv before render; LLMs know it well; best "spec" chart library. https://graphy.app/blog/vega-lite-alternatives , https://tessl.io/registry/testland/vega-spec-validator |
| **Observable Plot** | 83–92 KB | ISC | High | Client | Concise JS API, not JSON; d3-based; great defaults. https://tanstack.com/charts/latest/docs/comparison |
| **Apache ECharts** | 153–173 KB (tree-shaken less) | Apache-2.0 | Very high | Client, canvas | JSON option object (declarative!), huge chart zoo (sankey, treemap, gauge, 3D via extension). Heavier. https://tanstack.com/charts/latest/docs/comparison |
| **Chart.js** | 45–58 KB | MIT | Very high | Client, canvas | Smallest; JSON config; limited chart types. |
| **Recharts** | ~136 KB (v3) | MIT | High | Client React | JSX components, not a spec; what Claude Artifacts uses. https://mcp.depscope.dev/pkg/npm/recharts |
| **Plotly.js** | ~1 MB+ | MIT | High | Client | Too heavy for chat; fine inside an iframe artifact. |
| **Mermaid charts** (pie, xychart, quadrant, gantt, timeline) | part of Mermaid | MIT | Medium | Client | Free if Mermaid is already loaded; ugly but zero extra cost. |

- **Pick:** Vega-Lite for `chart` fences and `show_chart` (spec in, validation, SVG out), Chart.js as a tiny fallback for sparkline-class visuals, ECharts only inside artifacts.

### 4.2 Diagrams and graphs

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **Mermaid** | Large: ~2.5–3 MB minified across lazily loaded diagram chunks (**verify** on bundlephobia) | MIT | Very high | Client (DOM-dependent; worker not supported) | Flowchart, sequence, class, state, ER, gantt, git graph, mindmap, timeline, C4, pie, xychart, sankey, block, architecture. LLM syntax error rate ~30% raw; validation + repair loops reach ~95%. https://microsoft.github.io/genaiscript/blog/mermaid-syntax-errors/ , https://github.com/probelabs/maid |
| **D2 (d2.js)** | WASM, several MB (**verify**) | MPL-2.0 | Medium | Web Worker + WASM | Cleaner language than Mermaid, dagre/ELK layouts, SVG out; runs in a worker so it never blocks the UI. https://cdn.jsdelivr.net/npm/@terrastruct/d2@0.1.33/README.md , https://play.d2lang.com |
| **Graphviz (@hpcc-js/wasm)** | ~388 KB compressed | Apache-2.0 (wasm wrapper); Graphviz EPL | High | Worker + WASM | DOT is the most LLM-reliable graph language; best for dependency graphs and call graphs. https://www.jsdelivr.com/package/npm/@hpcc-js/wasm |
| **React Flow (@xyflow/react)** | ~50–60 KB (**verify**) | MIT | Very high | Client React | Node/edge canvas with drag, zoom, custom nodes; needs a layout lib (dagre/ELK) for auto-layout. Right base for editable flow/pipeline/DAG UIs. https://github.com/xyflow/xyflow |
| **ELK.js / dagre** | ELK ~1 MB (worker), dagre ~30 KB | EPL-2.0 / MIT | High | Worker | Layout engines for React Flow. |
| **Markmap** | ~ small + d3 | MIT | High | Client | Markdown headings/lists → zoomable mind map; perfect zero-cost fence. https://markmap.js.org/docs/markmap |
| **Excalidraw** | npm unpacked 46.8 MB; runtime chunk ~1 MB+ gz (**verify**) | MIT | Very high | Client React (heavy) | Hand-drawn editable whiteboard; `.excalidraw` JSON is simple for LLMs; many Excalidraw MCP servers exist. https://npmjs.com/@excalidraw/excalidraw , https://docsearch.algolia.com/mcp/docs/repo/excalidraw/excalidraw-mcp |
| **tldraw** | ~484 KB | **tldraw license** (key required in production; watermark on hobby; paid commercial) | Very high | Client React | Best agent-on-canvas starter kit exists, but the license conflicts with free-first. **Avoid for now.** https://tldraw.dev/legal/tldraw-license , https://tldraw.dev/starter-kits/agent |
| **drawDB / ChartDB** | apps, not libs | AGPL / AGPL (**verify**) | Medium | Separate app | Browser ERD editors; use as inspiration or link-out, not embed. https://www.chartdb.io/blog/dbdiagram-vs-drawio-vs-chartdb |
| **gitgraph.js** | — | MIT | Archived 2024 | — | Dead; use Mermaid `gitGraph`. https://github.com/nicoespeon/gitgraph.js |

- **Pick:** Mermaid first (coverage), Graphviz WASM second (reliability for graphs), React Flow for anything editable, Excalidraw for freeform editable, D2 as an opt-in for nicer output.

### 4.3 Canvas, vector, whiteboard, design

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **Plain SVG** | 0 | — | — | Client (sanitized) or `<img>` | The agent writes SVG; we sanitize (DOMPurify ~7 KB) or render as `<img>`. Highest breadth per byte: icons, logos, posters, charts, diagrams, illustrations. |
| **Konva / react-konva** | ~50 KB | MIT | High | Client canvas | Shapes, transformers (handles), hit testing: the fastest route to a simple Figma-like editor. |
| **Fabric.js** | ~100 KB | MIT | High | Client canvas | Object model with selection/transform; older API. |
| **Paper.js** | ~100 KB | MIT | High | Client canvas | Vector boolean ops, paths; good for illustration tooling. |
| **Excalidraw / tldraw** | see 4.2 | | | | |
| **Penpot** | app | MPL-2.0 | High | Separate app | Not embeddable (iframe embedding discussed, security concerns); treat as an export target (SVG/penpot file), not a renderer. https://community.penpot.app/t/ability-to-embed-penpot-prototypes/304 |
| **DOMPurify** | ~7 KB | Apache-2.0/MPL | Very high | Client | Mandatory before inline SVG/HTML from the agent. |

### 4.4 Math, music, science notation

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **KaTeX** | ~250 KB bundle incl. fonts, ~1 ms per equation, synchronous | MIT | Very high | Client | `remark-math` + `rehype-katex` drop into our react-markdown. https://cuberoot.me/dev/language/katex |
| **MathJax** | much larger | Apache-2.0 | Very high | Client | Only if we need rare TeX; skip. |
| **abcjs** | ~250 KB (**verify**) | MIT | High | Client | ABC text → SVG sheet music + optional MIDI playback; ABC is compact and LLM-friendly. https://docs.abcjs.net/visual/overview |
| **VexFlow** | ~300 KB (**verify**) | MIT | High | Client | Programmatic engraving to SVG/canvas; use via `vexabc` or EasyScore. |
| **WaveDrom** | small | MIT | Medium | Client | Digital timing diagrams from JSON; hardware category. |
| **3Dmol.js / NGL** | medium | BSD-3 / MIT | Medium | Client WebGL | Molecule viewers for chemistry use cases. |
| **JSXGraph / Desmos API** | medium / hosted | LGPL/MIT dual / proprietary | High | Client | Interactive geometry and function plotting; Desmos API needs a key. |

### 4.5 Maps and GIS

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **Leaflet** | ~42 KB, zero deps | BSD-2 | Very high | Client | Raster tiles, GeoJSON overlays; smallest. https://www.geoapify.com/map-libraries-comparison-leaflet-vs-maplibre-gl-vs-openlayers-trends-and-statistics/ |
| **MapLibre GL JS** | ~210 KB | BSD-2 | Very high | Client WebGL | Vector tiles, 3D terrain; Mapbox GL v2+ is proprietary, so MapLibre is the open fork. |
| **Tiles** | — | — | — | Network | Need a tile source: OpenStreetMap raster (usage policy), OpenFreeMap/Protomaps vector (free). Egress allow-lists in cloud must include the tile host. |

### 4.6 3D

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **three.js** | ~150 KB core gz (462 KB min) | MIT | Very high | Client WebGL, iframe recommended | The agent writes a scene; load in the artifact iframe, not in the chat chunk. https://www.pkgpulse.com/guides/threejs-vs-react-three-fiber-vs-babylonjs-3d-webgl-2026 |
| **@react-three/fiber + drei** | ~50 KB + three | MIT | Very high | Client React | For our own 3D viewers (glTF/STL preview). |
| **model-viewer** | ~200 KB | Apache-2.0 | High | Web component | `<model-viewer src=x.glb>`: zero-code glTF preview for files the agent produces. |
| **OpenSCAD WASM / JSCAD** | large | GPL / MIT | Medium | Worker | Parametric CAD from code; JSCAD is MIT. |

### 4.7 Code: editors, highlighting, diffs

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **Shiki** | core small; grammars/themes lazy; JS regex engine avoids the Oniguruma WASM | MIT | Very high | Client or server | VS Code-grade highlighting; we have a lighter `src/lib/highlight` already. https://shiki.style/guide/ |
| **CodeMirror 6** | ~50 KB base, grows per language | MIT | Very high | Client | Editable code in the panel; Replit and Sourcegraph migrated to it from Monaco. https://sourcegraph.com/blog/migrating-monaco-codemirror , https://replit.com/blog/codemirror |
| **Monaco** | ~1–2.4 MB | MIT | Very high | Client | **Avoid**: weight. |
| **@git-diff-view/react** | medium | MIT | High | Client React | GitHub-like split/unified diff with lowlight or shiki highlighter. https://npmjs.com/package/@git-diff-view/react |
| **react-diff-view** | medium | MIT | High | Client React | Alternative diff renderer with hunk widgets (comments inline). |
| **diff / diff-match-patch** | small | BSD / Apache | High | Client | Prose redlines (word-level diff) for writing and legal use cases. |

### 4.8 Terminals and logs

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **xterm.js (@xterm/xterm)** | ~64 KB | MIT | Very high | Client canvas/WebGL | OpenCode has PTY endpoints; the `terminal` capability is "later" in ARCHITECTURE.md. https://depscope.dev/pkg/npm/xterm |
| **ansi-to-html / anser** | tiny | MIT | High | Client | Colorize tool `bash` output without a full terminal. |

### 4.9 Tables and spreadsheets

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **TanStack Table** | ~15 KB headless | MIT | Very high | Client React | Sorting, filtering, grouping; we render cells. Pair with `@tanstack/react-virtual` for 100k rows. https://licenses.dev/npm/%40tanstack%2Freact-table/8.21.3 |
| **Glide Data Grid** | ~100 KB (**verify**) | MIT | High | Client canvas | Spreadsheet feel, millions of cells, editable. https://grid.glideapps.com |
| **Handsontable** | — | **Proprietary** (non-commercial or paid since 6.2.2) | — | — | **Avoid.** https://handsontable.com/docs/software-license/ |
| **SheetJS (xlsx)** | ~400 KB community | Apache-2.0 | Very high | Client | Read/write .xlsx; the agent can emit real spreadsheets. |
| **Papaparse** | ~20 KB | MIT | Very high | Client/worker | CSV parse in a worker. |

### 4.10 Documents, slides, PDF

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **reveal.js** | ~100 KB | MIT | Very high | iframe | Markdown → slides inside a sandboxed iframe. |
| **Marp (marp-core)** | medium | MIT | High | Server or client | Markdown → HTML/PDF/PPTX slides; CLI fits the sandbox. https://raw.githubusercontent.com/marp-team/marp/main/README.md |
| **pdf.js (pdfjs-dist)** | ~122 KB + worker | Apache-2.0 | Very high | Client + worker | Only needed for inline thumbnails; browser viewer already handles the Preview tab. https://mcp.depscope.dev/pkg/npm/pdfjs-dist |
| **react-markdown + remark/rehype** | present | MIT | Very high | Client | Add `remark-math`, `rehype-katex`, a fence plugin, footnotes, task lists, callouts. |
| **Tiptap / ProseMirror** | ~150 KB | MIT | Very high | Client | Rich-text editing for a ChatGPT-Canvas-style document mode. |
| **docx / pptx generation** | sandbox-side | MIT | High | Sandbox | `docx`, `pptxgenjs`, LibreOffice headless in the sandbox produce files the user downloads. |

### 4.11 Images, generative art, media

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **p5.js** | ~1 MB | **LGPL-2.1** | Very high | iframe only | Fine when loaded as a separate script in the artifact iframe (dynamic linking); do not bundle into our app. https://p5js.org/copyright/ |
| **Lottie (lottie-web / dotLottie)** | ~60–250 KB | MIT | Very high | Client | JSON animations the agent can emit or edit. |
| **Tone.js** | ~150 KB | MIT | High | iframe/client | Synths and sequencing from a declarative pattern; LLMs can write it. https://soundingfuture.com/tools/tone.js |
| **WaveSurfer.js** | ~30 KB | BSD-3 (**verify**; an older "about" page cites CC-BY 3.0) | High | Client | Waveform display for audio files the agent produced. https://wavesurfer.xyz/about |
| **Remotion** | sandbox-side | **Remotion license** (free for individuals and small companies; company license for larger for-profits) | High | Sandbox render | Programmatic video; render in the sandbox to MP4 with headless Chromium (heavy on 1 vCPU). https://remotion.dev/license |
| **ffmpeg.wasm** | ~30 MB wasm | LGPL/MIT | Medium | Worker | Client-side transcode; too heavy for chat, fine as explicit tool. |
| **Sharp / ImageMagick** | sandbox | Apache / ImageMagick | High | Sandbox | Image processing as files. |

### 4.12 In-browser compute and notebooks

| Library | Size | License | Maturity | Runs | Notes |
|---|---|---|---|---|---|
| **Pyodide** | ~10 MB first load (**verify**); pyodide-pack shrinks apps | MPL-2.0 | High | Worker + WASM | Python in the browser. For us, Python runs in the sandbox instead; Pyodide only matters for a shared/read-only page. https://pyodide-pack.pyodide.org |
| **DuckDB-WASM** | 68 KB JS + 2.5 MB brotli wasm | MIT | High | Worker + WASM | Analytical SQL over CSV/Parquet in the browser; explicit opt-in only. https://duckdb.org/2021/10/29/duckdb-wasm |
| **sql.js** | ~1 MB wasm | MIT | High | Worker | SQLite in the browser; smaller than DuckDB. |
| **JupyterLite** | large app | BSD-3 | High | iframe | Full notebook UI in the browser; embed as an iframe for `.ipynb` editing. https://blog.jupyter.org/jupyterlite-jupyter-%EF%B8%8F-webassembly-%EF%B8%8F-python-f6e2e41ab3fa |
| **marimo WASM** | large | Apache-2.0 | Medium | iframe | Reactive Python notebooks that run in the browser; shareable static HTML. https://www.simonwillison.net/2024/Jun/29/marimo-app |
| **nbformat rendering** (own) | small | — | — | Client | Render `.ipynb` outputs (text, images, HTML, Vega) without executing. Cheap and useful. |

### 4.13 Sandboxes and live previews

| Option | Cost | License | Runs | Notes |
|---|---|---|---|---|
| **srcdoc iframe, `sandbox="allow-scripts"`, no `allow-same-origin`** | 0 | — | Browser | What `file-preview.tsx` does. The inner frame inherits the parent's CSP header; a strict guard page CSP (`default-src 'none'; script-src 'unsafe-inline' https://cdnjs...; style-src 'unsafe-inline'`) further limits it. No storage, no cookies, opaque origin. https://paulkinlan--94679278f65111f09bbf42dde27851f2.web.val.run/double-iframe.html |
| **Separate preview origin** (e.g. `*.preview.syrup...`) | Low | — | Browser + a tiny host | Full site isolation like Claude's `claudeusercontent.com`; needed before we allow `allow-same-origin` for things like `localStorage`. |
| **esm.sh / jsdelivr imports inside the iframe** | 0 | — | CDN | Lets agent-written React/TSX run with no bundler: `<script type="module">import React from "https://esm.sh/react@19"`; Babel standalone (~300 KB) for JSX in-browser, or have the agent write plain JS/htm. https://github.com/FallingSnow/esm.sh |
| **Sandpack** | bundler hosted by CodeSandbox (self-hostable `bundlerURL`) | Apache-2.0 (sandpack-react) | iframe | Live React/Vue/vanilla with npm deps and HMR; relies on a third-party bundler CDN unless self-hosted. https://docsearch.algolia.com/mcp/docs/repo/codesandbox/sandpack |
| **WebContainers** | Commercial license for for-profit production | Proprietary | Browser | **Avoid.** https://webcontainers.io/enterprise |
| **Vercel Sandbox published ports** | Already paying for the sandbox | — | Cloud | Up to 4 ports declared at `Sandbox.create({ ports })`, `sandbox.domain(port)` → `https://*.vercel.run`, HTTPS only. Declare ports up front (3000, 5173, 8080, 4173). https://computesdk.com/blog/how-to-run-your-first-vercel-sandbox , https://forums.basehub.com/vercel/sandbox/2 |
| **Local mode port proxy** | 0 | — | Local | Proxy `http://127.0.0.1:<port>` through our server (Host check already exists in `src/proxy.ts`). |

### 4.14 Planning, time, organization

| Library | Size | License | Maturity | Notes |
|---|---|---|---|---|
| **frappe-gantt** | ~30 KB | MIT | Medium | Simple Gantt from JSON tasks. https://libraries.io/npm/frappe-gantt |
| **vis-timeline** | ~300 KB | Apache-2.0 / MIT dual | High | Zoomable timelines and groups. https://cdn.jsdelivr.net/npm/vis-timeline@8.5.4/README.md |
| **FullCalendar** | ~100 KB standard | MIT (standard); Premium paid | Very high | Month/week views; stick to standard plugins. https://fullcalendar.io/license |
| **dnd-kit** | ~20 KB | MIT | Very high | Kanban/sortable boards; we build the board. |
| **Mermaid gantt/timeline** | included | MIT | Medium | Free with Mermaid; non-interactive. |

### 4.15 Specialized viewers

| Library | Size | License | Notes |
|---|---|---|---|
| **speedscope** | ~300 KB app | MIT | Flame graphs from 15+ profiler formats; stable file format to target; load via `window.speedscope.loadFileFromBase64()` in an iframe. https://github.com/jlfwong/speedscope , https://tessl.io/registry/tessl/npm-speedscope/files/docs/file-format.md |
| **Scalar API Reference** | large | MIT | Interactive OpenAPI docs with built-in HTTP client; embeddable React component. https://scalar.com/products/api-references/integrations/react |
| **webtreemap / d3-treemap** | small | Apache / ISC | Bundle-size treemaps from `source-map-explorer` or esbuild metafile. |
| **react-json-view-lite** | tiny | MIT | Collapsible JSON. |
| **@uiw/react-md-editor / Milkdown** | medium | MIT | Markdown editors for round-trip docs. |

---

## 5. Taxonomy: where non-text output helps, by domain

Legend. **Emits:** `fence:x` = fenced block in markdown; `file:*.ext` = writes a workspace file; `tool:name` = structured tool call; `code` = writes runnable code; `spec` = declarative JSON. **Runs:** client = React in the chat/panel; iframe = sandboxed srcdoc; worker = Web Worker/WASM; VM = Vercel Sandbox or local process. **Interactivity:** static → explore (zoom/sort/hover) → edit → round-trip (user edit returns to the agent). **Diff:** S ≤ 2 days, M ≤ 2 weeks, L > 2 weeks. **Speed:** what it costs the chat.

### 5.1 Software engineering: code and diffs

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Multi-file diff review with keep/reject per hunk (Zed-style) | engine `patch`/snapshot | @git-diff-view/react, hunk actions that prefill "revert hunk X" or run `git checkout -p` via tool | client | round-trip | M | Lazy chunk; render per file on expand |
| Inline "before/after" for one edit tool call | ToolPart `edit` metadata | word-level diff component | client | explore | S | Tiny |
| Syntax-highlighted code with line links to Files tab | fence:lang | existing highlighter; link to `FileLink` | client | explore | S | Already fast |
| Editable code block ("tweak and send back") | fence:lang | CodeMirror 6 lazily | client | round-trip (prefill composer with edited block) | M | ~50 KB chunk on first edit |
| Symbol outline / file structure tree | tool:outline (LSP via OpenCode) | tree component | client | explore (click → open file) | S | Tiny |
| Call graph / import graph | tool:graph → DOT | Graphviz WASM in worker | worker | explore | M | 388 KB chunk, worker |
| Type/AST explanation | fence:mermaid classDiagram or DOT | Mermaid / Graphviz | client/worker | static | S | Mermaid chunk |
| Regex explainer and tester | fence:regex or tool | small custom component (railroad via `regexp-tree`) | client | edit | M | Small |
| Package/bundle size treemap | tool reading esbuild metafile/source-map-explorer JSON | d3-treemap | client | explore | M | Small |

### 5.2 Software engineering: tests, logs, CI

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Test run summary (pass/fail/skip, durations) | tool:run_tests parses JUnit/TAP/vitest JSON | status table + bar | client | explore (filter, click → file:line) | M | Small |
| Coverage heatmap by file | tool parses lcov | treemap/table | client | explore | M | Small |
| Colored terminal output | `bash` tool output | ansi-to-html | client | static | S | Tiny |
| Full interactive terminal | OpenCode PTY | xterm.js | client | round-trip (user types) | M | 64 KB chunk |
| Log viewer with level filter and search | `bash`/`read` output | virtualized list | client | explore | M | Small |
| Flaky test / timing trend | tool:history | Vega-Lite | client | explore | S | Vega chunk |
| Error with stack → clickable frames | tool output parsing | list with FileLinks | client | explore | S | Tiny |
| CI pipeline status | tool (gh CLI) | step DAG via React Flow or Mermaid | client | explore | M | Medium |

### 5.3 Software engineering: architecture, APIs, data model

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Architecture / component diagram | fence:mermaid (flowchart, C4, architecture) or fence:d2 | Mermaid / D2 | client/worker | static → edit (open in Excalidraw) | S | Mermaid chunk |
| Sequence diagram of a request | fence:mermaid sequenceDiagram | Mermaid | client | static | S | — |
| State machine | fence:mermaid stateDiagram or XState JSON → React Flow | Mermaid / React Flow | client | explore | S/M | — |
| ERD from schema (Drizzle/Prisma/SQL) | tool:erd → fence:mermaid erDiagram or DBML | Mermaid / custom React Flow ERD | client | explore → edit | M | — |
| Dependency graph (packages, modules) | tool → DOT | Graphviz WASM | worker | explore | M | worker |
| OpenAPI explorer | file:openapi.yaml | Scalar in iframe | iframe | explore (try requests against sandbox port) | M | Heavy, panel only |
| API request/response examples | fence:http / fence:json | pretty JSON tree | client | explore | S | Tiny |
| Infra diagram (cloud resources) | fence:mermaid architecture / D2 | Mermaid / D2 | client/worker | static | S | — |
| Decision records / trade-off matrix | markdown table | existing tables, optional "score" bars | client | static | S | — |

### 5.4 Software engineering: performance and runtime

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| CPU flame graph | tool:profile → speedscope JSON | speedscope in iframe | iframe | explore | M | Heavy chunk, panel |
| Memory over time, latency histogram | tool → spec | Vega-Lite | client | explore | S | — |
| Network/waterfall | HAR file | custom waterfall (bars) | client | explore | M | — |
| Lighthouse / Web Vitals report | tool runs lighthouse in sandbox → JSON | score gauges + table | client | explore | M | Sandbox CPU heavy |
| Benchmark comparison | tool output | bar chart with error bars | client | static | S | — |
| Database query plan | `EXPLAIN` JSON | tree view | client | explore | M | — |

### 5.5 Software engineering: git and project history

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Commit graph / branches | tool:git_log → fence:mermaid gitGraph | Mermaid | client | static | S | — |
| Blame / ownership heatmap | tool | table | client | explore | M | — |
| PR summary card (files, +/-, checks) | tool (gh) | card component | client | explore | S | — |
| Release timeline / changelog | tool → spec | vis-timeline or Mermaid timeline | client | explore | S | — |
| Changes panel with per-file revert | engine snapshot diff | existing panel + actions | client | round-trip | M | Exists in part |

### 5.6 Web and UI development: live previews

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Single-file HTML/CSS/JS preview | fence:html or file:*.html | sandboxed srcdoc iframe (exists) | iframe | explore → edit (CodeMirror) → round-trip | S | None on chat |
| Single-file React component preview | file:*.tsx with esm.sh imports, or Babel standalone in iframe | iframe | iframe | explore | M | 300 KB Babel inside iframe only |
| Running dev server preview | agent starts `npm run dev` | iframe to published sandbox port / local proxy | VM | round-trip (element picker → "change this") | M | No chat cost; sandbox CPU |
| Responsive views side by side (390/768/1280) | same as above | multiple iframes with scale | VM | explore | M | 3 iframes; panel only |
| Component gallery / states matrix | code (story-like file) | iframe | iframe | explore | M | — |
| Design tokens / palette / type scale | spec JSON or CSS vars | swatch and specimen component | client | edit → round-trip (color picker writes back) | S | Tiny |
| Screenshot of the preview for the model (vision) | tool:screenshot (Playwright in sandbox) | image part | VM | static | M | Sandbox CPU; Playwright is heavy on 1 vCPU |
| Element picker → prompt | preview iframe + postMessage bridge script injected by us | overlay | iframe | round-trip | M | — |
| Accessibility audit overlay | axe-core in iframe | list + highlights | iframe | explore | M | — |

### 5.7 Data and analytics

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Bar/line/area/scatter/pie/histogram | fence:vega-lite or tool:show_chart | Vega-Lite (Ajv-validated) | client | explore (hover, zoom) → edit (field pickers) | S | ~250 KB chunk first use |
| Sparklines in tables | spec | tiny inline SVG (own) | client | static | S | 0 |
| Large data table (sort/filter/paginate) | file:*.csv / tool:show_table | TanStack Table + virtual | client | explore → edit → round-trip (cell edits as patch) | M | ~30 KB |
| Pivot table | tool with grouped data | TanStack grouping | client | explore | M | — |
| SQL results | tool:run_sql (sandbox sqlite/pg) | table + chart toggle | client | explore | M | — |
| Dashboard (several charts + filters) | spec (json-render-style layout) | grid of Vega-Lite + controls | client | explore | L | Heavy; panel only |
| Notebook outputs (.ipynb) | file:*.ipynb | own nbformat renderer (text, images, HTML, Vega) | client | static → edit via JupyterLite iframe | M | — |
| Statistical summary (describe) | tool | table with mini histograms | client | static | S | — |
| Geo data (GeoJSON) | file:*.geojson | Leaflet | client | explore | M | 42 KB + tiles |
| Correlation heatmap, box plots | spec | Vega-Lite | client | explore | S | — |
| Browser-side SQL over CSV | file | DuckDB-WASM (opt-in) | worker | round-trip (queries) | L | 2.5 MB wasm, explicit |

### 5.8 Data engineering and ML

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Pipeline / DAG (Airflow, dbt lineage) | spec nodes/edges | React Flow + ELK | client | explore → edit | M | ELK in worker |
| Schema lineage, column mapping | spec | React Flow | client | explore | M | — |
| Data quality report | tool | table + bars | client | explore | S | — |
| Training curves, confusion matrix | spec | Vega-Lite | client | explore | S | — |
| Model architecture | fence:mermaid / DOT | Mermaid / Graphviz | client/worker | static | S | — |
| Embedding scatter (2D projection) | spec | Vega-Lite or regl-scatter for 100k points | client | explore | M | — |

### 5.9 Product and project management

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Roadmap / Gantt | fence:mermaid gantt (static) or file:plan.json → frappe-gantt | Mermaid / frappe-gantt | client | static → edit (drag dates) → round-trip (file) | S/M | Small |
| Kanban board | file:board.json or tool | dnd-kit board | client | edit → round-trip | M | Small |
| User flow / journey map | fence:mermaid flowchart or Excalidraw file | Mermaid / Excalidraw | client | static → edit | S/M | — |
| PRD / spec document | file:*.md | markdown with callouts, TOC | client | edit (markdown editor) → round-trip | S | — |
| Prioritization matrix (impact/effort) | spec | Vega-Lite scatter with labels or Mermaid quadrantChart | client | explore | S | — |
| OKR / metrics tree | spec | Markmap or React Flow | client | explore | S | — |
| Timeline of releases | spec | vis-timeline | client | explore | S | — |
| Estimates table with totals | markdown table | table with computed footer | client | static | S | — |
| Stakeholder / RACI matrix | markdown table | table | client | static | S | — |

### 5.10 UI/UX design

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Low-fi wireframe | fence:svg or Excalidraw file (wireframe library) | sanitized SVG / Excalidraw | client | static → edit | S/M | — |
| Hi-fi mockup | file:*.html (Tailwind via CDN) | iframe | iframe | explore → element picker | S | — |
| Clickable prototype (multi-screen) | file:*.html with hash routes | iframe | iframe | explore | M | — |
| Simple Figma-like editor (frames, rects, text, images, align, export SVG/PNG) | file:design.json (own schema) | own Konva/SVG editor | client | edit → round-trip (agent reads JSON) | L | ~60 KB chunk |
| Design system tokens, components sheet | spec | swatch/type/spacing specimens | client | edit | S | — |
| Flow between screens | React Flow with screenshot nodes | React Flow | client | explore | M | — |
| Variants side by side (Replit canvas idea) | several files | multiple iframes in a grid | iframe | pick → round-trip | M | Panel only |
| Icon set | fence:svg × n | SVG grid | client | static | S | — |
| Export to Figma/Penpot | file:*.svg | download | — | — | S | — |

### 5.11 Graphic design, illustration, art

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Logo, icon, badge | fence:svg | DOMPurify + inline SVG | client | static → edit (SVG source editor) | S | 0 |
| Poster, social card, OG image | file:*.html or svg | iframe / SVG; export PNG via sandbox (resvg/Playwright) | iframe/VM | static | S/M | — |
| Color palette, gradients | spec | swatches with contrast ratios | client | edit → round-trip | S | 0 |
| Typography specimen | spec | specimen component with Google Fonts | client | static | S | Font loads |
| Generative art sketch | code (p5.js) | iframe | iframe | explore (seed/params UI) | S | Inside iframe only |
| Pattern / texture (SVG filters, CSS) | fence:svg / fence:html | SVG/iframe | client/iframe | static | S | — |
| Raster image generation | provider image model via tool | image part | — | static | M | Network |
| Image editing (crop, resize, filters) | sandbox (sharp) | before/after slider | VM | explore | M | — |
| Pixel art / sprite | spec grid | canvas | client | edit | M | — |

### 5.12 Motion and video

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| CSS/SVG animation preview | fence:html / fence:svg (SMIL/CSS) | iframe/SVG | iframe | explore (play/pause/scrub) | S | — |
| Lottie animation | file:*.json | lottie-web | client | explore | S | 60 KB chunk |
| Storyboard | markdown + SVG frames grid | grid component | client | static | S | — |
| Animation timeline / keyframes editor | spec | own timeline UI | client | edit → round-trip | L | — |
| Programmatic video (Remotion) | code | render in sandbox → mp4; preview via Remotion Player in iframe | VM/iframe | explore | L | 1 vCPU render is slow; license flag |
| GIF/MP4 from frames | sandbox ffmpeg | video element | VM | static | M | — |
| Motion spec for devs (easing, durations) | spec | easing curve previews | client | static | S | — |

### 5.13 Audio and music

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Sheet music | fence:abc | abcjs → SVG | client | explore (playback via abcjs synth) | S | ~250 KB chunk |
| Chord chart / tab | fence:abc or custom text | abcjs / monospace | client | static | S | — |
| Synth / sequencer sketch | code (Tone.js) | iframe | iframe | explore | S | Inside iframe |
| Waveform of a generated file | file:*.wav/mp3 | WaveSurfer | client | explore | S | 30 KB |
| Drum pattern grid | spec | step grid + Tone.js | client | edit → round-trip | M | — |
| MIDI preview | file:*.mid | Tone.js + @tonejs/midi | client | explore | M | — |
| Podcast/audio summary | TTS provider via tool | audio element | — | static | M | Network |

### 5.14 Writing and publishing

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Long document with TOC, footnotes, callouts | file:*.md | react-markdown + plugins | client | edit (Milkdown/Tiptap) → round-trip | S/M | — |
| Prose redline (suggested edits) | tool:diff_text | word-level diff view | client | accept/reject → round-trip | M | Small |
| Slides | file:slides.md | reveal.js or Marp in iframe; export PDF/PPTX in sandbox | iframe/VM | explore | M | — |
| Citations / bibliography | spec (CSL JSON) | formatted list via citeproc-js | client | static | M | — |
| Outline / structure tree | markdown headings | Markmap | client | explore | S | — |
| Reading-time, tone, readability stats | tool | stat tiles | client | static | S | — |
| E-book / PDF export | sandbox (pandoc/weasyprint) | download | VM | — | M | — |
| Translation side-by-side | two texts | two-column aligned view | client | static | S | — |

### 5.15 Education and learning

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Quiz / flashcards | spec via tool:ask_form or file:quiz.json | own form component | client | round-trip (answers → agent grades) | M | Small |
| Step-by-step walkthrough with checkpoints | markdown + tool:ask_form | stepper | client | round-trip | M | — |
| Interactive explainer (sliders → graph) | code or spec (Vega-Lite params) | Vega-Lite with bound inputs | client | explore | S | — |
| Timeline (history) | spec | vis-timeline | client | explore | S | — |
| Concept map | fence:markmap | Markmap | client | explore | S | — |
| Pronunciation/audio | TTS tool | audio | — | static | M | — |
| Code exercise with tests | file + run_tests tool | editor + results | client/VM | round-trip | M | — |

### 5.16 Math and science

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Equations | `$…$`, `$$…$$` | KaTeX via remark-math | client | static | S | 250 KB cached once |
| Function plots | spec | Vega-Lite (sampled) or JSXGraph | client | explore | S | — |
| Geometry constructions | code (JSXGraph) | iframe | iframe | explore | M | — |
| Molecule 3D | file:*.pdb/*.mol | 3Dmol.js | client WebGL | explore | M | Medium chunk |
| Chemical structure 2D | SMILES → tool (RDKit in sandbox) → SVG | SVG | VM | static | M | — |
| Circuit diagram | fence:svg or CircuitJS-like iframe | SVG / iframe | client/iframe | static → explore | M | — |
| Physics simulation | code (matter.js / p5) | iframe | iframe | explore | S | Inside iframe |
| Unit tables, constants | markdown | table | client | static | S | — |
| Statistical test results | tool | table + distribution plot | client | static | S | — |
| Timing / signal diagrams | fence:wavedrom | WaveDrom | client | static | S | Small |

### 5.17 Finance and business

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Spreadsheet-like model (editable cells, formulas) | file:*.xlsx or csv | Glide Data Grid + HyperFormula (GPL/commercial, **avoid**) or own simple formulas | client | edit → round-trip | L | ~100 KB |
| Cash-flow / P&L chart | spec | Vega-Lite | client | explore | S | — |
| Scenario comparison | table + chart | TanStack + Vega-Lite | client | explore | S | — |
| Invoice / quote document | file:*.html | iframe → PDF in sandbox | iframe/VM | static | S | — |
| KPI tiles | spec | stat tiles with sparklines | client | static | S | 0 |
| Pricing page mock | file:*.html | iframe | iframe | explore | S | — |
| Loan/amortization table | tool compute | virtualized table | client | explore | S | — |
| Candlestick chart | spec | Vega-Lite or ECharts | client | explore | S | — |

### 5.18 Marketing and growth

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Landing page | file:*.html | iframe + device widths | iframe | element picker → round-trip | S | — |
| Email template | file:*.html | iframe (email-safe CSS) | iframe | explore | S | — |
| Ad creative variants | several svg/html | grid of iframes | iframe | pick → round-trip | M | — |
| Funnel chart | spec | Vega-Lite / ECharts funnel | client | explore | S | — |
| A/B test results with CI bars | spec | Vega-Lite | client | explore | S | — |
| Social post previews (X, LinkedIn cards) | spec | own preview components | client | edit | M | — |
| SEO audit table | tool | table | client | explore | S | — |
| Content calendar | spec | FullCalendar standard | client | edit → round-trip | M | 100 KB |

### 5.19 Operations and workflows

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| SOP / process flowchart | fence:mermaid | Mermaid | client | static → edit (Excalidraw) | S | — |
| Checklist with progress | markdown task list | interactive checkboxes → round-trip (write back to file) | client | round-trip | S | 0 |
| Form / wizard for missing inputs | tool:ask_form (schema) | own form renderer (json-render or own) | client | round-trip (answers become the next user message) | M | Small |
| Approval card (yes/no/with note) | OpenCode `question` / permission | existing + richer card | client | round-trip | S | — |
| Calendar / schedule | spec | FullCalendar | client | edit | M | — |
| Org chart | spec | Graphviz / React Flow | worker/client | explore | S | — |
| Inventory / asset table | tool | table | client | explore | S | — |
| Runbook with runnable steps | markdown + "run" buttons that call `bash` via prefill | existing | client | round-trip | S | — |

### 5.20 3D, CAD, engineering

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| glTF/STL/OBJ viewer | file:*.glb | `<model-viewer>` or r3f | client WebGL | explore | S/M | 200 KB chunk |
| Procedural scene | code (three.js) | iframe | iframe | explore | S | Inside iframe |
| Parametric part | code (JSCAD) → STL | JSCAD in worker + viewer | worker | edit params → round-trip | L | Heavy |
| Floor plan | fence:svg | SVG | client | static → edit (Excalidraw) | S | — |
| Technical drawing with dimensions | fence:svg | SVG | client | static | S | — |
| Point cloud / mesh stats | tool | table | client | static | S | — |

### 5.21 Games

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Playable prototype | code (canvas / p5 / Phaser via CDN) | iframe | iframe | play | S | Inside iframe |
| Level / tile map | spec grid | canvas | client | edit → round-trip | M | — |
| Sprite sheet preview | image + spec | canvas animation | client | explore | S | — |
| Game state machine | fence:mermaid stateDiagram | Mermaid | client | static | S | — |
| Balance tables / curves | spec | Vega-Lite | client | explore | S | — |
| Dialogue tree | spec | React Flow | client | explore → edit | M | — |
| Board game / card mock | fence:svg | SVG | client | static | S | — |

### 5.22 Maps and GIS

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Points / routes on a map | file:*.geojson or fence:geojson | Leaflet + OSM tiles | client | explore | M | 42 KB + tiles |
| Choropleth | GeoJSON + values | Leaflet or Vega-Lite geoshape | client | explore | M | — |
| Heatmap | points | Leaflet.heat | client | explore | M | — |
| Isochrone / distance matrix | tool (routing API; needs egress allow) | map | client | explore | L | Network |
| Static map image | sandbox (staticmaps) | image | VM | static | M | — |
| Trip itinerary (map + timeline) | spec | Leaflet + vis-timeline | client | explore | M | — |

### 5.23 Hardware and IoT

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Wiring / breadboard diagram | fence:svg | SVG | client | static | S | — |
| Pinout table and diagram | markdown + svg | table + SVG | client | static | S | — |
| Timing diagram | fence:wavedrom | WaveDrom | client | static | S | — |
| Sensor dashboard (from CSV/serial log) | file:*.csv | Vega-Lite | client | explore | S | — |
| Schematic (KiCad export) | file:*.svg | SVG as `<img>` | client | static | S | — |
| State machine for firmware | fence:mermaid | Mermaid | client | static | S | — |
| Register map | markdown table | table | client | static | S | — |

### 5.24 Research and knowledge work

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Concept map / literature map | fence:markmap or DOT | Markmap / Graphviz | client/worker | explore | S | — |
| Comparison matrix with scores | markdown table + spec | table with heat cells | client | explore | S | — |
| Citation graph | spec | React Flow / Graphviz | client | explore | M | — |
| Annotated reading (highlights + notes) | file:*.md | markdown with marks | client | edit | M | — |
| Evidence table (claim, source, confidence) | tool | table with links | client | explore | S | — |
| Timeline of events | spec | vis-timeline | client | explore | S | — |
| Survey results | spec | Vega-Lite | client | explore | S | — |

### 5.25 Personal productivity and life

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Plan / todo with checkboxes | markdown task list (OpenCode `todowrite`) | interactive list → round-trip | client | round-trip | S | 0 |
| Weekly calendar | spec | FullCalendar | client | edit | M | — |
| Habit tracker, budget | file:*.csv | table + Vega-Lite | client | edit → round-trip | M | — |
| Trip itinerary | spec | map + timeline | client | explore | M | — |
| Recipe card with scaling | spec | own card with servings slider | client | explore | S | — |
| Workout plan | table + body-part SVG | table + SVG | client | static | S | — |
| Decision helper (weighted criteria) | spec | sliders + computed ranking | client | round-trip | M | — |

### 5.26 Legal, compliance, HR, health (regulated-text work)

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Contract redline | tool:diff_text | word diff with accept/reject | client | round-trip | M | — |
| Clause comparison table | markdown table | table | client | static | S | — |
| Policy decision flowchart | fence:mermaid | Mermaid | client | static | S | — |
| Compliance checklist with evidence links | markdown task list | interactive list | client | round-trip | S | — |
| Org / reporting lines | spec | Graphviz | worker | explore | S | — |
| Medication / schedule table | table | table + calendar | client | static | S | — |

### 5.27 The agent's own presentation (meta-UI)

| Use case | Emits | Renders with | Runs | Interactivity | Diff | Speed |
|---|---|---|---|---|---|---|
| Plan with step status (todowrite) | OpenCode `todowrite` | checklist with progress bar | client | round-trip (user reorders/deletes) | S | 0 |
| Tool timeline (Warp-style blocks with durations) | parts | timeline strip | client | explore | M | — |
| Permission request with diff preview | permission event | card with inline diff | client | round-trip | S | — |
| Clarifying question as form (one or several fields) | OpenCode `question` tool | structured form (not just free text) | client | round-trip | S | — |
| Cost / token dashboard per session | ledger | Vega-Lite + tiles | client | explore | S | — |
| Subagent tree | `subtask`/`agent` parts | collapsible tree | client | explore | M | — |
| "What changed in this turn" summary | patch parts | file list with +/- | client | explore | S | Exists in part |

---

## 6. Architecture

### 6.1 The three patterns on our stack

| Pattern | Path through syrup | Pros for us | Cons for us |
|---|---|---|---|
| **P1. Structured tool results** | OpenCode custom tool in `.opencode/tools/*.ts` (`tool()` helper from `@opencode-ai/plugin`, Zod args, `execute(args, ctx)` where `ctx` has `agent, sessionID, messageID, directory, worktree`). Result arrives as `ToolPart` with `state.output` (string the model sees), `state.title`, `state.metadata`. Our `parts.tsx` keys a renderer on `part.tool`. https://opencode.ai/docs/custom-tools/ | Typed, validated at the boundary; streaming `running` state gives a skeleton early; round-trip is natural (UI → prefill or a follow-up tool call); works in local and cloud since tools live in the workspace or `~/.config/opencode/tools` | The tool's string return enters the model's context (keep it short); whether plugin tools can set `metadata` from `ctx` is **verify** (built-in tools do; the docs only list the five context fields). Fallback: write the payload to `.syrup/artifacts/<id>.json` and return `artifact:<id>` |
| **P2. Files + Preview** | Agent writes files with its normal `write`/`edit` tools; `file-preview.tsx` renders by kind; the Preview tab reloads on change; user edits write back to the same file | Zero new protocol; this is what a coding agent does anyway; both modes already have `workspace-fs` read/write; the file is the round-trip; files survive the session and can be committed | Only visible when the user opens the panel (so chat needs a "card" that points to the file); large or binary artifacts need thumbnails; on phones the panel is a sheet |
| **P3. Declarative spec in the stream** | Fenced blocks in `text` parts (` ```vega-lite `), or a JSON `ui` spec (json-render / A2UI-style catalog) | Renders inline, progressively, with native styling; works with every model; cheapest to build | Weak models produce invalid specs (needs validation + visible fallback + optional auto-repair turn); expressiveness bounded by the catalog |

- **Recommendation: all three, as layers, with one renderer registry.** A single `RichBlock` component takes `{ kind, source | data, origin }` and dispatches to a lazily loaded renderer. Fences (P3), tool results (P1), and files (P2) all produce `RichBlock` props. One place to add a kind; the same component renders in chat, in the Preview tab, in the shared read-only snapshot, and on phones.

### 6.2 Layer 0: rich fences in markdown (build first)

- **Mechanism.** In `markdown.tsx`, the `pre`/`code` override inspects the fence language. Known kinds render via `RichBlock`; unknown kinds stay code. Add `remark-math` + `rehype-katex` for `$…$`.
- **Kinds (initial):** `mermaid`, `vega-lite` (alias `chart`), `svg`, `html` (sandboxed iframe, fixed height, "open in panel"), `abc`, `markmap`, `d2` (opt-in, worker), `dot`/`graphviz`, `csv`/`tsv` (grid), `json` (tree), `geojson` (Leaflet), `wavedrom`.
- **Streaming rule.** While the fence is open (no closing ``` yet) render a skeleton of the right shape (chart = gray axes, diagram = dashed box, music = staff lines), plus the raw source in a collapsed `<details>`. Render on close. Never try to parse a half-fence; it wastes CPU and flashes errors.
- **Validation + fallback.** Vega-Lite: Ajv against the bundled schema; on failure show the code block with a one-line error and a "Fix it" button that prefills "The chart spec failed: <error>. Fix it." Mermaid: `mermaid.parse()` first; same fallback. This is the cheap version of the 70%→95% repair loops in the literature. https://microsoft.github.io/genaiscript/blog/mermaid-syntax-errors/
- **Model guidance.** Add one paragraph to the engine instructions (`syrupEngineConfig` already injects instructions): "When a chart, diagram, tree, formula or sheet music helps, emit it as a fenced block of type … The UI renders these." Keep it short; the Vega-Lite and Mermaid grammars are already in every model's training data.
- **Teach-by-example.** Ship a skill (`SKILL.md`) with three tiny valid examples per kind; the free models follow examples better than rules.
- **Cost.** S for mermaid/svg/math/csv, S each for abc/markmap/dot, M for vega-lite with validation and for html with sandbox hardening.

### 6.3 Layer 1: files and the Preview tab

- **Extend `kindOf`** in `file-preview.tsx`: `.excalidraw` → Excalidraw (view, then edit), `.vl.json`/`.vg.json` → Vega, `.mmd` → Mermaid, `.d2` → D2, `.abc` → abcjs, `.ipynb` → nbformat renderer (outputs), `.geojson` → Leaflet, `.glb/.gltf/.stl` → model-viewer, `.drawio` → view-only via diagrams.net viewer in iframe (optional), `.wav/.mp3` → WaveSurfer, `.mp4` → video, `.har` → waterfall, speedscope JSON → speedscope iframe.
- **Chat card.** When a `write` tool produces a renderable kind, the tool row shows a thumbnail card ("Open in Preview"). Thumbnail = the same `RichBlock` at small size for cheap kinds, a static placeholder for heavy ones.
- **Editing writes back.** For Excalidraw/CodeMirror/markdown editor: debounce 1 s, write via `workspace-fs`, show "saved". The agent sees the new file on its next turn because it reads files. Add a tiny hint to the next prompt automatically: "User edited `design.excalidraw` in the UI." (through the existing prefill event, or as a hidden `synthetic` text part).
- **Why files beat a session-only blob.** Both modes already sync files; shared read-only snapshots can include them; nothing new to persist; the user can commit them.

### 6.4 Layer 2: structured tools

- **Ship a `syrup` tool pack** into `~/.config/opencode/tools` locally and into the sandbox image in cloud (the sidecar already uploads config on start). Candidates: `show_chart(spec)`, `show_table(rows, columns)`, `show_diagram(kind, source)`, `ask_form(fields)`, `show_compare(before, after)`, `screenshot(url|port)`, `run_sql(query)`, `profile(cmd)`.
- **Three payloads, like the OpenAI Apps SDK.** Return value (string, short, what the model needs: "Rendered bar chart of 12 rows; id a1b2"); UI payload (full spec/data) in `metadata` if supported, else in `.syrup/artifacts/<id>.json`; title for the row. https://developers.openai.com/apps-sdk/build/chatgpt-ui
- **Forms round-trip.** `ask_form` renders fields; on submit the UI sends the answers as the next user message in a fixed format (`Form a1b2 answers: {…}`) via the composer, so the model gets them in the same session with no new transport. OpenCode's own `question` tool shows the precedent.
- **Spec vocabulary.** Prefer adopting json-render's Zod-catalog model for `ask_form`/dashboards rather than inventing one; it is Apache-2.0 and already supports streaming/progressive render. https://github.com/vercel-labs/json-render
- **MCP Apps compatibility (later).** Rendering `ui://` resources from MCP servers the user installs makes third-party interactive tools work in syrup for free. The host side is a sandboxed iframe plus a small JSON-RPC `postMessage` bridge. https://blog.modelcontextprotocol.io/tags/apps/

### 6.5 Layer 3: live app preview

- **Cloud.** Create sandboxes with `ports: [3000, 5173, 8080, 4173]` (max 4; must be declared at create, so pick the common dev ports). `sandbox.domain(port)` yields the HTTPS URL. Detect "listening on" lines in `bash` output or poll the port; show a "Preview :5173" chip in the tool row; iframe it in the Preview tab. https://computesdk.com/blog/how-to-run-your-first-vercel-sandbox
- **Local.** A `/api/preview/:port/*` proxy to `127.0.0.1:<port>` with the same Host checks as `src/proxy.ts`; iframe it. Websocket passthrough for HMR.
- **Device widths.** 390/768/1280 buttons scale the iframe; optional "all three" grid in wide panels (Replit's idea). https://docs.replit.com/references/design/canvas
- **Element picker.** Inject a tiny script via a query param only when the preview is our own proxy; it posts `{selector, text, rect}` on click; the UI prefills "In `<selector>` …". Devin and Lovable both have this. https://docs.devin.ai/zh/desktop/previews.md
- **Screenshot for vision.** Playwright exists in devDependencies; in the sandbox a headless Chromium is heavy on 1 vCPU (expect 2–5 s per shot). Make it a tool the agent calls deliberately, not automatic.

### 6.6 Layer 4: interactive canvases

- **Excalidraw first.** MIT, hand-drawn style users like, JSON format models can write, `@excalidraw/excalidraw` React component, `.excalidraw` files round-trip through the file system. Load only in the Preview tab (heavy). Provide a "Convert Mermaid → Excalidraw" button using `@excalidraw/mermaid-to-excalidraw` so Layer 0 diagrams become editable.
- **Simple Figma-like editor (own, later).** Scope it hard: artboards, rectangles, ellipses, text, images, lines; align/distribute; snap; z-order; export SVG/PNG; a JSON schema (`design.json`) the agent writes and reads. Konva or plain SVG with pointer events; ~60 KB. L effort. Do this only after Excalidraw proves demand.
- **React Flow for structured graphs.** Pipelines, state machines, ERDs, dialogue trees; nodes/edges JSON is trivially LLM-writable; edits round-trip as the same JSON.
- **tldraw.** Revisit only if a license path appears; the agent starter kit is excellent. https://tldraw.dev/starter-kits/agent

### 6.7 Round-trip: how user edits reach the agent

- **Principle.** Every interactive surface serializes to text the agent already understands: a file in the workspace, or a message in the chat. No private channel.
- **File round-trip.** Canvas/table/markdown editors save to the file they rendered. Next turn, a synthetic note tells the agent which files the user changed in the UI (so it re-reads them instead of trusting memory).
- **Message round-trip.** Forms, hunk accept/reject, element picks, "fix this chart" all go through `prefillComposer` (exists) or auto-send with a fixed, parseable prefix. Keep these messages short; they cost tokens on free tiers.
- **Diff round-trip.** "Reject hunk" calls `git checkout -p`-equivalent through a tool, or writes the reverted file; the Changes panel refreshes from the engine snapshot.
- **State in the URL/session.** Panel tab, selected file, device width live in client state only; nothing to persist server-side.

### 6.8 Keeping the chat fast

- **First token is router-bound; the UI must add nothing.** No new dependency in the main chunk. Every renderer behind `next/dynamic(() => import(...), { ssr: false })`. Prefetch the Mermaid and Vega chunks on `requestIdleCallback` after the first paint of a session that has shown one, never before.
- **Render on fence close; skeleton while open.** Parsing partial Mermaid on every token is the classic jank source.
- **Hash-cache rendered output.** `hash(kind + source)` → SVG string in memory (and `sessionStorage` if small). Re-renders during typewriter animation and panel toggles become free.
- **Workers where the library allows.** D2 and Graphviz WASM in workers; Vega can render to canvas in a worker (`vega` supports `OffscreenCanvas` with a loader shim, **verify**); Mermaid needs the DOM, so bound its work: cap nodes (~150) and defer when the tab is hidden.
- **Size budgets.** Chat-column renderers ≤ 100 KB gz each (SVG, KaTeX, Chart.js, Markmap, abcjs, Leaflet, TanStack). Panel-only renderers unlimited but explicit (Mermaid, Vega, Excalidraw, speedscope, model-viewer, DuckDB).
- **Progressive data.** Tables virtualize; charts downsample above ~5k points client-side (LTTB) and say so.
- **Typewriter interplay.** The typewriter in `parts.tsx` reveals text; a fence's rich render should appear when the typewriter reaches the closing fence, not before, so the visual lands in reading order.
- **Phones.** Chat shows a static thumbnail (SVG/PNG or a skeleton) with "Open"; interactive versions live in the panel sheet. No iframes with scripts inside the chat column on narrow screens (scroll trapping). Measure against device width, as the responsive notes in memory say.
- **Measure.** Add two PostHog events: `rich_block_render` (kind, ms, bytes, ok) and `rich_block_error` (kind, error class). Decide what to keep from data.

### 6.9 Security model for agent-written code

- **Default: opaque origin.** `sandbox="allow-scripts"` only; never `allow-same-origin` together with `allow-scripts` on our origin (that combination lets the frame remove its own sandbox). `srcdoc` frames inherit the parent CSP header, so add a strict CSP route for the preview page and serve the frame from it (double-iframe pattern). https://paulkinlan--94679278f65111f09bbf42dde27851f2.web.val.run/double-iframe.html
- **Separate origin when we need storage or SharedArrayBuffer.** A dedicated preview host like Claude's `claudeusercontent.com`, with full process isolation. https://simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts
- **CDN allow-list.** Scripts only from cdnjs/esm.sh/jsdelivr (`script-src`), no `connect-src` except our proxy when needed. Claude's fixed library list exists for this reason. https://github.com/Microtechx-GmbH/claude-artifacts-guide
- **Inline SVG.** Always DOMPurify with `USE_PROFILES: { svg: true }`, strip `<script>`, `<foreignObject>`, event handlers, external `href`s. Or keep SVG as `<img>` (as today) when no interactivity is needed.
- **Sandbox egress.** Live preview servers inside the Vercel Sandbox already respect the per-workspace allow-list; tile servers and CDNs used by previews must be allowed explicitly.
- **Secrets.** Preview iframes never receive the OpenCode Basic auth or ingest tokens; the proxy adds them server-side.

---

## 7. Recommended build order (first 8)

| # | Capability | Why first | Layer | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | **Fenced Mermaid + sanitized SVG + KaTeX math** | Covers flowcharts, sequence, state, ER, gantt, git graph, mind map, class diagrams, logos/icons/wireframes, formulas in one go; every model knows the syntax; pure client | 0 | S–M (3–4 days incl. skeletons, parse-validate-fallback, hash cache, phone thumbnail) | `RichBlock` registry |
| 2 | **Fenced Vega-Lite charts (`chart`)** | The single most requested non-text output in analytics, finance, PM, marketing, science; schema validation makes weak-model output safe | 0 | M (Ajv + schema, theme tokens for dark/light, downsampling) | 1 |
| 3 | **Real tables: CSV/JSON/tool rows → TanStack grid** | Tables are everywhere; markdown tables break past ~10 columns; sorting/filtering/virtualization is cheap | 0 + 1 | S–M | — |
| 4 | **HTML/React single-file preview, hardened** | Already exists for files; add fence support, strict CSP route, esm.sh import map, "open in panel", device widths; this is the Claude Artifacts experience | 0 + 1 | M | CSP route |
| 5 | **Live port preview (cloud ports + local proxy)** | Turns syrup into a Bolt/Lovable-class app builder without WebContainers; detection chip in `bash` rows | 3 | M | Sandbox create with ports; proxy |
| 6 | **Structured tools: `ask_form`, `show_chart`, `show_table`, `show_diagram`** | Round-trip and guaranteed-valid specs; forms fix the "agent asks three questions in prose" problem | 2 | M | Tool pack distribution to local + sandbox; artifact file fallback |
| 7 | **Excalidraw in Preview for `.excalidraw` + Mermaid→Excalidraw** | First editable canvas; MIT; file round-trip; makes every diagram from #1 editable | 4 | M–L | 1, Preview kinds |
| 8 | **Cheap add-ons: abcjs, Markmap, D2 (worker), Graphviz (worker), GeoJSON/Leaflet, model-viewer** | Each is S once the registry exists; together they cover music, mind maps, better graphs, maps, 3D files | 0 + 1 | S each | 1 |

- **After these:** diff review with per-hunk accept/reject (Zed-style), xterm.js terminal (PTY exists), nbformat renderer, speedscope, React Flow editors, own design editor, MCP Apps host, Remotion/video in sandbox.
- **What this ordering optimizes.** Breadth per effort and risk: items 1–4 touch only the client and a markdown plugin; 5 adds one sandbox flag and one proxy; 6 is the first engine-side piece; 7 is the first heavy library.

---

## 8. What others do that we should not copy

- **WebContainers (Bolt).** Node-in-browser is impressive but needs a commercial license for for-profit production and does not fit free-first; our sandbox already runs Node. https://webcontainers.io/enterprise
- **tldraw as the canvas.** License key required since SDK 4.0, watermark on the hobby tier. Excalidraw is MIT and good enough. https://tldraw.dev/legal/tldraw-license
- **A separate "Canvas mode" that forks the conversation (ChatGPT/Gemini).** Our panel is already beside the chat; artifacts should be parts of the message stream plus files, not a second mode with its own history.
- **A fixed, tiny library allow-list baked into the model prompt (Claude Artifacts' cdnjs list).** Use an import map on the preview page instead, so the agent writes bare imports (`import { x } from "recharts"`) and we control versions centrally.
- **Monaco everywhere.** 1–2.4 MB for an editor; CodeMirror 6 at ~50 KB. https://sourcegraph.com/blog/migrating-monaco-codemirror
- **Charts as PNG from server-side Python (Julius/Perplexity).** Loses interactivity, dark mode, and copy-as-data; use specs rendered client-side; keep Python for computing the data.
- **Hosted "UI LLM" APIs (thesys C1).** Paid per call; the catalog idea is good, the dependency is not. https://docs.thesys.dev/guides/what-is-thesys-c1
- **Running agent React code in our own origin for "nicer integration".** This is how prompt-injected artifacts steal sessions. Always an opaque or separate origin.
- **Automatic screenshots of every preview for the model.** On 1 vCPU each Playwright shot is seconds and CPU-seconds we pay for; make it a deliberate tool.
- **Rendering while the fence is still streaming.** Flicker, parse errors, wasted CPU. Skeleton until close.

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Agent-written code in the browser** (XSS, session theft, phishing UI, crypto-mining) | High | Opaque-origin sandbox, strict CSP route, CDN allow-list, DOMPurify for inline SVG/HTML, no tokens in frames, separate preview origin before enabling storage |
| **Bundle creep slows first paint and first token perception** | High | Hard budgets per chunk; main chunk unchanged; `next/dynamic`; CI check on chunk sizes; idle prefetch only |
| **Weak free models emit invalid Mermaid/Vega** | Medium | Parse/validate before render, visible fallback with source, one-click "fix" turn, example-rich skill; track error rate per model in PostHog |
| **Mermaid weight and DOM dependence** | Medium | Lazy chunk; cap diagram size; consider Graphviz WASM for graphs and D2 for architecture; render thumbnails on phones |
| **Mobile**: iframes trap scroll, canvases fight gestures, panel is a sheet | Medium | Static thumbnails in chat on narrow screens; interactive only in the panel; test the `/w/` layout chain and WebKit as the responsive notes require |
| **Token cost of round-trips** on free tiers | Medium | Short, fixed-format messages; payload in files, not in chat; summarize table edits as diffs |
| **Sandbox CPU (1 vCPU)** for Playwright, Remotion, Lighthouse | Medium | Explicit tools, time limits, show cost; prefer client-side rendering for anything visual |
| **Egress allow-lists block tiles/CDNs in cloud previews** | Low | Add common hosts (cdnjs, esm.sh, jsdelivr, Google Fonts, OSM/OpenFreeMap tiles) to the default allow-list with a visible toggle |
| **License drift** (tldraw, Handsontable, HyperFormula, Mapbox, WebContainers, Remotion for larger companies, p5 LGPL bundling) | Low–Medium | Catalog above marks them; keep LGPL libs in iframes via CDN; re-check before each adoption |
| **Scope explosion**: hundreds of kinds, each half-done | Medium | Registry + the 8-item order; measure usage per kind and prune |
| **Local/cloud parity** | Medium | All renderers are client-side and file-based; only the port proxy and tool-pack distribution differ by mode, both behind one interface |
| **Shared read-only snapshots** must render the same visuals without the engine | Low | `RichBlock` has no engine dependency; heavy kinds degrade to source/thumbnail in the static export |

---

## 10. Open questions and sources

### 10.1 Open questions (verify before building)

- **Can OpenCode plugin tools set `metadata`/`title` from `execute`?** Built-in tools do; the custom-tools doc lists `agent, sessionID, messageID, directory, worktree` on the context. If not, use the `.syrup/artifacts/<id>.json` fallback. https://opencode.ai/docs/custom-tools/
- **Does `message.part.updated` deliver tool `metadata` while `running`?** Needed for skeletons with the right shape.
- **Exact gz sizes** for Mermaid 11, Excalidraw runtime, D2 wasm, abcjs, Glide Data Grid, React Flow: check bundlephobia/pkg-size before committing to budgets.
- **Vercel Sandbox `ports` on resume from snapshot:** are declared ports preserved? Test with the existing snapshot flow.
- **Vega in a worker:** `vega` supports headless canvas rendering; confirm `OffscreenCanvas` support in the current version.
- **WaveSurfer license:** BSD-3 in the repo; an old about page says CC-BY. Confirm in `LICENSE`.

### 10.2 Sources (by section)

- Landscape: https://simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts , https://github.com/Microtechx-GmbH/claude-artifacts-guide , https://unmarkdown.com/blog/claude-artifacts-vs-chatgpt-canvas , https://gemini.google/overview/canvas/ , https://www.datacamp.com/tutorial/perplexity-labs , https://ai.google.dev/gemini-api/docs/aistudio-build-mode , https://addyo.substack.com/p/ai-driven-prototyping-v0-bolt-and , https://blog.tooljet.com/bolt-vs-lovable/ , https://docs.replit.com/references/design/canvas , https://zed.dev/docs/ai/agent-panel , https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment , https://docs.devin.ai/zh/desktop/previews.md , https://forum.cursor.com/t/visual-preview-just-like-lovable-dev/52337
- Protocols: https://vercel.com/blog/ai-sdk-3-generative-ui , https://ai-sdk.dev/v4/docs/reference/ai-sdk-rsc , https://vercel.com/changelog/introducing-ai-elements , https://blog.modelcontextprotocol.io/tags/apps/ , https://modelcontextprotocol.net/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp , https://www.morphllm.com/mcp-apps , https://mcpui.dev/guide/apps-sdk , https://developers.openai.com/apps-sdk/build/chatgpt-ui , https://a2ui.org/specification/v0.8-a2ui/ , https://a2ui.org/reference/messages/ , https://www.copilotkit.ai/blog/introducing-ag-ui-the-protocol-where-agents-meet-users , https://github.com/vercel-labs/json-render , https://www.infoq.com/news/2026/03/vercel-json-render , https://docs.thesys.dev/guides/what-is-thesys-c1
- Charts/diagrams: https://tanstack.com/charts/latest/docs/comparison , https://graphy.app/blog/vega-lite-alternatives , https://tessl.io/registry/testland/vega-spec-validator , https://microsoft.github.io/genaiscript/blog/mermaid-syntax-errors/ , https://github.com/probelabs/maid , https://cdn.jsdelivr.net/npm/@terrastruct/d2@0.1.33/README.md , https://www.jsdelivr.com/package/npm/@hpcc-js/wasm , https://github.com/xyflow/xyflow , https://markmap.js.org/docs/markmap , https://npmjs.com/@excalidraw/excalidraw , https://tldraw.dev/legal/tldraw-license , https://tldraw.dev/starter-kits/agent , https://github.com/nicoespeon/gitgraph.js
- Code/terminal/tables/docs: https://sourcegraph.com/blog/migrating-monaco-codemirror , https://replit.com/blog/codemirror , https://shiki.style/guide/ , https://npmjs.com/package/@git-diff-view/react , https://depscope.dev/pkg/npm/xterm , https://grid.glideapps.com , https://handsontable.com/docs/software-license/ , https://licenses.dev/npm/%40tanstack%2Freact-table/8.21.3 , https://mcp.depscope.dev/pkg/npm/pdfjs-dist , https://fullcalendar.io/license , https://libraries.io/npm/frappe-gantt , https://cdn.jsdelivr.net/npm/vis-timeline@8.5.4/README.md
- Math/music/maps/3D/media: https://cuberoot.me/dev/language/katex , https://docs.abcjs.net/visual/overview , https://www.geoapify.com/map-libraries-comparison-leaflet-vs-maplibre-gl-vs-openlayers-trends-and-statistics/ , https://www.pkgpulse.com/guides/threejs-vs-react-three-fiber-vs-babylonjs-3d-webgl-2026 , https://p5js.org/copyright/ , https://soundingfuture.com/tools/tone.js , https://wavesurfer.xyz/about , https://remotion.dev/license
- Compute/sandboxes: https://duckdb.org/2021/10/29/duckdb-wasm , https://pyodide-pack.pyodide.org , https://blog.jupyter.org/jupyterlite-jupyter-%EF%B8%8F-webassembly-%EF%B8%8F-python-f6e2e41ab3fa , https://www.simonwillison.net/2024/Jun/29/marimo-app , https://docsearch.algolia.com/mcp/docs/repo/codesandbox/sandpack , https://webcontainers.io/enterprise , https://computesdk.com/blog/how-to-run-your-first-vercel-sandbox , https://forums.basehub.com/vercel/sandbox/2 , https://paulkinlan--94679278f65111f09bbf42dde27851f2.web.val.run/double-iframe.html , https://github.com/jlfwong/speedscope , https://scalar.com/products/api-references/integrations/react
- Engine: https://opencode.ai/docs/custom-tools/ , https://opencode.ai/docs/plugins/ , `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` (ToolPart/ToolState shapes), `src/components/parts.tsx`, `src/components/markdown.tsx`, `src/components/file-preview.tsx`, `src/lib/panel.tsx`, `docs/ARCHITECTURE.md`
