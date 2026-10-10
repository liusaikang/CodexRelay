import { expect, it } from 'vitest';
import { classifyCodexFailure, CodexDiagnosticError } from '../src/runner/diagnostics.js';

it.each([
  ['401 Unauthorized: Bearer sk-private-token', 'CODEX_AUTH_FAILED'],
  ['429 Too Many Requests: quota exceeded', 'CODEX_RATE_LIMITED'],
  ['stream disconnected: ECONNRESET', 'CODEX_NETWORK_ERROR'],
  ['context_length_exceeded: prompt too long', 'CODEX_CONTEXT_LIMIT'],
  ['model_not_found: gpt-example', 'CODEX_MODEL_UNAVAILABLE'],
  ['upstream returned HTTP 503', 'CODEX_UPSTREAM_ERROR'],
] as const)('classifies SDK failure without exposing its raw message: %s', (raw, code) => {
  const error = classifyCodexFailure('turn.failed', raw);
  expect(error).toBeInstanceOf(CodexDiagnosticError);
  expect(error.code).toBe(code);
  expect(error.message).not.toContain(raw);
  expect(error.message).not.toContain('sk-private-token');
});

it('preserves a safe failure source for an unrecognized SDK error', () => {
  const error = classifyCodexFailure('stream.error', 'order 12345 secret private-data');
  expect(error.code).toBe('CODEX_FAILED');
  expect(error.message).toContain('stream.error');
  expect(error.message).not.toContain('private-data');
});

it('records a bounded worker exit code without persisting stderr', () => {
  const error = new CodexDiagnosticError('WORKER_EXITED', 'worker.exit', 7);
  expect(error.message).toMatch(/exit code 7/i);
});
