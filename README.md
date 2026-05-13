# 🧠 Payload Brain
A vector database + MCP server for Payload CMS v3 that gives your AI coding assistant perfect, zero-hallucination knowledge of Payload v3's documentation, Next.js App Router standards, and hook implementations.

## Features
- **Zero-Hallucination**: Pulls official Payload v3 documentation directly from GitHub.
- **Hybrid Search (RRF)**: Uses Supabase pgvector and Full-Text Search to find exact syntax and conceptual matches.
- **Context-Aware**: Automatically fetches adjacent markdown chunks to give the AI the full context of a page.
- **100% Private**: Bring your own Supabase instance and OpenAI key. Your queries stay entirely yours.
- **Customizable**: Easily modify `ingest.js` to ingest your own internal company wikis or proprietary UI components.

## 5-Minute Quickstart

### 1. Clone & Setup
```bash
git clone https://github.com/d-damba/payload-brain.git
cd payload-brain
node setup.js
```
*(The setup script will automatically install NPM dependencies and scaffold your `.env` and `.mcp.json` files.)*

### 2. Set Up Supabase
1. Create a project on [Supabase](https://supabase.com).
2. Go to the **SQL Editor** in your Supabase dashboard.
3. Copy the contents of `supabase.sql` from this repository and run it. This creates the `payload_docs` table, enables `pgvector`, and sets up the Hybrid Search RPC function.

### 3. Configure Your Environment
Open the newly created `.env` file and add your keys:
- `SUPABASE_URL`: Found in Supabase Project Settings -> API.
- `SUPABASE_SERVICE_KEY`: Found in Supabase Project Settings -> API (`service_role` secret).
- `OPENAI_API_KEY`: Get an API key from [OpenAI](https://platform.openai.com/api-keys) (used for cheap `text-embedding-3-small` embeddings).

### 4. Run the Ingestion
Populate your Supabase database with the latest Payload v3 documentation.
```bash
node ingest.js
```

### 5. Hook Up Your IDE
Now that your database is populated, point your IDE to the MCP server to give the AI access to the `search_payload_docs` tool. However you set up MCP servers in your IDE, just point the command to `node` and the argument to the absolute path of `payload-mcp.js`.

I use **Antigravity**, and here's how it works:

**Per-Project Setup:**
Antigravity automatically discovers MCP servers via the `.mcp.json` file. Because you already ran `node setup.js`, an `.mcp.json` file with the absolute path to your server was automatically generated. 
* To use the Brain in this folder, do nothing — Antigravity is already connected.
* To use the Brain in a different project folder, simply copy the `.mcp.json` and `CLAUDE.md` files from this folder into the root of your new project.

**Global Setup (Recommended for Antigravity):**
If you want Antigravity to *always* have access to the Payload Brain no matter what folder you open, add it to your global config:
1. Open `~/.gemini/antigravity/mcp_config.json`.
2. Add the server to the `mcpServers` object:
```json
{
    "mcpServers": {
        "payload-brain": {
            "command": "node",
            "args": [
                "/absolute/path/to/payload-brain/payload-mcp.js"
            ]
        }
    }
}
```
Now you only ever need to drop the `CLAUDE.md` file into your new projects.

---

## 🏗️ Usage in Your Actual Payload Projects
You do **not** need to install this tool inside your actual Payload CMS web app repositories, unless you want to.

After the main install, simply open your new Payload project in your IDE. Copy over **`CLAUDE.md`** and **`.mcp.json`**.

Your IDE will read `CLAUDE.md`, understand the Payload v3 architecture rules, and automatically query your global `payload-brain` server when it needs documentation.
