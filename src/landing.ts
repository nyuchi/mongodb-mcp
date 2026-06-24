// Self-contained landing page served at GET /.
// Tokens come from the Nyuchi design system: cobalt = primary,
// gold = nyuchi's mineral accent, Noto Serif for display, Noto Sans for body,
// JetBrains Mono for code, warm-stone borders, pill buttons.

const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Noto+Sans:wght@400;500;600;700&family=Noto+Serif:wght@600;700&display=swap";

const ICON_HREF = "/icon.svg";

const STYLES = `
  :root {
    --color-cobalt: #0047AB;
    --color-cobalt-on: #FFFFFF;
    --color-gold: #FFD740;
    --color-gold-container: #FFF8E1;
    --color-gold-on-container: #3E2723;
    --color-surface: #FFFFFF;
    --color-canvas: #FAFAF8;
    --color-fg: #1C1B1A;
    --color-fg-muted: #5F5C57;
    --color-border: #E7E5E0;
    --dot-color: rgba(0, 71, 171, 0.09);
    --dot-grid: 24px;
    --radius-sm: 7px;
    --radius-md: 12px;
    --radius-lg: 14px;
    --radius-full: 9999px;
    --space-xs: 0.25rem;
    --space-sm: 0.5rem;
    --space-md: 0.75rem;
    --space-base: 1rem;
    --space-lg: 1.5rem;
    --space-xl: 2rem;
    --space-2xl: 3rem;
    --space-3xl: 4rem;
    --space-4xl: 5rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --color-cobalt: #00B0FF;
      --color-cobalt-on: #001F3F;
      --color-gold: #FFD740;
      --color-gold-container: #332200;
      --color-gold-on-container: #FFECB3;
      --color-surface: #100F0E;
      --color-canvas: #0A0908;
      --color-fg: #F0EFEC;
      --color-fg-muted: #A8A39A;
      --color-border: #2A2927;
      --dot-color: rgba(0, 176, 255, 0.13);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background-color: var(--color-canvas);
    background-image: radial-gradient(circle at 1px 1px, var(--dot-color) 1px, transparent 0);
    background-size: var(--dot-grid) var(--dot-grid);
    color: var(--color-fg);
    font-family: "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 1rem;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--color-cobalt); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:focus-visible { outline: 2px solid var(--color-cobalt); outline-offset: 2px; border-radius: var(--radius-sm); }
  code, pre { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
  .container { max-width: 760px; margin: 0 auto; padding: 0 var(--space-lg); }
  header.site {
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    padding: var(--space-base) 0;
  }
  header.site .row {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-base);
  }
  .wordmark {
    display: inline-flex; align-items: center; gap: var(--space-sm);
    font-family: "Noto Serif", Georgia, serif; font-weight: 700; font-size: 1.125rem;
    color: var(--color-fg); text-decoration: none;
  }
  .wordmark img { width: 1.5rem; height: 1.5rem; display: block; }
  .nav-link { font-size: 0.875rem; color: var(--color-fg-muted); text-decoration: none; }
  .nav-link:hover { color: var(--color-fg); }
  main { padding: var(--space-3xl) 0 var(--space-4xl); }
  .badge {
    display: inline-block;
    background: var(--color-gold-container); color: var(--color-gold-on-container);
    padding: var(--space-xs) var(--space-md);
    border-radius: var(--radius-full);
    font-size: 0.75rem; font-weight: 500; letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  h1 {
    font-family: "Noto Serif", Georgia, serif;
    font-weight: 700;
    font-size: clamp(2.5rem, 6vw, 4.5rem);
    line-height: 1.1; letter-spacing: -0.025em;
    margin: var(--space-lg) 0 var(--space-base);
  }
  h2 {
    font-family: "Noto Serif", Georgia, serif;
    font-weight: 600;
    font-size: clamp(1.75rem, 4vw, 2.25rem);
    line-height: 1.2; letter-spacing: -0.015em;
    margin: var(--space-3xl) 0 var(--space-base);
  }
  .lead { font-size: 1.125rem; color: var(--color-fg-muted); line-height: 1.6; max-width: 60ch; }
  .cta-row { display: flex; flex-wrap: wrap; gap: var(--space-md); margin-top: var(--space-xl); }
  .btn {
    display: inline-flex; align-items: center; gap: var(--space-sm);
    padding: var(--space-md) var(--space-lg);
    border-radius: var(--radius-full);
    font-weight: 500; font-size: 0.9375rem; line-height: 1;
    text-decoration: none; border: 1px solid transparent; transition: background 120ms;
  }
  .btn-primary { background: var(--color-cobalt); color: var(--color-cobalt-on); }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-ghost { background: transparent; color: var(--color-fg); border-color: var(--color-border); }
  .btn-ghost:hover { background: var(--color-surface); }
  pre {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-base);
    overflow-x: auto;
    font-size: 0.875rem; line-height: 1.6;
    margin: var(--space-base) 0 0;
  }
  ul.tools { list-style: none; padding: 0; margin: var(--space-base) 0 0; display: grid; gap: var(--space-md); }
  ul.tools li {
    border: 1px solid var(--color-border); border-radius: var(--radius-lg);
    padding: var(--space-base) var(--space-lg); background: var(--color-surface);
  }
  ul.tools li strong { font-weight: 600; }
  ul.tools li .desc { color: var(--color-fg-muted); font-size: 0.9375rem; }
  .tabs {
    margin: var(--space-base) 0 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    overflow: hidden;
  }
  .tabs details { border-top: 1px solid var(--color-border); }
  .tabs details:first-child { border-top: 0; }
  .tabs summary {
    list-style: none;
    cursor: pointer;
    padding: var(--space-md) var(--space-lg);
    font-weight: 600;
    display: flex; align-items: center; justify-content: space-between;
  }
  .tabs summary::-webkit-details-marker { display: none; }
  .tabs summary::after { content: "+"; font-weight: 400; color: var(--color-fg-muted); }
  .tabs details[open] summary::after { content: "−"; }
  .tabs details > div { padding: 0 var(--space-lg) var(--space-lg); }
  .tabs details > div p { margin: 0 0 var(--space-sm); color: var(--color-fg-muted); font-size: 0.9375rem; }
  .tabs pre { margin-top: var(--space-sm); }
  table.roles {
    width: 100%;
    border-collapse: collapse;
    margin: var(--space-base) 0 0;
    font-size: 0.9375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  table.roles th, table.roles td {
    padding: var(--space-sm) var(--space-base);
    border-bottom: 1px solid var(--color-border);
    text-align: left; vertical-align: top;
  }
  table.roles tr:last-child td { border-bottom: 0; }
  table.roles th { background: var(--color-surface); font-weight: 600; }
  table.roles td code { font-size: 0.875rem; }
  footer.site {
    margin-top: var(--space-4xl);
    border-top: 1px solid var(--color-border);
    padding: var(--space-xl) 0;
    color: var(--color-fg-muted);
    font-size: 0.875rem;
  }
  footer.site .row { display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--space-base); }
`;

