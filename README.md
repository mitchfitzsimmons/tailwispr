# TailWispr

Turn your phone into a wireless microphone for your computer over [Tailscale](https://tailscale.com).

TailWispr streams audio from your phone's microphone to your computer as a virtual audio input. Your computer sees it as a regular microphone — use it with [Wispr](https://wisprflow.ai), Zoom, Discord, or any other app.

**Built for remote setups** — when you're VNC-ing into your laptop from a tablet and your devices are on different networks, Tailscale bridges the gap.

## How It Works

1. Open a URL on your phone — it starts capturing audio from your mic
2. Audio streams over your Tailscale network to TailWispr running on your computer
3. TailWispr feeds it into a virtual audio device (BlackHole on macOS, PulseAudio on Linux)
4. Any app on your computer can select that device as its microphone

No apps to install on your phone. Just a browser.

## Features

- **Zero app installs on your phone** — just open a URL in your browser
- **Works on iOS Safari and Android Chrome**
- **Wispr trigger** — remotely start/stop Wispr dictation from your phone
- **VU meter** — real-time audio level visualization
- **Gain control** — adjust volume from 0% to 200%
- **Auto-reconnect** — handles network interruptions gracefully
- **PWA support** — add to your home screen for app-like experience
- **Low latency** — ~110ms end-to-end over Tailscale
- **Optional PIN** — for shared Tailscale networks
- **macOS + Linux** support

## Prerequisites

| Requirement | Why | macOS | Linux |
|-------------|-----|-------|-------|
| [Node.js](https://nodejs.org) 18+ | Runs the TailWispr server | `brew install node` | `sudo apt install nodejs` |
| [ffmpeg](https://ffmpeg.org) | Converts and routes the audio stream in real-time | `brew install ffmpeg` | `sudo apt install ffmpeg` |
| [BlackHole](https://existential.audio/blackhole/) | Creates a virtual "microphone" that apps can select as their audio input | `brew install blackhole-2ch` | Not needed — PulseAudio handles this natively |
| [Tailscale](https://tailscale.com/download) | Connects your phone and computer across different networks | `brew install tailscale` | `curl -fsSL https://tailscale.com/install.sh \| sh` |

> **Note (macOS):** After installing BlackHole, macOS sometimes doesn't load the driver right away. If `setup.sh` can't find a virtual audio device, reload CoreAudio with `sudo killall coreaudiod` (cuts audio for ~1s), then re-run setup. A full reboot also works.

## Quick Start

```bash
git clone https://github.com/mitchfitzsimmons/tailwispr.git
cd tailwispr
bash setup.sh     # Checks prerequisites, detects devices, generates TLS certs
npm start
```

Open the URL shown in the terminal on your phone. Tap the microphone button.

## Manual Setup

If you prefer to configure manually instead of using `setup.sh`:

```bash
# 1. Install dependencies
npm install

# 2. Copy and edit the config
cp config.json.example config.json

# 3. (macOS) Install BlackHole
brew install blackhole-2ch

# 4. (Optional) Generate Tailscale TLS certificate for HTTPS
#    Required for mic access from phone browsers on non-localhost URLs
tailscale cert your-hostname.tail1234.ts.net
mkdir -p certs
mv your-hostname.tail1234.ts.net.crt certs/
mv your-hostname.tail1234.ts.net.key certs/

# 5. Update config.json with your cert paths
#    "tlsCert": "certs/your-hostname.tail1234.ts.net.crt",
#    "tlsKey": "certs/your-hostname.tail1234.ts.net.key"

# 6. Start the server
npm start
```

## Configuration

Edit `config.json` (created by `setup.sh` or copied from `config.json.example`):

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `3000` | Server port |
| `sampleRate` | `48000` | Audio sample rate in Hz |
| `channels` | `1` | Audio channels (1 = mono) |
| `bufferSize` | `4096` | Audio buffer size (lower = less latency, more CPU) |
| `audioDevice` | `null` | Audio device name or index (`null` = auto-detect) |
| `wisprEnabled` | `true` | Enable Wispr auto-trigger toggle (macOS only) |
| `pin` | `null` | Optional PIN code for authentication |

All options can also be set via environment variables: `TAILWISPR_PORT`, `TAILWISPR_AUDIO_DEVICE`, `TAILWISPR_PIN`, `TAILWISPR_SAMPLE_RATE`, `TAILWISPR_BUFFER_SIZE`.

> HTTPS certificates are generated automatically from Tailscale on first start. To use custom certs instead, set `tlsCert` and `tlsKey` in config.json.

## Wispr Integration

TailWispr can remotely trigger [Wispr](https://wisprflow.ai) (voice-to-text) on your Mac from the phone UI. It uses Wispr's built-in URL scheme — no keyboard shortcut remapping or accessibility permissions needed.

When **"Auto-trigger Wispr with mic"** is toggled on (the default), Wispr's hands-free mode starts automatically when you start streaming and stops when you stop. You can also toggle it off to use mic-only mode.

Set `"wisprEnabled": false` in `config.json` to hide the Wispr toggle entirely.

## HTTPS & Microphone Permissions

Browsers require HTTPS to access the microphone on non-localhost URLs. TailWispr handles this automatically — on first start, it generates a valid TLS certificate using your Tailscale hostname.

**One-time setup:** Enable HTTPS in your [Tailscale admin console](https://login.tailscale.com/admin/dns):

1. Turn on **MagicDNS** (if not already on)
2. Turn on **HTTPS Certificates**
3. Restart TailWispr — it will auto-generate certs and show an `https://` URL

You also need the Tailscale CLI installed (`brew install tailscale`) — the Mac App Store version is sandboxed and can't generate certificates.

## Troubleshooting

**"No virtual audio device found"**
- macOS: Install BlackHole: `brew install blackhole-2ch`
- If already installed but still not detected, macOS hasn't loaded the driver yet. Reload CoreAudio: `sudo killall coreaudiod` (audio cuts out for ~1s), then re-run `bash setup.sh`. If it still doesn't appear, reboot.
- Verify the driver is on disk: `ls /Library/Audio/Plug-Ins/HAL/ | grep -i blackhole`

**"Cannot access microphone" on phone**
- Make sure you're using HTTPS (run `setup.sh` to set up TLS certs)
- On iOS, use Safari — Chrome on iOS has limited mic support
- Check that you granted microphone permission when prompted

**"Mic error: undefined is not an object (evaluating 'navigator.mediaDevices.getUserMedia')"**
- You're on plain HTTP. Browsers only expose the mic on secure contexts (HTTPS or localhost).
- The URL bar will say "Not Secure" — that's the giveaway.
- Fix: enable HTTPS. Check the server logs for `Could not generate TLS certs — running HTTP only`.
  - Install the Tailscale brew CLI (the Mac App Store version is sandboxed and can't generate certs): `brew install tailscale`
  - Enable **MagicDNS** and **HTTPS Certificates** in the [Tailscale admin console](https://login.tailscale.com/admin/dns)
  - Restart TailWispr — it will auto-generate the cert and print an `https://` URL

**Audio is choppy or has gaps**
- Check your Tailscale connection quality
- Try increasing the buffer size in `config.json` (e.g., `8192`)
- Ensure you're on a stable WiFi connection on your phone

**Wispr trigger doesn't work**
- Make sure Wispr Flow is running on your Mac
- Verify `wisprEnabled` is `true` in `config.json`

**iOS Safari stops streaming when screen locks**
- Keep the screen on while streaming — the app requests a Wake Lock, but iOS may still suspend it
- Consider using Guided Access (Settings → Accessibility → Guided Access) to prevent sleep

**Server won't start — `EADDRINUSE` / port already in use**
- Another TailWispr (or dev server) is probably still running in another terminal or backgrounded.
- Find it: `lsof -i :3000`
- Stop it: `kill <PID>` (or just close the other terminal / press `q` there)
- Or run on a different port: `TAILWISPR_PORT=3001 npm start`

**Server won't start — other errors**
- Make sure `ffmpeg` is installed: `which ffmpeg`

## Under the Hood

For contributors and the curious:

- Your phone's browser captures mic audio and sends it as raw PCM data over a WebSocket
- The server pipes that audio into ffmpeg, which feeds it to the virtual audio device
- A separate JSON channel over the same WebSocket handles commands (gain changes, Wispr trigger, ping/pong)
- Audio is Float32, 48kHz, mono — sent in ~85ms chunks (~16KB each)
- End-to-end latency is ~110ms over a typical Tailscale connection

## Contributing

Contributions are welcome! This project aims to be simple and approachable.

```bash
git clone https://github.com/mitchfitzsimmons/tailwispr.git
cd tailwispr
npm install
npm start
```

The codebase is ~1,200 lines of plain JavaScript with a single runtime dependency (`ws`). No build step, no transpiler, no framework.

## License

[MIT](LICENSE)
