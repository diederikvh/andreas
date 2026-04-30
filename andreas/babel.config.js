module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: [
      // Worklets plugin (Reanimated v4) must be the last plugin.
      'react-native-worklets/plugin',
    ],
  };
};
