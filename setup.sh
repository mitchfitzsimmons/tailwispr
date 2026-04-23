#!/usr/bin/env bash
set -euo pipefail

# TailWispr — Interactive Setup Script
# Run this once after cloning to configure everything

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           TailWispr Setup            ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""

# --- Helper Functions ---
check() { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} $1"; }
info()  { echo -e "  ${CYAN}→${NC} $1"; }

prompt_yn() {
  local msg="$1"
  local default="${2:-y}"
  if [ "$default" = "y" ]; then
    read -rp "  $msg [Y/n]: " answer
    answer="${answer:-y}"
  else
    read -rp "  $msg [y/N]: " answer
    answer="${answer:-n}"
  fi
  [[ "$answer" =~ ^[Yy] ]]
}

OS="$(uname -s)"
PLATFORM=""
AUDIO_DEVICE=""
AUDIO_DEVICE_INDEX=""
PIN=""
TAILSCALE_IP=""
TAILSCALE_HOSTNAME=""

# ============================================================
# Step 1: Check Prerequisites
# ============================================================
echo -e "${BOLD}Checking prerequisites...${NC}"
echo ""

# Node.js
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    check "Node.js $NODE_VERSION"
  else
    fail "Node.js $NODE_VERSION is too old (need v18+)"
    echo "    Install: https://nodejs.org"
    exit 1
  fi
else
  fail "Node.js not found"
  echo "    Install: https://nodejs.org"
  exit 1
fi

# ffmpeg
if command -v ffmpeg &>/dev/null; then
  FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')
  check "ffmpeg $FFMPEG_VERSION"
else
  warn "ffmpeg not found"
  if [ "$OS" = "Darwin" ]; then
    if prompt_yn "Install ffmpeg via Homebrew?"; then
      brew install ffmpeg
      check "ffmpeg installed"
    else
      fail "ffmpeg is required. Install with: brew install ffmpeg"
      exit 1
    fi
  else
    fail "ffmpeg is required. Install with: sudo apt install ffmpeg"
    exit 1
  fi
fi

# ============================================================
# Step 2: Platform-Specific Setup
# ============================================================
echo ""
echo -e "${BOLD}Setting up audio...${NC}"
echo ""

if [ "$OS" = "Darwin" ]; then
  PLATFORM="macOS"

  # Check for virtual audio device
  DEVICE_LIST=$(ffmpeg -y -f lavfi -i anullsrc -t 0 -f audiotoolbox -list_devices true - 2>&1 || true)

  # Check for BlackHole
  if echo "$DEVICE_LIST" | grep -qi "blackhole"; then
    BLACKHOLE_LINE=$(echo "$DEVICE_LIST" | grep -i "blackhole" | head -1)
    AUDIO_DEVICE_INDEX=$(echo "$BLACKHOLE_LINE" | grep -o '\[[0-9]*\]' | tr -d '[]')
    AUDIO_DEVICE=$(echo "$BLACKHOLE_LINE" | sed 's/.*\] *//' | sed 's/,.*//')
    check "Virtual audio device: $AUDIO_DEVICE (index $AUDIO_DEVICE_INDEX)"
  else
    fail "No virtual audio device found"
    echo ""
    info "TailWispr needs a virtual audio device to work."
    info "Install BlackHole (pick one):"
    echo ""
    echo -e "    ${CYAN}brew install blackhole-2ch${NC}"
    echo "    — or —"
    echo -e "    Download from: ${CYAN}https://existential.audio/blackhole/${NC}"
    echo ""
    info "Already installed? macOS may not have loaded the driver yet."
    info "Reload CoreAudio (briefly cuts audio for ~1s):"
    echo -e "    ${CYAN}sudo killall coreaudiod${NC}"
    info "If that doesn't surface it, a full reboot will."
    echo ""
    info "Then run this setup again:"
    echo -e "    ${CYAN}bash setup.sh${NC}"
    echo ""
    exit 1
  fi

