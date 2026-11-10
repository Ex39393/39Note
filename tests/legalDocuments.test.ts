import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('public legal documents are complete, reciprocal, and release dated', () => {
  const privacy = source('../public/privacy.html');
  const terms = source('../public/terms.html');
  const legalCss = source('../public/legal.css');

  assert.match(privacy, /<h1>Privacy Policy<\/h1>/u);
  assert.match(privacy, /Last updated: November 10, 2026/u);
  assert.match(privacy, /Google API Services User Data Policy/u);
  assert.match(privacy, /Limited Use/u);
  assert.match(privacy, /drive\.file/u);
  assert.match(privacy, /href="terms\.html"/u);
  assert.doesNotMatch(privacy, /GOOGLE_CLIENT_SECRET|TOKEN_ENCRYPTION_KEY/u);

  assert.match(terms, /<h1>Terms of Service<\/h1>/u);
  assert.match(terms, /Last updated: November 10, 2026/u);
  assert.match(terms, /All rights reserved/u);
  assert.match(terms, /href="privacy\.html"/u);
  assert.match(terms, /local-first/u);

  assert.match(legalCss, /:focus-visible/u);
  assert.match(legalCss, /prefers-reduced-motion/u);
  assert.match(legalCss, /@media print/u);
});

test('Home and Settings expose base-path-safe legal links', () => {
  const home = source('../src/components/HomeWorkspace.tsx');

  assert.match(home, /import\.meta\.env\.BASE_URL/u);
  assert.match(home, /legalDocumentUrl\('privacy\.html'\)/u);
  assert.match(home, /legalDocumentUrl\('terms\.html'\)/u);
  assert.match(home, /label="39Note legal documents"/u);
  assert.match(home, /label="39Note policies"/u);
  assert.match(home, /target="_blank"/u);
  assert.match(home, /rel="noreferrer"/u);
});
