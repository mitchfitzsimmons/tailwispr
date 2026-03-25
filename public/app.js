/* global AudioWorkletNode, AudioContext */

(function () {
  'use strict';

  // --- State ---
  let ws = null;
  let audioCtx = null;
  let micStream = null;
  let workletNode = null;
  let scriptProcessor = null;
  let isStreaming = false;
  let serverInfo = null;
  let wakeLock = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let wisprActive = false;
  let pingInterval = null;
  const MAX_RECONNECT_DELAY = 10000;

  // --- DOM Elements ---
  const pinScreen = document.getElementById('pin-screen');
  const mainScreen = document.getElementById('main-screen');
  const pinInput = document.getElementById('pin-input');
  const pinSubmit = document.getElementById('pin-submit');
  const pinError = document.getElementById('pin-error');
  const connectionStatus = document.getElementById('connection-status');
  const micToggle = document.getElementById('mic-toggle');
  const micIcon = document.getElementById('mic-icon');
  const micLabel = document.getElementById('mic-label');
  const vuCanvas = document.getElementById('vu-meter');
  const vuCtx = vuCanvas.getContext('2d');
  const gainSlider = document.getElementById('gain-slider');
  const gainValue = document.getElementById('gain-value');
  const wisprMode = document.getElementById('wispr-mode');
  const wisprAuto = document.getElementById('wispr-auto');
  const latencyDisplay = document.getElementById('latency-display');
  const deviceName = document.getElementById('device-name');

  // --- WebSocket Connection ---
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;

    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('[ws] Connected');
      setConnectionStatus('connected', 'Connected');
      reconnectDelay = 1000;
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        handleMessage(JSON.parse(event.data));
      } catch (e) {
        console.warn('[ws] Invalid message:', e);
      }
    };

    ws.onclose = () => {
      console.log('[ws] Disconnected');
      setConnectionStatus('disconnected', 'Disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      setConnectionStatus('error', 'Connection Error');
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      console.log('[ws] Reconnecting...');
      setConnectionStatus('connecting', 'Reconnecting...');
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // --- Message Handling ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        serverInfo = msg;
        deviceName.textContent = msg.audioDevice || '';
        if (msg.requiresPin) {
          showScreen('pin');
        } else {
          showScreen('main');
          setupUI();
        }
        break;

      case 'auth':
        if (msg.success) {
          // Server details arrive with auth success when PIN is set
          if (msg.audioDevice) {
            serverInfo = { ...serverInfo, ...msg };
            deviceName.textContent = msg.audioDevice || '';
          }
          showScreen('main');
          setupUI();
        } else {
          pinError.textContent = msg.error || 'Invalid PIN';
          pinError.classList.remove('hidden');
          pinInput.value = '';
          pinInput.focus();
        }
        break;

      case 'status':
        // Pipeline status update
        break;

      case 'wispr':
        if (msg.status === 'started') {
          wisprActive = true;
        } else if (msg.status === 'stopped') {
          wisprActive = false;
        }
        break;

      case 'pong':
        if (msg.timestamp) {
          const rtt = Date.now() - msg.timestamp;
          latencyDisplay.textContent = `${Math.round(rtt / 2)}ms`;
        }
        break;

      case 'error':
        console.warn('[server]', msg.message);
        break;
    }
  }

  // --- Screen Management ---
  function showScreen(name) {
    pinScreen.classList.toggle('hidden', name !== 'pin');
    mainScreen.classList.toggle('hidden', name !== 'main');
  }

  function setupUI() {
    // Show/hide Wispr toggle based on server capabilities
    if (serverInfo && serverInfo.wisprEnabled) {
      wisprMode.classList.remove('hidden');
    } else {
      wisprMode.classList.add('hidden');
    }
  }

  // --- PIN Auth ---
  pinSubmit.addEventListener('click', () => {
    const pin = pinInput.value.trim();
    if (pin) {
      send({ type: 'auth', pin });
      pinError.classList.add('hidden');
    }
  });

  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pinSubmit.click();
  });

  // --- Microphone ---
  micToggle.addEventListener('click', async () => {
    if (isStreaming) {
      stopStreaming();
    } else {
      await startStreaming();
    }
  });

  async function startStreaming() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });

      audioCtx = new AudioContext({ sampleRate: 48000 });

      // iOS Safari requires resume inside user gesture
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const source = audioCtx.createMediaStreamSource(micStream);
      const actualSampleRate = audioCtx.sampleRate;

      // Tell server we're starting with the actual sample rate
      send({ type: 'audio', action: 'start', sampleRate: actualSampleRate });

      // Auto-trigger Wispr when mic starts (if toggle is on)
      if (serverInfo && serverInfo.wisprEnabled && wisprAuto.checked && !wisprActive) {
        send({ type: 'wispr', action: 'start' });
      }

      // Try AudioWorklet first, fall back to ScriptProcessor
      if (typeof AudioWorkletNode !== 'undefined') {
        try {
          await audioCtx.audioWorklet.addModule('worklet-processor.js');
          workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');

          workletNode.port.onmessage = (event) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(event.data.buffer);
            }
            updateVuMeter(event.data);
          };

          source.connect(workletNode);
          // Connect to destination to keep processing alive (muted)
          const gain = audioCtx.createGain();
          gain.gain.value = 0;
          workletNode.connect(gain);
          gain.connect(audioCtx.destination);
        } catch (err) {
          console.warn('[audio] AudioWorklet failed, using ScriptProcessor:', err.message);
          startWithScriptProcessor(source);
        }
      } else {
        startWithScriptProcessor(source);
      }

      isStreaming = true;
      micToggle.classList.add('active');
      micIcon.textContent = '\u23F9'; // Stop icon
      micLabel.textContent = 'Tap to Stop';

      // Request wake lock to prevent screen from turning off
      requestWakeLock();

      // Start VU meter and latency pings
      startVuMeter();
      startPingLoop();

      console.log(`[audio] Streaming at ${actualSampleRate}Hz`);
    } catch (err) {
      console.error('[audio] Failed to start:', err);
      if (err.name === 'NotAllowedError') {
        setConnectionStatus('error', 'Mic permission denied');
      } else {
        setConnectionStatus('error', 'Mic error: ' + err.message);
      }
    }
  }

  function startWithScriptProcessor(source) {
    // Fallback for browsers without AudioWorklet support
    scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptProcessor.onaudioprocess = (e) => {
      const pcmData = e.inputBuffer.getChannelData(0);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new Float32Array(pcmData).buffer);
      }
      updateVuMeter(pcmData);
    };
    source.connect(scriptProcessor);
    scriptProcessor.connect(audioCtx.destination);
  }

  function stopStreaming() {
    // Auto-stop Wispr when mic stops (if toggle is on)
    if (serverInfo && serverInfo.wisprEnabled && wisprAuto.checked && wisprActive) {
      send({ type: 'wispr', action: 'stop' });
    }

    send({ type: 'audio', action: 'stop' });

    if (workletNode) {
      workletNode.disconnect();
      workletNode = null;
    }
    if (scriptProcessor) {
      scriptProcessor.disconnect();
      scriptProcessor = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }

    isStreaming = false;
    micToggle.classList.remove('active');
    micIcon.textContent = '\uD83C\uDF99'; // Mic icon
    micLabel.textContent = 'Tap to Start';

    releaseWakeLock();
    clearVuMeter();
    stopPingLoop();
  }

  // --- VU Meter ---
  let vuLevel = 0;
  let vuAnimFrame = null;

  function updateVuMeter(samples) {
    // Calculate RMS level
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length);
    // Convert to a 0-1 range with some headroom
    vuLevel = Math.min(1, rms * 4);
  }

  function drawVuMeter() {
    const dpr = window.devicePixelRatio || 1;

    // Resize canvas for DPR if needed
    const displayWidth = vuCanvas.clientWidth;
    const displayHeight = vuCanvas.clientHeight;
    if (vuCanvas.width !== displayWidth * dpr || vuCanvas.height !== displayHeight * dpr) {
      vuCanvas.width = displayWidth * dpr;
      vuCanvas.height = displayHeight * dpr;
      vuCtx.scale(dpr, dpr);
    }

    const w = displayWidth;
    const h = displayHeight;

    vuCtx.clearRect(0, 0, w, h);

    // Background bar
    vuCtx.fillStyle = '#1a1a2e';
    vuCtx.roundRect(0, 0, w, h, 8);
    vuCtx.fill();

    // Level bar
    const barWidth = w * vuLevel;
    if (barWidth > 0) {
      const gradient = vuCtx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, '#00d26a');
      gradient.addColorStop(0.6, '#f5c211');
      gradient.addColorStop(1, '#f44336');

      vuCtx.fillStyle = gradient;
      vuCtx.beginPath();
      vuCtx.roundRect(0, 0, barWidth, h, 8);
      vuCtx.fill();
    }

    // Smooth decay
    vuLevel *= 0.92;

    vuAnimFrame = requestAnimationFrame(drawVuMeter);
  }

  function startVuMeter() {
    if (vuAnimFrame) return;
    drawVuMeter();
  }

  function clearVuMeter() {
    vuLevel = 0;
    if (vuAnimFrame) {
      cancelAnimationFrame(vuAnimFrame);
      vuAnimFrame = null;
    }
    const w = vuCanvas.clientWidth;
    const h = vuCanvas.clientHeight;
    vuCtx.clearRect(0, 0, w, h);
  }

  // --- Gain Control ---
  let gainDebounce = null;

  gainSlider.addEventListener('input', () => {
    const pct = gainSlider.value;
    gainValue.textContent = pct + '%';

    clearTimeout(gainDebounce);
    gainDebounce = setTimeout(() => {
      send({ type: 'gain', value: pct / 100 });
    }, 50);
  });

  // --- Connection Status ---
  function setConnectionStatus(state, text) {
    connectionStatus.textContent = text;
    connectionStatus.className = 'status-pill ' + state;
  }

  // --- Latency Ping ---
  function startPingLoop() {
    if (pingInterval) return;
    pingInterval = setInterval(() => {
      send({ type: 'ping', timestamp: Date.now() });
    }, 5000);
  }

  function stopPingLoop() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }

  // --- Wake Lock ---
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
    } catch {
      // Wake Lock not supported or denied
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
  }

  // --- Init ---
  setConnectionStatus('connecting', 'Connecting...');
  connect();
})();
