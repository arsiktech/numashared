#!/bin/sh
# Xcode Cloud runs this right after cloning, before it builds app/ios/NumaShared.xcworkspace.
# The Expo app needs Node for its JavaScript bundle and CocoaPods for its native modules.
set -eu

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
brew install node@22 cocoapods

NODE_PREFIX="$(brew --prefix node@22)"
export PATH="$NODE_PREFIX/bin:$PATH"
node --version

cd "$CI_PRIMARY_REPOSITORY_PATH/app"
npm ci --no-audit --no-fund

# The "Bundle React Native code" build phase finds Node through this file.
echo "export NODE_BINARY=$NODE_PREFIX/bin/node" > ios/.xcode.env.local

cd ios
pod install
