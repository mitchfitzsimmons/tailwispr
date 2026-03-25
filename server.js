const { loadConfig } = require('./src/config');
const { detectPlatform } = require('./src/platform');
const { AudioPipeline } = require('./src/audio-pipeline');
const { createServer } = require('./src/http-server');
const { attachWebSocket } = require('./src/websocket');
const { triggerWispr } = require('./src/wispr');
const log = require('./src/logger');
const { generateQR } = require('./src/qrcode');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Detect Tailscale info early — needed for cert generation
const tailscaleIp = getTailscaleIp();
const tailscaleHostname = getTailscaleHostname();

// Auto-generate TLS certs if Tailscale is available but no certs configured
let config = loadConfig();
if (!config.tlsCert && tailscaleHostname) {
  const certsDir = path.join(__dirname, 'certs');
  const certFile = path.join(certsDir, `${tailscaleHostname}.crt`);
  const keyFile = path.join(certsDir, `${tailscaleHostname}.key`);

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    log.debug('tailwispr', `Using existing TLS certs for ${tailscaleHostname}`);
    config = { ...config, tlsCert: certFile, tlsKey: keyFile };
  } else {
    log.info(`[tailwispr] Generating TLS certs for ${tailscaleHostname}...`);
    const tailscaleBin = findTailscaleBin();
    if (tailscaleBin) {
      try {
        fs.mkdirSync(certsDir, { recursive: true });
        execSync(
          `"${tailscaleBin}" cert --cert-file "${certFile}" --key-file "${keyFile}" "${tailscaleHostname}"`,
          { stdio: 'pipe', timeout: 15000 }
        );
        log.info('[tailwispr] TLS certs generated');
        config = { ...config, tlsCert: certFile, tlsKey: keyFile };
      } catch {
        log.warn('tailwispr', 'Could not generate TLS certs — running HTTP only');
        log.warn('tailwispr', 'Enable HTTPS in Tailscale admin: https://tailscale.com/kb/1153/enabling-https');
      }
    } else {
      log.warn('tailwispr', 'Tailscale CLI not found — install with: brew install tailscale');
    }
  }
}

// Detect platform and audio device
log.debug('tailwispr', 'Detecting platform...');
const platform = detectPlatform(config);

// Create audio pipeline
const audioPipeline = new AudioPipeline(config, platform);

// Create HTTP/HTTPS server
const server = createServer(config);

// Attach WebSocket handler
const wss = attachWebSocket(server, config, audioPipeline, platform, triggerWispr);

// Start listening
server.listen(config.port, () => {
  const protocol = server._isTLS ? 'https' : 'http';

  // Build the phone URL
  let phoneUrl = `${protocol}://localhost:${config.port}`;
  if (tailscaleHostname) {
    phoneUrl = `${protocol}://${tailscaleHostname}:${config.port}`;
  } else if (tailscaleIp) {
    phoneUrl = `${protocol}://${tailscaleIp}:${config.port}`;
  }

  // Clear terminal and show startup banner
  if (!log.isVerbose()) {
    process.stdout.write('\x1b[2J\x1b[H');
  }
  log.info('');
  log.info('  ╔══════════════════════════════════════╗');
  log.info('  ║          TailWispr running!          ║');
  log.info('  ╚══════════════════════════════════════╝');
  log.info('');

  // QR code via qrencode CLI (if available)
  printQRCode(phoneUrl);

  log.info(`  URL:    ${phoneUrl}`);
  log.info(`  Audio:  ${platform.audioDeviceName}`);
  if (config.wisprEnabled && platform.os === 'darwin') {
    log.info('  Wispr:  enabled');
  }
  if (config.pin) {
    log.info('  PIN:    enabled');
  }
  if (!server._isTLS && tailscaleIp) {
    log.info('');
    log.info('  ⚠ No HTTPS — phone mic access may not work.');
    log.info('  Enable HTTPS: https://tailscale.com/kb/1153/enabling-https');
    log.info('  Install CLI:  brew install tailscale');
  }
  log.info('');
  log.info('  Scan the QR code or open the URL on your phone.');
  if (log.isVerbose()) {
    log.info('  (verbose mode — full logs enabled)');
  } else {
    log.info('  (use --verbose for detailed logs)');
  }
  log.info('');

  log.info('  Press q to quit.');
  log.info('');

  // Start the waiting animation after banner
  wss.startWaiting();
});

// Listen for 'q' keypress to quit
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key) => {
    // q or Q or Ctrl+C
    if (key[0] === 0x71 || key[0] === 0x51 || key[0] === 0x03) {
      shutdown();
    }
  });
}

// Graceful shutdown
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.cleanup();
  log.info('\n[tailwispr] Shutting down...');
  audioPipeline.stop();
  platform.cleanup().then(() => {
    server.close(() => {
      log.info('[tailwispr] Goodbye!');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- QR Code ---

function printQRCode(url) {
  const qr = generateQR(url);
  if (qr) {
    const indented = qr.split('\n').map((line) => '  ' + line).join('\n');
    log.info(indented);
  }
}

// --- Tailscale helpers ---

function getTailscaleIp() {
  try {
    const interfaces = os.networkInterfaces();
    for (const [, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && addr.address.startsWith('100.')) {
          return addr.address;
        }
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

function getTailscaleHostname() {
  const bin = findTailscaleBin();
  if (!bin) return null;
  try {
    const json = execSync(`"${bin}" status --json`, { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
    const data = JSON.parse(json);
    const dns = data.Self && data.Self.DNSName;
    return dns ? dns.replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

function findTailscaleBin() {
  const candidates = [
    'tailscale',
    '/usr/local/bin/tailscale',
    '/usr/bin/tailscale',
    '/usr/sbin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const bin of candidates) {
    try {
      execSync(`"${bin}" version`, { stdio: 'pipe', timeout: 3000 });
      return bin;
    } catch {
      continue;
    }
  }
  return null;
}
