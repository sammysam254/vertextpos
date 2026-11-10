const fs = require('fs');
const path = require('path');

// Production Cloud Defaults for Netlify Serverless Functions (when .env is not present)
const DEFAULTS = {
  NODE_ENV: 'production',
  CURRENCY: 'KES',
  SUPER_ADMIN_EMAIL: 'sammyseth260@gmail.com',
  SUPABASE_URL: 'https://lxjmggrpgicjurbksbtv.supabase.co',
  SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4am1nZ3JwZ2ljanVyYmtzYnR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyNDcxMDYsImV4cCI6MjEwOTgyMzEwNn0.Fe78FrlXK4N6IUQs-62PGzD3MrUlc2ex5qYIptlSS4c',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4am1nZ3JwZ2ljanVyYmtzYnR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyNDcxMDYsImV4cCI6MjEwOTgyMzEwNn0.Fe78FrlXK4N6IUQs-62PGzD3MrUlc2ex5qYIptlSS4c',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4am1nZ3JwZ2ljanVyYmtzYnR2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5NDI0NzEwNiwiZXhwIjoyMTA5ODIzMTA2fQ.x2vkjRcKjatAK2ZK0OSas45TeFEi7SKIYWOcpFdk-OE',
  JWT_SECRET: 'zRHxK31YwjzZeUXd0E7zWBLDjRkHY0sh+FiiBxbhYLgKdwfC1cMwBP2KnE6tlmWIAJ4RRa03U1SWgGZ/NM69wQ=='
};

function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch (e) {
      console.warn('Could not read .env:', e.message);
    }
  }

  // Ensure all defaults are populated in process.env if missing
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!process.env[k]) {
      process.env[k] = v;
    }
  }
}

loadEnv();
module.exports = process.env;
