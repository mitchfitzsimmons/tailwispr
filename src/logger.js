const verbose = process.argv.includes('--verbose') || process.argv.includes('-v') || process.env.TAILWISPR_VERBOSE === '1';

let statusLine = '';
let statusActive = false;

function clearStatus() {
  if (statusActive) {
    process.stdout.write('\r\x1b[K');
    statusActive = false;
  }
}

const logger = {
  // Always prints — startup messages, important events
  info(...args) {
    clearStatus();
    console.log(...args);
  },

  // Always prints errors
  error(prefix, msg) {
    clearStatus();
    console.error(`[${prefix}] ${msg}`);
  },

  // Always prints warnings
  warn(prefix, msg) {
    clearStatus();
    console.warn(`[${prefix}] ${msg}`);
  },

  // Only in verbose mode — detailed protocol/connection logs
  debug(prefix, msg) {
    if (!verbose) return;
    clearStatus();
    console.log(`[${prefix}] ${msg}`);
  },

  // Single-line status that updates in-place (normal mode)
  // In verbose mode, prints as a regular log line
  status(parts) {
    const line = parts.filter(Boolean).join(' | ');
    if (verbose) {
      console.log(`[status] ${line}`);
    } else {
      statusLine = line;
      process.stdout.write(`\r\x1b[K  ${line}`);
      statusActive = true;
    }
  },

  isVerbose() {
    return verbose;
  },

  // Ensure clean exit (newline after status line)
  cleanup() {
    if (statusActive) {
      process.stdout.write('\n');
      statusActive = false;
    }
  },
};

module.exports = logger;
