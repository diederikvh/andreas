const { withNativeWind } = require('nativewind/metro');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

// Sentry's Metro config = drop-in vervanger van Expo's getDefaultConfig
// + sourcemap-collectie (debug-id stempelen op bundle + map) zodat de
// upload-step na `eas update` de juiste sourcemaps koppelt.
const config = getSentryExpoConfig(__dirname);

module.exports = withNativeWind(config, { input: './global.css' });
