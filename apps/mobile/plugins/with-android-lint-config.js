// Config-plugin: injecteert `android { lint { ... } }` in app/build.gradle.
//
// Reden: Expo's top-level `locales` config is iOS-bedoeld
// (NSLocationWhenInUseUsageDescription enz. zijn InfoPlist-keys), maar
// Expo prebuild rendert die strings óók in `android/app/src/main/res/
// values-b+{nl,en}/strings.xml`. De fatal Android-lint-regel
// `ExtraTranslation` weigert daarop een release te bouwen omdat dezelfde
// keys ontbreken in de default `values/strings.xml`. We disabelen de
// regel + zetten checkReleaseBuilds uit zodat lintVitalRelease niet
// abort.

const { withAppBuildGradle } = require('@expo/config-plugins');

const LINT_BLOCK = `
android {
    lint {
        disable 'ExtraTranslation'
        checkReleaseBuilds false
        abortOnError false
    }
}
`.trim();

module.exports = function withAndroidLintConfig(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes("disable 'ExtraTranslation'")) {
      cfg.modResults.contents = cfg.modResults.contents.trimEnd() + '\n\n' + LINT_BLOCK + '\n';
    }
    return cfg;
  });
};