export function landingHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MongoDB MCP — Nyuchi</title>
<meta name="description" content="Authenticated remote Model Context Protocol server for MongoDB, running on Cloudflare Workers with WorkOS M2M auth.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${ICON_HREF}" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS_HREF}">
<style>${STYLES}</style>
</head>
<body>
  <header class="site">
    <div class="container row">
      <a class="wordmark" href="/">
        <img src="${ICON_HREF}" alt="" width="24" height="24">
        <span>MongoDB MCP</span>
      </a>
      <a class="nav-link" href="https://nyuchi.com">nyuchi.com →</a>
    </div>
  </header>
  <main>
    <div class="container">
      <span class="badge">Nyuchi · Infrastructure</span>
      <h1>An authenticated MCP for your MongoDB clusters.</h1>
      <p class="lead">
        Point Claude Desktop, Cursor, or any Model Context Protocol client at
        <code>https://mongodb.nyuchi.dev/mcp</code> with a WorkOS M2M
        access token, and the worker brokers every query — reads, writes,
        indexes, admin commands — against the cluster you have access to.
      </p>
      <div class="cta-row">
        <a class="btn btn-primary" href="#connect">Connect a client</a>
        <a class="btn btn-ghost" href="https://github.com/nyuchi/mongodb-mcp">View on GitHub</a>
      </div>

      <h2 id="connect">Connect</h2>
      <p style="color: var(--color-fg-muted); font-size: 0.9375rem;">
        This is an internal service. Every client must send a WorkOS
        <strong>M2M</strong> access token as an
        <code>Authorization: Bearer &lt;token&gt;</code> header — mint it from
        your WorkOS client id/secret via
        <code>POST https://&lt;authkit-domain&gt;/oauth2/token</code>
        (<code>grant_type=client_credentials</code>). Tokens are short-lived, so
        a small wrapper that refreshes and injects the header is the usual setup.
        The snippets below show the URLs; add the header per your client.
      </p>
      <div class="tabs">
        <details open>
          <summary>Claude Desktop / Claude Code (CLI)</summary>
          <div>
            <p>CLI shortcut: <code>claude mcp add mongodb https://mongodb.nyuchi.dev/mcp --transport http</code>. Or paste this into <code>~/.claude.json</code> / <code>claude_desktop_config.json</code>:</p>
            <pre><code>{
  "mcpServers": {
    "mongodb": {
      "type": "http",
      "url": "https://mongodb.nyuchi.dev/mcp"
    }
  }
}</code></pre>
          </div>
        </details>
        <details>
          <summary>Cursor</summary>
          <div>
            <p>Drop into <code>~/.cursor/mcp.json</code> (user) or <code>.cursor/mcp.json</code> (project):</p>
            <pre><code>{
  "mcpServers": {
    "mongodb": {
      "url": "https://mongodb.nyuchi.dev/mcp"
    }
  }
}</code></pre>
          </div>
        </details>
        <details>
          <summary>VS Code (GitHub Copilot Chat)</summary>
          <div>
            <p>Native MCP since VS Code 1.99. Add to <code>.vscode/mcp.json</code>:</p>
            <pre><code>{
  "servers": {
    "mongodb": {
      "type": "http",
      "url": "https://mongodb.nyuchi.dev/mcp"
    }
  }
}</code></pre>
          </div>
        </details>
        <details>
          <summary>Codex CLI (OpenAI)</summary>
          <div>
            <p>Add to <code>~/.codex/config.toml</code>:</p>
            <pre><code>[mcp_servers.mongodb]
