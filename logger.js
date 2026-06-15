'use strict';
/* ============================================================
   WORK RADAR — structured logger (main process)
   Emits one JSON object per line. Errors go to stderr, everything
   else to stdout. Set LOG_LEVEL=DEBUG|INFO|WARNING|ERROR|CRITICAL
   to change verbosity (default INFO).
   ============================================================ */

const SERVICE = 'work-radar-main';
const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

// Pull an Error out of the context and flatten it to serialisable fields.
function expand(ctx) {
  if (!ctx) return {};
  if (ctx.err instanceof Error) {
    const { err, ...rest } = ctx;
    return { ...rest, error: err.message, code: err.code, stack: err.stack };
  }
  return ctx;
}

function emit(level, msg, ctx) {
  if (LEVELS[level] < MIN) return;
  const record = { ts: new Date().toISOString(), level, service: SERVICE, msg, ...expand(ctx) };
  const line = JSON.stringify(record) + '\n';
  if (LEVELS[level] >= LEVELS.ERROR) process.stderr.write(line);
  else process.stdout.write(line);
}

module.exports = {
  debug: (msg, ctx) => emit('DEBUG', msg, ctx),
  info: (msg, ctx) => emit('INFO', msg, ctx),
  warn: (msg, ctx) => emit('WARNING', msg, ctx),
  error: (msg, ctx) => emit('ERROR', msg, ctx),
  critical: (msg, ctx) => emit('CRITICAL', msg, ctx),
};
