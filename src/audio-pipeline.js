const { spawn } = require('child_process');
const log = require('./logger');

const VU_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

class AudioPipeline {
  constructor(config, platform) {
    this.config = config;
    this.platform = platform;
    this.ffmpeg = null;
    this.sampleRate = config.sampleRate;
    this.channels = config.channels;
    this.volume = 1.0;
    this._restarting = false;
    this._stopping = false;
    this._level = 0;
  }

  start(sampleRate) {
    if (this.ffmpeg) return;

    if (sampleRate) {
      this.sampleRate = sampleRate;
    }

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-f', 'f32le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      '-i', 'pipe:0',
      '-af', `volume=${this.volume}`,
      ...this.platform.ffmpegOutputArgs,
    ];

    log.debug('audio', `Starting ffmpeg → ${this.platform.audioDeviceName} (${this.sampleRate}Hz)`);

    this.ffmpeg = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log.debug('ffmpeg', msg);
    });

    this.ffmpeg.on('error', (err) => {
      log.error('audio', `ffmpeg error: ${err.message}`);
      this.ffmpeg = null;
    });

    this.ffmpeg.on('close', (code) => {
      if (code !== 0 && !this._restarting && !this._stopping) {
        log.debug('audio', `ffmpeg exited with code ${code}`);
      }
      this.ffmpeg = null;
    });

    this.ffmpeg.stdin.on('error', () => {
      // Silently ignore — ffmpeg may have exited
    });
  }

  write(pcmBuffer) {
    if (!this.ffmpeg) {
      this.start();
    }

    // Calculate audio level from PCM for VU meter
    this._updateLevel(pcmBuffer);

    if (this.ffmpeg && this.ffmpeg.stdin.writable) {
      return this.ffmpeg.stdin.write(Buffer.from(pcmBuffer));
    }
    return false;
  }

  _updateLevel(buffer) {
    // Normalize to a properly-aligned Buffer, then read Float32LE samples
    const buf = Buffer.from(buffer);
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    let sum = 0;
    for (let i = 0; i < floats.length; i++) {
      sum += floats[i] * floats[i];
    }
    const rms = Math.sqrt(sum / floats.length);
    // Smooth with decay
    this._level = Math.max(rms * 4, this._level * 0.85);
  }

  getVuBar(width) {
    const level = Math.min(1, this._level);
    const chars = [];
    for (let i = 0; i < width; i++) {
      const threshold = i / width;
      if (level > threshold) {
        const intensity = Math.min(7, Math.floor((level - threshold) * width * 8));
        chars.push(VU_BARS[intensity]);
      } else {
        chars.push(' ');
      }
    }

    // Colorize: green → yellow → red
    const bar = chars.join('');
    const greenEnd = Math.floor(width * 0.6);
    const yellowEnd = Math.floor(width * 0.8);
    const green = bar.substring(0, greenEnd);
    const yellow = bar.substring(greenEnd, yellowEnd);
    const red = bar.substring(yellowEnd);

    return `\x1b[32m${green}\x1b[33m${yellow}\x1b[31m${red}\x1b[0m`;
  }

  setVolume(gain) {
    this.volume = Math.max(0, Math.min(5, gain));
    if (this.ffmpeg) {
      this._restart();
    }
  }

  _restart() {
    this._restarting = true;
    this.stop();
    this._restarting = false;
    this.start();
  }

  stop() {
    if (this.ffmpeg) {
      this._stopping = true;
      log.debug('audio', 'Stopping ffmpeg');
      try {
        this.ffmpeg.stdin.end();
        this.ffmpeg.kill('SIGTERM');
      } catch {
        // Ignore
      }
      this.ffmpeg = null;
      this._stopping = false;
      this._level = 0;
    }
  }

  isRunning() {
    return this.ffmpeg !== null;
  }
}

module.exports = { AudioPipeline };
