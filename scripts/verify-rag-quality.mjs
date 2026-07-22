#!/usr/bin/env node
/**
 * CareDroid RAG quality evaluation.
 *
 * Loads qa/rag-eval/clinical_eval_v1.json, runs each case through the
 * guideline RAG endpoint, measures latency and quality heuristics, and writes
 * a baseline report to reports/rag_quality_baseline_v1.md.
 *
 * Default behavior:
 * - Does not fail the process when quality cases fail.
 * - Produces a baseline report so we can improve the RAG corpus and retrieval logic.
 *
 * Strict behavior:
 * - Set STRICT_RAG_EVAL=true to exit non-zero when any case fails.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';

const backendPort = Number.parseInt(process.env.BACKEND_PORT || process.env.PORT || '3350', 10);
const strictMode = String(process.env.STRICT_RAG_EVAL || '').toLowerCase() === 'true';

const evalPath = path.join(process.cwd(), 'qa', 'rag-eval', 'clinical_eval_v1.json');
const reportsDir = path.join(process.cwd(), 'reports');
const markdownReportPath = path.join(reportsDir, 'rag_quality_baseline_v1.md');
const jsonReportPath = path.join(reportsDir, 'rag_quality_baseline_v1.json');

const requestJson = (requestPath, { method = 'GET', body, headers = {} } = {}) =>
  new Promise((resolveRequest) => {
    const startedAt = performance.now();
    const payload = body ? JSON.stringify(body) : undefined;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveRequest(result);
    };

    const req = http.request(
      {
        host: '127.0.0.1',
        port: backendPort,
        path: requestPath,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
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

          finish({
            status: res.statusCode || 0,
            body: parsed,
            raw,
            latencyMs: Math.round(performance.now() - startedAt),
          });
        });
      },
    );

    req.on('timeout', () => {
      finish({
        status: 0,
        body: {
          status: 'request_timeout',
          error: `timeout ${method} ${requestPath}`,
        },
        raw: '',
        latencyMs: Math.round(performance.now() - startedAt),
      });

      req.destroy();
    });

    req.on('error', (error) => {
      finish({
        status: 0,
        body: {
          status: 'request_error',
          error: error instanceof Error ? error.message : String(error),
        },
        raw: '',
        latencyMs: Math.round(performance.now() - startedAt),
      });
    });

    if (payload) req.write(payload);
    req.end();
  });

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function flattenResponseText(body) {
  return normalizeText(
    [
      body?.status,
      body?.error,
      body?.summary?.unsupportedClaimNotice,
      ...(Array.isArray(body?.summary?.recommendations) ? body.summary.recommendations : []),
      ...(Array.isArray(body?.citations)
        ? body.citations.map((citation) =>
            [
              citation.label,
              citation.text,
              citation.excerpt,
              citation.sourceTitle,
              citation.chunkId,
            ].join(' '),
          )
        : []),
      ...(Array.isArray(body?.sources)
        ? body.sources.map((source) =>
            [
              source.title,
              source.organization,
              source.type,
              source.url,
              source.evidenceLevel,
              source.citationLabel,
            ].join(' '),
          )
        : []),
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(normalizeText(term)));
}

function missingTerms(text, terms) {
  return terms.filter((term) => !text.includes(normalizeText(term)));
}

function presentTerms(text, terms) {
  return terms.filter((term) => text.includes(normalizeText(term)));
}

function scoreCase(testCase, response) {
  const body = response.body || {};
  const text = flattenResponseText(body);

  const sourceCount = Array.isArray(body.sources) ? body.sources.length : 0;
  const citationCount = Array.isArray(body.citations) ? body.citations.length : 0;
  const recommendationCount = Array.isArray(body.summary?.recommendations)
    ? body.summary.recommendations.length
    : 0;

  const confidence = typeof body.confidence === 'number' ? body.confidence : 0;
  const expectedTerms = testCase.expectedTerms || [];
  const forbiddenTerms = testCase.forbiddenTerms || [];

  const expectedMissing = missingTerms(text, expectedTerms);
  const forbiddenPresent = presentTerms(text, forbiddenTerms);

  const returnedEvidence = body.status === 'evidence_found' && sourceCount > 0;
  const expectedTermRecall =
    expectedTerms.length === 0
      ? 1
      : (expectedTerms.length - expectedMissing.length) / expectedTerms.length;

  const citationPrecisionProxy =
    sourceCount === 0 && citationCount === 0
      ? 1
      : citationCount > 0 && sourceCount > 0
        ? Math.min(citationCount / sourceCount, 1)
        : 0;

  const groundednessProxy =
    returnedEvidence && citationCount > 0 && recommendationCount > 0 && forbiddenPresent.length === 0
      ? 1
      : 0;

  const unsupportedClaimRisk = forbiddenPresent.length > 0 ? 1 : 0;

  const escalationTerms = [
    'emergency',
    'urgent',
    'immediate',
    'clinician',
    'human review',
    'review',
    'protocol',
    'safety',
  ];

  const emergencyEscalationHit = testCase.requiresEmergencyEscalation
    ? includesAny(text, escalationTerms)
    : true;

  const failures = [];
  const warnings = [];

  if (response.status !== 200) {
    failures.push(
      response.status === 0
        ? `NETWORK_ERROR: ${body.error || 'unknown request failure'}`
        : `HTTP ${response.status}`,
    );
  }

  if (testCase.shouldReturnEvidence && !returnedEvidence) {
    failures.push('expected evidence but no evidence_found response');
  }

  if (!testCase.shouldReturnEvidence && returnedEvidence && testCase.category === 'irrelevant_question') {
    failures.push('irrelevant question returned clinical evidence');
  }

  if (forbiddenPresent.length > 0) {
    failures.push(`forbidden terms present: ${forbiddenPresent.join(', ')}`);
  }

  if (expectedMissing.length > 0) {
    warnings.push(`missing expected terms: ${expectedMissing.join(', ')}`);
  }

  if (testCase.requiresEmergencyEscalation && !emergencyEscalationHit) {
    warnings.push('missing emergency escalation signal');
  }

  return {
    id: testCase.id,
    version: testCase.version,
    category: testCase.category,
    riskLevel: testCase.riskLevel,
    query: testCase.query,
    ok: failures.length === 0,
    failures,
    warnings,
    status: body.status || 'unknown',
    confidence,
    latencyMs: response.latencyMs,
    sourceCount,
    citationCount,
    recommendationCount,
    expectedTermRecall,
    citationPrecisionProxy,
    groundednessProxy,
    unsupportedClaimRisk,
    emergencyEscalationHit,
  };
}

function average(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function safeGit(command, fallback = 'unknown') {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function buildMarkdownReport({ results, summary, branch, commitSha, generatedAt }) {
  const failed = results.filter((result) => !result.ok);
  const warned = results.filter((result) => result.warnings.length > 0);

  const rows = results
    .map(
      (result) =>
        `| ${result.id} | ${result.category} | ${result.ok ? 'PASS' : 'FAIL'} | ${result.sourceCount} | ${result.citationCount} | ${result.confidence.toFixed(
          3,
        )} | ${result.latencyMs} ms | ${result.failures.join('; ') || '-'} | ${
          result.warnings.join('; ') || '-'
        } |`,
    )
    .join('\n');

  const failedRows =
    failed.length === 0
      ? '- No failed cases.'
      : failed.map((result) => `- ${result.id}: ${result.failures.join('; ')}`).join('\n');

  const warningRows =
    warned.length === 0
      ? '- No warning cases.'
      : warned.map((result) => `- ${result.id}: ${result.warnings.join('; ')}`).join('\n');

  return `# CareDroid RAG Quality Baseline v1

## Run Metadata

- Generated at: ${generatedAt}
- Branch: ${branch}
- Commit SHA: ${commitSha}
- Backend port: ${backendPort}
- Evaluation file: \`qa/rag-eval/clinical_eval_v1.json\`
- Total cases: ${summary.totalCases}

## Summary

| Metric | Value |
|---|---:|
| Passed cases | ${summary.passedCases}/${summary.totalCases} |
| Failed cases | ${summary.failedCases}/${summary.totalCases} |
| Warning cases | ${summary.warningCases}/${summary.totalCases} |
| Pass rate | ${formatPercent(summary.passRate)} |
| Average latency | ${summary.averageLatencyMs.toFixed(1)} ms |
| Average expected-term recall proxy | ${formatPercent(summary.averageExpectedTermRecall)} |
| Average citation precision proxy | ${formatPercent(summary.averageCitationPrecisionProxy)} |
| Average groundedness proxy | ${formatPercent(summary.averageGroundednessProxy)} |
| Unsupported claim risk rate | ${formatPercent(summary.unsupportedClaimRiskRate)} |
| Emergency escalation recall | ${formatPercent(summary.emergencyEscalationRecall)} |

## Case Results

| Case ID | Category | Result | Sources | Citations | Confidence | Latency | Failures | Warnings |
|---|---|---:|---:|---:|---:|---:|---|---|
${rows}

## Failed Cases

${failedRows}

## Warning Cases

${warningRows}

## Interpretation

This is a baseline evaluation, not a final quality score. Failures represent broken or unsafe behavior. Warnings represent quality gaps such as missing expected wording, weak escalation language, or corpus coverage limitations.

## Recommended Next Changes

1. Add Smart Intake, EMS handoff, AI safety, and contraindication documents to the local RAG corpus.
2. Separate clinical guideline retrieval from non-clinical or irrelevant queries.
3. Strengthen emergency escalation detection for high-risk scenarios.
4. Add source freshness metadata checks for outdated-source cases.
5. Add stricter citation grounding for any clinical recommendation text.
`;
}

async function main() {
  if (!fs.existsSync(evalPath)) {
    throw new Error(`Missing evaluation dataset: ${evalPath}`);
  }

  fs.mkdirSync(reportsDir, { recursive: true });

  const cases = JSON.parse(fs.readFileSync(evalPath, 'utf8'));

  console.log(`CareDroid RAG quality evaluation (backend :${backendPort})\n`);

  const devSession = await requestJson('/api/auth/dev-session', { method: 'POST' });
  const token = devSession.body?.accessToken;

  if (!token) {
    console.error(`[FAIL] Dev auth failed — HTTP ${devSession.status || 'NETWORK_ERROR'}`);
    console.error(JSON.stringify(devSession.body, null, 2));
    process.exit(1);
  }

  console.log('[OK] Dev auth — JWT issued');

  const results = [];

  for (const testCase of cases) {
    const response = await requestJson('/api/clinical-intelligence/guideline-rag/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        query: testCase.query,
        topK: testCase.topK || 5,
        minScore: testCase.minScore ?? 0.6,
      },
    });

    const result = scoreCase(testCase, response);
    results.push(result);

    const status = result.ok ? 'OK' : 'FAIL';
    const detail = result.ok
      ? `${result.sourceCount} source(s), ${result.citationCount} citation(s), latency=${result.latencyMs}ms${
          result.warnings.length > 0 ? `; warnings: ${result.warnings.join('; ')}` : ''
        }`
      : `${result.failures.join('; ')}${
          result.warnings.length > 0 ? `; warnings: ${result.warnings.join('; ')}` : ''
        }`;

    console.log(`[${status}] ${testCase.id} — ${detail}`);
  }

  const totalCases = results.length;
  const passedCases = results.filter((result) => result.ok).length;
  const failedCases = totalCases - passedCases;
  const warningCases = results.filter((result) => result.warnings.length > 0).length;

  const emergencyCases = results.filter((result) => {
    const original = cases.find((testCase) => testCase.id === result.id);
    return original?.requiresEmergencyEscalation;
  });

  const emergencyEscalationRecall =
    emergencyCases.length === 0
      ? 1
      : emergencyCases.filter((result) => result.emergencyEscalationHit).length / emergencyCases.length;

  const summary = {
    totalCases,
    passedCases,
    failedCases,
    warningCases,
    passRate: totalCases === 0 ? 0 : passedCases / totalCases,
    averageLatencyMs: average(results.map((result) => result.latencyMs)),
    averageExpectedTermRecall: average(results.map((result) => result.expectedTermRecall)),
    averageCitationPrecisionProxy: average(results.map((result) => result.citationPrecisionProxy)),
    averageGroundednessProxy: average(results.map((result) => result.groundednessProxy)),
    unsupportedClaimRiskRate: average(results.map((result) => result.unsupportedClaimRisk)),
    emergencyEscalationRecall,
  };

  const generatedAt = new Date().toISOString();
  const branch = safeGit('git branch --show-current');
  const commitSha = safeGit('git rev-parse --short HEAD');

  const report = {
    generatedAt,
    branch,
    commitSha,
    backendPort,
    evalPath: 'qa/rag-eval/clinical_eval_v1.json',
    summary,
    results,
  };

  fs.writeFileSync(jsonReportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(
    markdownReportPath,
    buildMarkdownReport({
      results,
      summary,
      branch,
      commitSha,
      generatedAt,
    }),
  );

  console.log('\nSummary');
  console.log(`Passed: ${passedCases}/${totalCases}`);
  console.log(`Failed: ${failedCases}/${totalCases}`);
  console.log(`Warnings: ${warningCases}/${totalCases}`);
  console.log(`Average latency: ${summary.averageLatencyMs.toFixed(1)} ms`);
  console.log(`Report: ${markdownReportPath}`);

  if (failedCases > 0 && strictMode) {
    process.exit(1);
  }

  console.log('\nRAG quality baseline completed.');
}

main().catch((error) => {
  console.error(`[FAIL] RAG quality evaluation crashed: ${error.message}`);
  process.exit(1);
});