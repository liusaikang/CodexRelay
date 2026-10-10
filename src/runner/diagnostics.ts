import { AppError } from '../types.js';

const descriptions = {
  CODEX_AUTH_FAILED: 'Model authentication was rejected. Check the provider login or API credential.',
  CODEX_RATE_LIMITED: 'The model provider rejected the request because of a rate or quota limit.',
  CODEX_NETWORK_ERROR: 'The model connection was interrupted. Check the network and proxy.',
  CODEX_CONTEXT_LIMIT: 'The model rejected the request because its context limit was exceeded.',
  CODEX_MODEL_UNAVAILABLE: 'The selected model was not found or is unavailable to this account.',
  CODEX_UPSTREAM_ERROR: 'The model provider returned a server error. Retry after the provider recovers.',
  CODEX_EXEC_FAILED: 'The Codex SDK or CLI failed before completing the request. Check the CLI installation and service environment.',
  CODEX_FAILED: 'Codex reported an unclassified execution error.',
  WORKER_EXITED: 'The Codex worker exited before returning a result.',
} as const;

export type CodexDiagnosticCode = keyof typeof descriptions;
export type CodexDiagnosticOrigin = 'turn.failed' | 'stream.error' | 'sdk.exception' | 'worker.exit';

export function isCodexDiagnostic(code: string, origin: string | undefined): code is CodexDiagnosticCode {
  return Object.hasOwn(descriptions, code) &&
    (origin === 'turn.failed' || origin === 'stream.error' || origin === 'sdk.exception' || origin === 'worker.exit');
}

export class CodexDiagnosticError extends AppError {
  constructor(code: CodexDiagnosticCode, readonly origin: CodexDiagnosticOrigin, readonly exitCode?: number) {
    const exit = origin === 'worker.exit' && Number.isInteger(exitCode) && exitCode! >= 0 && exitCode! <= 255
      ? ` Exit code ${exitCode}.` : '';
    super(code, `${origin}: ${descriptions[code]}${exit}`);
  }
}

export function classifyCodexFailure(origin: Exclude<CodexDiagnosticOrigin, 'worker.exit'>, raw: unknown): CodexDiagnosticError {
  const message = typeof raw === 'string' ? raw : '';
  let code: CodexDiagnosticCode = origin === 'sdk.exception' ? 'CODEX_EXEC_FAILED' : 'CODEX_FAILED';
  if (/\b(?:401|403)\b|unauthorized|unauthenticated|invalid[_ -]?(?:api[_ -]?)?key|authentication/i.test(message))
    code = 'CODEX_AUTH_FAILED';
  else if (/\b429\b|rate[_ -]?limit|quota|insufficient[_ -]?(?:balance|credits)/i.test(message))
    code = 'CODEX_RATE_LIMITED';
  else if (/context[_ -]?length|context window|maximum context|too many tokens|prompt is too long/i.test(message))
    code = 'CODEX_CONTEXT_LIMIT';
  else if (/model[_ -]?not[_ -]?found|model .*not (?:found|available)|unknown model|unsupported model/i.test(message))
    code = 'CODEX_MODEL_UNAVAILABLE';
  else if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection reset|disconnected|timed? out|deadline exceeded|proxy|DNS|TLS|fetch failed|network error/i.test(message))
    code = 'CODEX_NETWORK_ERROR';
  else if (/\b5\d\d\b|upstream|internal server error|service unavailable|bad gateway/i.test(message))
    code = 'CODEX_UPSTREAM_ERROR';
  return new CodexDiagnosticError(code, origin);
}
