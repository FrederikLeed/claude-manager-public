#!/usr/bin/env node
/**
 * Test runner — runs all test files sequentially.
 * Usage: node tests/run-all.js [filter]
 *
 * Requires a running dev server at localhost:3002.
 * Tests create and destroy real Docker containers.
 */
import { execFileSync } from 'child_process';
import { readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

// Verify dev server is running
const apiBase = process.env.TEST_API_BASE || 'http://localhost:3002';
try {
  const response = await fetch(`${apiBase}/api/auth/status`);
  if (!response.ok) throw new Error(`Status ${response.status}`);
} catch {
  console.error(`\n  Dev server not running at ${apiBase}`);
  console.error('   Start with: DATA_DIR=/tmp/cm-test-data npm run dev\n');
  process.exit(1);
}

// Find test files
const files = readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !filter || f.includes(filter))
  .sort();

console.log(`\nRunning ${files.length} test files...\n`);

let passed = 0;
let failed = 0;

for (const file of files) {
  const filePath = path.join(__dirname, file);
  console.log(`\n--- ${file} ---`);

  try {
    execFileSync('node', ['--test', filePath], {
      stdio: 'inherit',
      timeout: 300000, // 5 min per file
    });
    passed++;
  } catch {
    failed++;
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${files.length} files`);
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
