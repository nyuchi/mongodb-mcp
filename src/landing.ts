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
<title>Nyuchi Data MCP</title>
<meta name="description" content="Operator Model Context Protocol server for Nyuchi's data stores — MongoDB, Supabase, Apache Doris, Cassandra and JanusGraph — on Cloudflare Workers with WorkOS OAuth.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${ICON_HREF}" type="image/svg+xml">
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
        <span>Nyuchi Data MCP</span>
      </a>
      <a class="nav-link" href="https://nyuchi.com">nyuchi.com →</a>
    </div>
  </header>
  <main>
    <div class="container">
      <span class="badge">Nyuchi · Infrastructure</span>
      <h1>One authenticated MCP for all of Nyuchi's data.</h1>
      <p class="lead">
        Point Claude Desktop, Cursor, or any Model Context Protocol client at
        <code>https://data.nyuchi.dev/mcp</code>, sign in through WorkOS, and
        the worker brokers queries to MongoDB, Supabase, Apache Doris,
        Cassandra and JanusGraph — read-only unless you also hold a store's
        write permission.
      </p>
      <div class="cta-row">
        <a class="btn btn-primary" href="#connect">Connect a client</a>
        <a class="btn btn-ghost" href="https://github.com/nyuchi/data-mcp">View on GitHub</a>
      </div>

      <h2 id="connect">Connect</h2>
      <p style="color: var(--color-fg-muted); font-size: 0.9375rem;">
        This is an internal service. On first connect your client opens a
        WorkOS <strong>sign-in</strong> page — authenticate with an account in
        the allowed organization that holds at least one store's
        <code>&lt;store&gt;:access</code> permission. The client caches and refreshes the OAuth session itself, so
        there is no token or header to manage. Clients without native remote
        support use the <code>mcp-remote</code> proxy snippet, which runs the
        sign-in for them.
      </p>
      <div class="tabs">
        <details open>
          <summary>Claude Desktop / Claude Code (CLI)</summary>
          <div>
            <p>CLI shortcut: <code>claude mcp add nyuchi-data https://data.nyuchi.dev/mcp --transport http</code>. Or paste this into <code>~/.claude.json</code> / <code>claude_desktop_config.json</code>:</p>
            <pre><code>{
  "mcpServers": {
    "nyuchi-data": {
      "type": "http",
      "url": "https://data.nyuchi.dev/mcp"
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
    "nyuchi-data": {
      "url": "https://data.nyuchi.dev/mcp"
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
    "nyuchi-data": {
      "type": "http",
      "url": "https://data.nyuchi.dev/mcp"
    }
  }
}</code></pre>
          </div>
        </details>
        <details>
          <summary>Codex CLI (OpenAI)</summary>
          <div>
            <p>Add to <code>~/.codex/config.toml</code>:</p>
            <pre><code>[mcp_servers.nyuchi-data]
command = "npx"
args = ["-y", "mcp-remote", "https://data.nyuchi.dev/mcp"]</code></pre>
          </div>
        </details>
        <details>
          <summary>Gemini CLI / Code Assist</summary>
          <div>
            <p>Add to <code>~/.gemini/settings.json</code>:</p>
            <pre><code>{
  "mcpServers": {
    "nyuchi-data": {
      "httpUrl": "https://data.nyuchi.dev/mcp"
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
    "nyuchi-data": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://data.nyuchi.dev/mcp"]
    }
  }
}</code></pre>
          </div>
        </details>
      </div>

      <h2>What's inside</h2>
      <p>
        Tools are grouped by store and named with its prefix. Each store's read
        tools need <code>&lt;store&gt;:access</code>; anything that changes data
        also needs <code>&lt;store&gt;:write</code>. A session sees only the
        tools it may call.
      </p>
      <ul class="tools">
        <li>
          <strong>Supabase</strong>
          <div class="desc"><code>supabase_listProjects</code>, <code>supabase_listTables</code>, <code>supabase_describeTable</code>, <code>supabase_query</code> (read-only); <code>supabase_execute</code> (write)</div>
        </li>
        <li>
          <strong>Apache Doris</strong>
          <div class="desc">Apache Doris MCP's eight domains — <code>doris_catalog</code>, <code>doris_query</code>, <code>doris_cluster</code>, <code>doris_pipeline</code>, <code>doris_search</code>, <code>doris_governance</code>, <code>doris_lakehouse</code>, <code>doris_semantic</code> — all read-only</div>
        </li>
        <li>
          <strong>Cassandra</strong>
          <div class="desc"><code>cassandra_listKeyspaces</code>, <code>cassandra_listTables</code>, <code>cassandra_describeTable</code>, <code>cassandra_select</code>; <code>cassandra_execute</code> (write)</div>
        </li>
        <li>
          <strong>JanusGraph</strong>
          <div class="desc"><code>graph_summary</code>, <code>graph_findVertices</code>, <code>graph_neighbours</code>; <code>graph_gremlin</code> (write)</div>
        </li>
      </ul>
      <p>
        <strong>MongoDB</strong> — every tool below, prefixed <code>mongodb_</code>
        (<code>find</code> is <code>mongodb_find</code>):
      </p>
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
          <strong>Deliberately absent: user and role management</strong>
          <div class="desc">
            No tool here creates users or grants roles, and <code>runCommand</code> refuses that
            command family. Those operations need <code>userAdmin</code>, which cannot be scoped —
            a credential that can create a user can create a <code>root</code> user. Use the Atlas
            UI or <code>mongosh</code> instead.
          </div>
        </li>
      </ul>

      <h2 id="roles">MongoDB user role requirements</h2>
      <p>
        Reads run as a read-only user (<code>readAnyDatabase</code> +
        <code>clusterMonitor</code>); writes, where enabled, as a separate
        read-write user. Each can only do what its roles allow — grant the
        smallest role that covers your usage; permission-denied responses
        include a hint pointing to this table:
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
            <td>Creating users or granting roles — <strong>not offered by this server</strong></td>
            <td>
              <strong>Never grant <code>userAdmin</code></strong> to either
              MongoDB credential
            </td>
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
        Full setup notes are in the <a href="https://github.com/nyuchi/data-mcp#4-mongodb-user-role-requirements">README</a>.
      </p>

      <h2>How auth works</h2>
      <p>
        The <code>/mcp</code> endpoint is gated by <a href="https://workos.com/authkit">WorkOS</a>
        <strong>OAuth</strong> (Authorization Code + PKCE). There is no public
        surface — clients sign in through WorkOS, and the worker gates the
        session before a single query runs: the organization must be in the
        allowlist, and each store's tools need that store's permission in the
        granted OAuth scope (WorkOS grants a permission only to users whose org
        role holds it). It fails closed when unconfigured, and every tool call
        is audit-logged without its arguments or results. Doris, Cassandra and
        JanusGraph sit on a private network, reached through a relay that
        accepts only signed requests from this worker.
      </p>
    </div>
  </main>
  <footer class="site">
    <div class="container row">
      <span>Part of the <a href="https://nyuchi.com">Nyuchi</a> ecosystem.</span>
      <a href="https://github.com/nyuchi/data-mcp">Source · MIT</a>
    </div>
  </footer>
</body>
</html>`;
}
