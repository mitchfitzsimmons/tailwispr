const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const os = require('os');
const log = require('./logger');

const VALID_SAMPLE_RATES = [8000, 16000, 22050, 44100, 48000, 96000];

function attachWebSocket(server, config, audioPipeline, platform, triggerWispr) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });

  let activeClient = null;
  let isStreaming = false;
  let currentGain = 1.0;
  let wisprState = 'off';
  let connectedAddr = null;

  // Global PIN brute force protection by IP
  const pinAttemptsByIp = new Map();

  let vuInterval = null;
  let waitingInterval = null;
  let dotFrame = 0;

  function updateStatus() {
    const parts = [];
    if (connectedAddr) {
      parts.push(isStreaming ? '\x1b[32m● Streaming\x1b[0m' : '\x1b[33m● Connected\x1b[0m');
      if (isStreaming) {
        parts.push(audioPipeline.getVuBar(12));
        parts.push(`${audioPipeline.sampleRate / 1000}kHz`);
        parts.push(`Gain: ${Math.round(currentGain * 100)}%`);
      }
      if (wisprState !== 'off') {
        parts.push(`Wispr: ${wisprState}`);
      }
    } else {
      const dots = '.'.repeat((dotFrame % 3) + 1).padEnd(3);
      parts.push(`\x1b[2m○ Waiting for device${dots}\x1b[0m`);
    }
    log.status(parts);
  }

  function startWaitingAnimation() {
    if (waitingInterval || log.isVerbose()) return;
    dotFrame = 0;
    waitingInterval = setInterval(() => {
      dotFrame++;
      updateStatus();
    }, 500);
    updateStatus();
  }

  function stopWaitingAnimation() {
    if (waitingInterval) {
      clearInterval(waitingInterval);
      waitingInterval = null;
    }
  }

  function startVuUpdates() {
    stopWaitingAnimation();
    if (vuInterval || log.isVerbose()) return;
    vuInterval = setInterval(updateStatus, 100);
  }

  function stopVuUpdates() {
    if (vuInterval) {
      clearInterval(vuInterval);
      vuInterval = null;
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Reject cross-origin WebSocket connections (CSWSH protection)
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host;
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          log.debug('ws', `Rejected cross-origin connection from ${origin}`);
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const clientAddr = req.socket.remoteAddress;
    log.debug('ws', `Client connected: ${clientAddr}`);
    connectedAddr = clientAddr;
    stopWaitingAnimation();
    updateStatus();

    let authenticated = !config.pin;

    // Send initial info — omit server details until authenticated if PIN is set
    const serverDetails = {
      serverName: os.hostname(),
      platform: platform.os,
      wisprEnabled: config.wisprEnabled && platform.os === 'darwin',
      audioDevice: platform.audioDeviceName,
      sampleRate: config.sampleRate,
    };
    ws.send(JSON.stringify({
      type: 'connected',
      requiresPin: !!config.pin,
      ...(authenticated ? serverDetails : {}),
    }));

    if (activeClient && activeClient.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Another device is already streaming. You can take over when it disconnects.',
      }));
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        if (!authenticated) return;

        if (activeClient !== ws) {
          if (activeClient && activeClient.readyState === 1) {
            activeClient.send(JSON.stringify({
              type: 'error',
              message: 'Another device has taken over streaming',
            }));
          }
          activeClient = ws;
          isStreaming = true;
          log.debug('ws', `${clientAddr} is now the active streamer`);
          updateStatus();
        }

        audioPipeline.write(data);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (msg.type === 'auth') {
        if (!config.pin) {
          ws.send(JSON.stringify({ type: 'auth', success: true, ...serverDetails }));
          authenticated = true;
          return;
        }

        // Global rate limit by IP — max 10 attempts per minute
        const ipAttempts = pinAttemptsByIp.get(clientAddr) || { count: 0, resetAt: Date.now() + 60000 };
        if (Date.now() > ipAttempts.resetAt) {
          ipAttempts.count = 0;
          ipAttempts.resetAt = Date.now() + 60000;
        }
        ipAttempts.count++;
        pinAttemptsByIp.set(clientAddr, ipAttempts);

        if (ipAttempts.count > 10) {
          ws.send(JSON.stringify({ type: 'auth', success: false, error: 'Too many attempts — try again later' }));
          ws.close(4001, 'Rate limited');
          return;
        }

        // Timing-safe PIN comparison
        const pinOk = typeof msg.pin === 'string'
          && msg.pin.length === config.pin.length
          && crypto.timingSafeEqual(Buffer.from(msg.pin), Buffer.from(config.pin));

        if (pinOk) {
          authenticated = true;
          ws.send(JSON.stringify({ type: 'auth', success: true, ...serverDetails }));
        } else {
          ws.send(JSON.stringify({ type: 'auth', success: false, error: 'Invalid PIN' }));
        }
        return;
      }

      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
        return;
      }

      switch (msg.type) {
        case 'audio':
          if (msg.action === 'start') {
            const requestedRate = Number(msg.sampleRate);
            const sampleRate = VALID_SAMPLE_RATES.includes(requestedRate) ? requestedRate : config.sampleRate;
            // Store sample rate — ffmpeg starts lazily on first audio frame
            audioPipeline.sampleRate = sampleRate;
            activeClient = ws;
            isStreaming = true;
            ws.send(JSON.stringify({ type: 'status', streaming: true, ffmpegRunning: false }));
            log.debug('ws', `Audio streaming started (${sampleRate}Hz)`);
            startVuUpdates();
            updateStatus();
          } else if (msg.action === 'stop') {
            if (activeClient === ws) {
              audioPipeline.stop();
              isStreaming = false;
              activeClient = null;
            }
            stopVuUpdates();
            ws.send(JSON.stringify({ type: 'status', streaming: false, ffmpegRunning: false }));
            log.debug('ws', 'Audio streaming stopped');
            updateStatus();
          }
          break;

        case 'gain':
          if (typeof msg.value === 'number' && Number.isFinite(msg.value)) {
            currentGain = msg.value;
            audioPipeline.setVolume(msg.value);
            log.debug('ws', `Gain set to ${msg.value}`);
            updateStatus();
          }
          break;

        case 'wispr':
          if (!config.wisprEnabled || platform.os !== 'darwin') {
            ws.send(JSON.stringify({ type: 'wispr', status: 'error', error: 'Wispr not enabled' }));
            break;
          }
          try {
            const result = await triggerWispr(msg.action || 'toggle');
            wisprState = result === 'started' ? 'active' : 'off';
            ws.send(JSON.stringify({ type: 'wispr', status: result }));
            log.debug('ws', `Wispr ${result}`);
            updateStatus();
          } catch (err) {
            ws.send(JSON.stringify({ type: 'wispr', status: 'error', error: err.message }));
            log.error('ws', `Wispr trigger failed: ${err.message}`);
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown command: ${String(msg.type).slice(0, 50)}` }));
      }
    });

    ws.on('close', () => {
      log.debug('ws', `Client disconnected: ${clientAddr}`);
      if (activeClient === ws) {
        setTimeout(() => {
          if (activeClient === ws) {
            audioPipeline.stop();
            activeClient = null;
            isStreaming = false;
            wisprState = 'off';
            connectedAddr = null;
            stopVuUpdates();
            log.debug('ws', 'Active streamer disconnected, audio stopped');
            startWaitingAnimation();
          }
        }, 2000);
      } else {
        if (wss.clients.size <= 1) {
          connectedAddr = null;
          startWaitingAnimation();
        }
      }
    });

    ws.on('error', (err) => {
      log.error('ws', `Client error (${clientAddr}): ${err.message}`);
    });
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 10000);

  wss.on('close', () => {
    clearInterval(heartbeat);
    stopWaitingAnimation();
    stopVuUpdates();
  });

  wss.startWaiting = startWaitingAnimation;

  return wss;
}

module.exports = { attachWebSocket };