command = "npx"
args = ["-y", "mcp-remote", "https://mongodb.nyuchi.dev/mcp"]</code></pre>
          </div>
        </details>
        <details>
          <summary>Gemini CLI / Code Assist</summary>
          <div>
            <p>Add to <code>~/.gemini/settings.json</code>:</p>
            <pre><code>{
  "mcpServers": {
    "mongodb": {
      "httpUrl": "https://mongodb.nyuchi.dev/mcp"
    }
  }
}</code></pre>
          </div>
        </details>
        <details>
          <summary>Windsurf / Continue / Zed (or any stdio-only client)</summary>
          <div>
            <p>Wrap with the <code>mcp-remote</code> proxy:</p>
            <pre><code>{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mongodb.nyuchi.dev/mcp"]
    }
  }
}</code></pre>
          </div>
        </details>
      </div>

      <h2>What's inside</h2>
      <ul class="tools">
        <li>
          <strong>Discovery</strong>
          <div class="desc"><code>listDatabases</code>, <code>listCollections</code>, <code>dbStats</code>, <code>collStats</code>, <code>ping</code></div>
        </li>
        <li>
          <strong>Read</strong>
          <div class="desc"><code>find</code>, <code>findOne</code>, <code>count</code>, <code>aggregate</code>, <code>distinct</code>, <code>estimatedDocumentCount</code>, <code>explain</code> — Extended JSON filters and pipelines</div>
        </li>
        <li>
          <strong>Write</strong>
          <div class="desc"><code>insertOne</code>/<code>Many</code>, <code>updateOne</code>/<code>Many</code>, <code>deleteOne</code>/<code>Many</code>, <code>replaceOne</code>, <code>findOneAndUpdate</code>/<code>Replace</code>/<code>Delete</code>, <code>bulkWrite</code> — refuses empty filters without an explicit confirm</div>
        </li>
        <li>
          <strong>Admin</strong>
          <div class="desc"><code>createCollection</code>, <code>dropCollection</code>, <code>renameCollection</code>, <code>createView</code>, <code>createIndex</code>, <code>listIndexes</code>, <code>dropIndex</code>, <code>runCommand</code></div>
        </li>
        <li>
          <strong>Atlas Search</strong>
          <div class="desc"><code>listSearchIndexes</code>, <code>createSearchIndex</code>, <code>updateSearchIndex</code>, <code>dropSearchIndex</code></div>
        </li>
        <li>
          <strong>User management</strong>
          <div class="desc"><code>createUser</code>, <code>updateUser</code>, <code>dropUser</code>, <code>grantRolesToUser</code>, <code>revokeRolesFromUser</code></div>
        </li>
      </ul>

      <h2 id="roles">MongoDB user role requirements</h2>
      <p>
        The MCP can only do what the user in your <code>MONGODB_URI</code> is
        authorised to do. Grant the smallest role that covers your usage —
        permission-denied responses include a hint pointing to this table:
      </p>
      <table class="roles">
        <thead>
          <tr><th>Tools you want to use</th><th>Role on the target db</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Reads: <code>find</code>, <code>findOne</code>, <code>count</code>, <code>aggregate</code>, <code>distinct</code>, <code>listIndexes</code>, <code>collStats</code></td>
            <td><code>read</code></td>
          </tr>
          <tr>
            <td>Above + writes, <code>createIndex</code>/<code>dropIndex</code>, <code>createCollection</code>/<code>dropCollection</code>/<code>renameCollection</code>, <code>bulkWrite</code></td>
            <td><code>readWrite</code></td>
          </tr>
          <tr>
            <td><code>createView</code>, <code>explain</code>, <code>dbStats</code>, profiler-style commands</td>
            <td><code>dbAdmin</code> (or <code>dbOwner</code> for both)</td>
          </tr>
          <tr>
            <td>User-management tools (<code>createUser</code>, …, <code>revokeRolesFromUser</code>)</td>
            <td><code>userAdmin</code></td>
          </tr>
          <tr>
            <td>Atlas Search tools</td>
            <td>Atlas role with Search privileges (e.g. <code>atlasAdmin</code>)</td>
          </tr>
          <tr>
            <td>Anything on every database in the cluster</td>
            <td><code>readWriteAnyDatabase</code> / <code>dbAdminAnyDatabase</code> / <code>root</code></td>
          </tr>
        </tbody>
      </table>
      <p style="margin-top: var(--space-base); font-size: 0.9375rem; color: var(--color-fg-muted);">
        Full setup notes are in the <a href="https://github.com/nyuchi/mongodb-mcp#mongodb-user-role-requirements">README</a>.
      </p>

      <h2>How auth works</h2>
      <p>
        The <code>/mcp</code> endpoint is gated by <a href="https://workos.com/authkit">WorkOS</a>
        <strong>M2M</strong> (<code>client_credentials</code>). There is no
        public surface — every request must carry a valid short-lived WorkOS
        JWT, which the worker verifies statelessly against the environment JWKS
        (issuer, audience, and an optional org-id allowlist) before a single
        MongoDB query runs. No browser sign-in, no session state; it fails
        closed when unconfigured.
      </p>
    </div>
  </main>
  <footer class="site">
    <div class="container row">
      <span>Part of the <a href="https://nyuchi.com">Nyuchi</a> ecosystem.</span>
      <a href="https://github.com/nyuchi/mongodb-mcp">Source · MIT</a>
    </div>
  </footer>
</body>
</html>`;
}
