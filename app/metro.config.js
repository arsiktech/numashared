const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Cyrillic companions are woff2. Latin faces stay the original ttf files.
if (!config.resolver.assetExts.includes('woff2')) config.resolver.assetExts.push('woff2');

module.exports = config;
