#!/usr/bin/env node

import { existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('Setting up Payload Brain...\n');

// 1. Install dependencies
console.log('Installing dependencies...');
try {
  execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
  console.log('');
} catch {
  console.error('npm install failed. Make sure Node.js v18+ and npm are installed.');
  process.exit(1);
}

// 2. Scaffold .env
const envPath = join(__dirname, '.env');
if (!existsSync(envPath)) {
  writeFileSync(
    envPath,
    [
      'SUPABASE_URL=your_supabase_project_url_here',
      'SUPABASE_SERVICE_KEY=your_supabase_service_key_here',
      'OPENAI_API_KEY=your_openai_api_key_here',
      '',
    ].join('\n'),
    'utf8'
  );
  console.log('Created .env — fill in your credentials before running.\n');
} else {
  console.log('.env already exists, skipping.\n');
}

// 3. Scaffold .mcp.json (Pointing to the new payload-mcp.js file)
const mcpPath = join(__dirname, 'payload-mcp.js').replace(/\\/g, '/');
const mcpJsonPath = join(__dirname, '.mcp.json');
if (!existsSync(mcpJsonPath)) {
  const mcpConfig = {
    mcpServers: {
      'payload-brain': {
        command: 'node',
        args: [mcpPath],
      },
    },
  };
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');
  console.log('Created .mcp.json — point your IDE to this config to connect the server.\n');
} else {
  console.log('.mcp.json already exists, skipping.\n');
}

console.log('✅ Setup complete! Next steps:');
console.log('1. Ensure your API keys are in the .env file');
console.log('2. Run the database migration in Supabase');
console.log('3. Run the ingestion: node ingest.js');