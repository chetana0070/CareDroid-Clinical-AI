#!/usr/bin/env node
/**
 * Verifies the RAG pipeline: authenticated health, stats, and semantic retrieval against the local corpus.
 *
 * Notes:
 * - /api/rag/health and /api/rag/stats may require VIEW_ANALYTICS permission.
 * - Dev-session currently creates a physician user, so those endpoints may return 403.
 * - If health/stats are RBAC-protected but guideline retrieval succeeds, RAG is still operational.
 */
import http from 'node:http';

const backendPort = Number.parseInt(process.env.BACKEND_PORT || process.env.PORT || '3350', 10);

const requestJson = (path, { method = 'GET', body, headers = {} } = {}) =>
  new Promise((resolveRequest, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;

    const req = http.request(
      {
        host: '127.0.0.1',
        port: backendPort,
        path,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
        timeout: 30000,
      },
      (res) => {
        let raw = '';

        res.on('data', (chunk) => {
          raw += chunk;
        });

        res.on('end', () => {
          let parsed = null;

          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }

          resolveRequest({ status: res.statusCode || 0, body: parsed, raw });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout ${method} ${path}`));
    });

    req.on('error', reject);

    if (payload) req.write(payload);
    req.end();
  });

const checks = [];
const record = (label, ok, detail) => checks.push({ label, ok, detail });

try {
  const devSession = await requestJson('/api/auth/dev-session', { method: 'POST' });
  const token = devSession.body?.accessToken;

  record('Dev auth for RAG checks', Boolean(token), token ? 'JWT issued' : `HTTP ${devSession.status}`);

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  const health = await requestJson('/api/rag/health', {
    headers: authHeaders,
  });

  const healthy =
    health.status === 200 &&
    health.body?.healthy === true &&
    ['in-memory', 'pinecone', 'disabled'].includes(health.body?.mode);

  const healthRbacProtected = health.status === 403;

  record(
    'RAG /api/rag/health',
    healthy || healthRbacProtected,
    healthy
      ? `mode=${health.body.mode}, vectors=${health.body.stats?.totalVectors ?? 0}`
      : healthRbacProtected
        ? 'RBAC protected; retrieval probe will validate RAG availability'
        : `HTTP ${health.status} · ${JSON.stringify(health.body)}`,
  );

  const stats = await requestJson('/api/rag/stats', {
    headers: authHeaders,
  });

  const hasVectors =
    stats.status === 200 && typeof stats.body?.totalVectors === 'number' && stats.body.totalVectors > 0;

  const statsRbacProtected = stats.status === 403;

  record(
    'RAG corpus indexed',
    hasVectors || statsRbacProtected,
    hasVectors
      ? `${stats.body.totalVectors} vectors · ${stats.body.embeddingModel}`
      : statsRbacProtected
        ? 'RBAC protected; guideline retrieval will validate indexed corpus'
        : `HTTP ${stats.status} · ${JSON.stringify(stats.body)}`,
  );

  if (token) {
    const query = await requestJson('/api/clinical-intelligence/guideline-rag/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        query: 'What is the hour-1 bundle for sepsis?',
        topK: 3,
      },
    });

    const hasEvidence =
      query.status === 200 &&
      query.body?.status === 'evidence_found' &&
      Array.isArray(query.body?.sources) &&
      query.body.sources.length > 0;

    record(
      'Guideline RAG retrieval',
      hasEvidence,
      hasEvidence
        ? `${query.body.sources.length} source(s), confidence=${query.body.confidence}`
        : `HTTP ${query.status} · ${JSON.stringify(query.body)}`,
    );
  }
} catch (error) {
  record('RAG probe', false, error instanceof Error ? error.message : String(error));
}

let failed = 0;
console.log(`CareDroid RAG verification (backend :${backendPort})\n`);

for (const check of checks) {
  const status = check.ok ? 'OK' : 'FAIL';
  if (!check.ok) failed += 1;
  console.log(`[${status}] ${check.label} — ${check.detail}`);
}

if (failed > 0) {
  console.log('\nEnsure backend is running with RAG_ENABLED=true and authenticated RAG access is available.');
  process.exit(1);
}

console.log('\nRAG pipeline is operational.');