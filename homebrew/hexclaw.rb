# Homebrew Cask for HexClaw Desktop
#
# Install:  brew install --cask hexclaw
# Update:   brew upgrade --cask hexclaw
# Remove:   brew uninstall --cask hexclaw
#
# To use this cask before it's in the official tap, create a local tap:
#   mkdir -p $(brew --repository)/Library/Taps/hexagon-codes/homebrew-tap/Casks
#   cp homebrew/hexclaw.rb $(brew --repository)/Library/Taps/hexagon-codes/homebrew-tap/Casks/
#   brew install --cask hexclaw
#
# Or use the tap directly:
#   brew tap hexagon-codes/tap https://github.com/hexagon-codes/homebrew-tap
#   brew install --cask hexclaw

cask "hexclaw" do
  version "0.4.0"

  on_arm do
    url "https://github.com/hexagon-codes/hexclaw-desktop/releases/download/v#{version}/HexClaw_#{version}_aarch64.dmg"
    sha256 :no_check # Replace with actual sha256 after release
  end

  on_intel do
    url "https://github.com/hexagon-codes/hexclaw-desktop/releases/download/v#{version}/HexClaw_#{version}_x86_64.dmg"
    sha256 :no_check # Replace with actual sha256 after release
  end

  name "HexClaw"
  desc "Enterprise-grade personal AI Agent desktop client"
  homepage "https://github.com/hexagon-codes/hexclaw-desktop"

  depends_on macos: ">= :big_sur"

  app "HexClaw.app"

  preflight do
    # Remove quarantine flag — app is not notarized
    system_command "/usr/bin/xattr",
                   args: ["-cr", "#{staged_path}/HexClaw.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/com.hexclaw.desktop",
    "~/Library/Caches/com.hexclaw.desktop",
    "~/Library/Preferences/com.hexclaw.desktop.plist",
    "~/Library/Saved Application State/com.hexclaw.desktop.savedState",
    "~/.hexclaw",
  ]
end