elif [ "$OS" = "Linux" ]; then
  PLATFORM="Linux"

  # Check PulseAudio/PipeWire
  if command -v pactl &>/dev/null; then
    check "PulseAudio/PipeWire detected"
    info "Virtual sink 'TailWispr' will be created automatically on start"
    AUDIO_DEVICE="TailWispr (auto-created)"
  else
    fail "PulseAudio/PipeWire not found"
    echo "    Install: sudo apt install pulseaudio"
    exit 1
  fi
else
  fail "Unsupported OS: $OS"
  exit 1
fi

# ============================================================
# Step 3: Tailscale Detection
# ============================================================
echo ""
echo -e "${BOLD}Detecting Tailscale...${NC}"
echo ""

if command -v tailscale &>/dev/null || [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
  # Prefer brew CLI over app binary (app is sandboxed, can't generate certs)
  if command -v tailscale &>/dev/null; then
    TS_BIN="tailscale"
    check "Tailscale CLI (brew)"
  else
    TS_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    warn "Tailscale app found, but CLI is sandboxed — can't generate HTTPS certs"
    info "Install the CLI with: brew install tailscale"
  fi
  TAILSCALE_STATUS=$($TS_BIN status 2>&1 || true)
  if echo "$TAILSCALE_STATUS" | grep -q "stopped\|not running"; then
    warn "Tailscale is installed but not running"
    info "Start it with: sudo tailscale up"
  else
    TAILSCALE_IP=$($TS_BIN ip -4 2>/dev/null || true)
    TAILSCALE_HOSTNAME=$($TS_BIN status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//' || true)

    if [ -n "$TAILSCALE_IP" ]; then
      check "Tailscale IP: $TAILSCALE_IP"
    fi
    if [ -n "$TAILSCALE_HOSTNAME" ]; then
      check "Tailscale hostname: $TAILSCALE_HOSTNAME"
    fi
  fi
else
  warn "Tailscale not found"
  info "Install from: https://tailscale.com/download"
  info "TailWispr will still work on localhost for testing"
fi

# ============================================================
# Step 4: Optional PIN
# ============================================================
echo ""
echo -e "${BOLD}Security...${NC}"
echo ""

info "Your Tailscale network is already encrypted and private."
if prompt_yn "Add a PIN code for extra security?" "n"; then
  read -rp "  Enter a 4-6 digit PIN: " PIN
  if [[ "$PIN" =~ ^[0-9]{4,6}$ ]]; then
    check "PIN set"
  else
    warn "Invalid PIN (must be 4-6 digits) — skipping"
    PIN=""
  fi
else
  info "No PIN — anyone on your Tailscale network can connect"
fi

# ============================================================
# Step 5: Install Dependencies
# ============================================================
echo ""
echo -e "${BOLD}Installing dependencies...${NC}"
echo ""

npm install --silent
check "npm packages installed"

# ============================================================
# Step 6: Generate config.json
# ============================================================
echo ""
echo -e "${BOLD}Writing config.json...${NC}"
echo ""

CONFIG_FILE="$SCRIPT_DIR/config.json"

# Build JSON config
cat > "$CONFIG_FILE" << JSONEOF
{
  "port": 3000,
  "sampleRate": 48000,
  "channels": 1,
  "bufferSize": 4096,
  "audioDevice": $([ -n "$AUDIO_DEVICE" ] && echo "\"$AUDIO_DEVICE\"" || echo "null"),
  "wisprEnabled": true,
  "pin": $([ -n "$PIN" ] && echo "\"$PIN\"" || echo "null")
}
JSONEOF

check "config.json created"

# ============================================================
# Done!
# ============================================================
echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║          Setup complete!             ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Start TailWispr:  ${CYAN}npm start${NC}"
echo ""
info "HTTPS certs will be generated automatically on first start (if Tailscale is available)"
info "The server will print the URL to open on your phone"
echo ""
if [ -n "$AUDIO_DEVICE" ]; then
  echo -e "  Audio device: ${CYAN}$AUDIO_DEVICE${NC}"
  echo -e "  ${DIM}Set this as your mic input in Wispr / Zoom / etc.${NC}"
fi
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo "  1. Start the server:  npm start"
echo "  2. Open the URL on your phone"
echo "  3. Tap the microphone button to start streaming"
echo "  4. Select '$AUDIO_DEVICE' as your mic in your app"
echo ""
