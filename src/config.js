const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  port: 3000,
  tlsCert: null,
  tlsKey: null,
  sampleRate: 48000,
  channels: 1,
  bufferSize: 4096,
  audioDevice: null,
  wisprEnabled: true,
  pin: null,
};

function loadConfig() {
  let fileConfig = {};
  const configPath = path.join(__dirname, '..', 'config.json');

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      console.error(`[config] Failed to parse config.json: ${err.message}`);
      console.error('[config] Using defaults');
    }
  }

  // Environment variable overrides
  const envOverrides = {};
  if (process.env.TAILWISPR_PORT) envOverrides.port = parseInt(process.env.TAILWISPR_PORT, 10);
  if (process.env.TAILWISPR_TLS_CERT) envOverrides.tlsCert = process.env.TAILWISPR_TLS_CERT;
  if (process.env.TAILWISPR_TLS_KEY) envOverrides.tlsKey = process.env.TAILWISPR_TLS_KEY;
  if (process.env.TAILWISPR_AUDIO_DEVICE) envOverrides.audioDevice = process.env.TAILWISPR_AUDIO_DEVICE;
  if (process.env.TAILWISPR_PIN) envOverrides.pin = process.env.TAILWISPR_PIN;
  if (process.env.TAILWISPR_SAMPLE_RATE) envOverrides.sampleRate = parseInt(process.env.TAILWISPR_SAMPLE_RATE, 10);
  if (process.env.TAILWISPR_BUFFER_SIZE) envOverrides.bufferSize = parseInt(process.env.TAILWISPR_BUFFER_SIZE, 10);

  const config = { ...DEFAULTS, ...fileConfig, ...envOverrides };

  // Validate
  if (config.tlsCert && !fs.existsSync(config.tlsCert)) {
    console.error(`[config] TLS cert not found: ${config.tlsCert}`);
    config.tlsCert = null;
    config.tlsKey = null;
  }
  if (config.tlsKey && !fs.existsSync(config.tlsKey)) {
    console.error(`[config] TLS key not found: ${config.tlsKey}`);
    config.tlsCert = null;
    config.tlsKey = null;
  }

  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    console.error(`[config] Invalid port ${config.port}, using 3000`);
    config.port = 3000;
  }

  const validSampleRates = [8000, 16000, 22050, 44100, 48000, 96000];
  if (!validSampleRates.includes(config.sampleRate)) {
    console.error(`[config] Invalid sampleRate ${config.sampleRate}, using 48000`);
    config.sampleRate = 48000;
  }

  if (!Number.isFinite(config.channels) || config.channels < 1 || config.channels > 2) {
    config.channels = 1;
  }

  if (!Number.isFinite(config.bufferSize) || config.bufferSize < 256 || config.bufferSize > 16384) {
    config.bufferSize = 4096;
  }

  return Object.freeze(config);
}

module.exports = { loadConfig };
