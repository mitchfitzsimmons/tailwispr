const os = require('os');
const { execSync, execFileSync } = require('child_process');

function detectPlatform(config) {
  const platform = os.platform();

  if (platform === 'darwin') {
    return detectMacOS(config);
  } else if (platform === 'linux') {
    return detectLinux(config);
  } else {
    console.error(`[platform] Unsupported platform: ${platform}`);
    console.error('[platform] TailWispr supports macOS and Linux');
    process.exit(1);
  }
}

function detectMacOS(config) {
  // Check ffmpeg
  try {
    execFileSync('which', ['ffmpeg'], { stdio: 'pipe' });
  } catch {
    console.error('[platform] ffmpeg not found. Install it with: brew install ffmpeg');
    process.exit(1);
  }

  // List CoreAudio devices via audiotoolbox output muxer
  // This shows ALL devices (input + output) with their indices
  let deviceOutput = '';
  try {
    const result = execSync(
      'ffmpeg -y -f lavfi -i anullsrc -t 0 -f audiotoolbox -list_devices true - 2>&1',
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    deviceOutput = result;
  } catch (err) {
    deviceOutput = err.stdout || err.stderr || '';
  }

  // Parse CoreAudio device lines: "[index] DeviceName, DeviceUID"
  const deviceLines = deviceOutput.split('\n').filter((line) => /\[\d+\]/.test(line));
  const devices = deviceLines.map((line) => {
    const match = line.match(/\[(\d+)\]\s+(.+)/);
    if (!match) return null;
    const fullText = match[2].trim();
    // Split name from UID at the first comma (UIDs can contain commas)
    const firstComma = fullText.indexOf(', ');
    const name = firstComma > 0 ? fullText.substring(0, firstComma).trim() : fullText;
    return { index: parseInt(match[1], 10), name };
  }).filter(Boolean);

  // Find the target device
  let targetDevice = null;

  if (config.audioDevice) {
    targetDevice = devices.find(
      (d) => d.name.toLowerCase().includes(config.audioDevice.toLowerCase())
        || d.index === parseInt(config.audioDevice, 10)
    );
    if (!targetDevice) {
      console.error(`[platform] Audio device "${config.audioDevice}" not found`);
      console.error('[platform] Available CoreAudio devices:');
      devices.forEach((d) => console.error(`  [${d.index}] ${d.name}`));
      process.exit(1);
    }
  } else {
    // Auto-detect virtual audio devices in priority order
    const priorities = ['blackhole 2ch', 'blackhole 16ch', 'loopback audio', 'vb-cable'];
    for (const name of priorities) {
      targetDevice = devices.find((d) => d.name.toLowerCase().includes(name));
      if (targetDevice) break;
    }
  }

  if (!targetDevice) {
    console.error('[platform] No virtual audio device found');
    console.error('[platform] Install BlackHole: brew install blackhole-2ch');
    if (devices.length > 0) {
      console.error('[platform] Available CoreAudio devices:');
      devices.forEach((d) => console.error(`  [${d.index}] ${d.name}`));
    }
    process.exit(1);
  }

  return {
    os: 'darwin',
    audioDeviceName: targetDevice.name,
    audioDeviceIndex: targetDevice.index,
    // audiotoolbox output requires: -f audiotoolbox -audio_device_index N <output>
    // The output filename is a placeholder — use "-" for pipe
    ffmpegOutputArgs: ['-f', 'audiotoolbox', '-audio_device_index', String(targetDevice.index), '-'],
    cleanup: async () => {},
  };
}

function detectLinux(config) {
  // Check ffmpeg
  try {
    execFileSync('which', ['ffmpeg'], { stdio: 'pipe' });
  } catch {
    console.error('[platform] ffmpeg not found. Install it with: sudo apt install ffmpeg');
    process.exit(1);
  }

  // Check PulseAudio/PipeWire
  try {
    execFileSync('pactl', ['info'], { stdio: 'pipe' });
  } catch {
    console.error('[platform] PulseAudio/PipeWire not found');
    console.error('[platform] Install PulseAudio: sudo apt install pulseaudio');
    process.exit(1);
  }

  // Create or find virtual sink
  const sinkName = 'TailWispr';
  let sinkModuleId = null;

  try {
    const sinks = execSync('pactl list short sinks', { encoding: 'utf-8', stdio: 'pipe' });
    if (!sinks.includes(sinkName)) {
      const result = execSync(
        `pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=${sinkName}`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      sinkModuleId = result.trim();
      console.log(`[platform] Created virtual sink: ${sinkName} (module ${sinkModuleId})`);
    } else {
      console.log(`[platform] Virtual sink already exists: ${sinkName}`);
    }
  } catch (err) {
    console.error(`[platform] Failed to create virtual sink: ${err.message}`);
    process.exit(1);
  }

  return {
    os: 'linux',
    audioDeviceName: sinkName,
    ffmpegOutputArgs: ['-f', 'pulse', sinkName],
    cleanup: async () => {
      if (sinkModuleId) {
        try {
          execSync(`pactl unload-module ${sinkModuleId}`, { stdio: 'pipe' });
          console.log(`[platform] Removed virtual sink: ${sinkName}`);
        } catch {
          // Ignore — sink may already be removed
        }
      }
    },
  };
}

module.exports = { detectPlatform };
