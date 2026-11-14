// Android release builds signed with the Play upload key.
//
// The key and its passwords live in android-signing/ at the project root, which git
// ignores: android-signing/keystore.properties holds storeFile, storePassword,
// keyAlias and keyPassword (storeFile relative to that folder or absolute). Without
// that file, release builds fall back to the debug key as before, so a machine
// without the key still builds (but Play rejects what it makes).
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_CONFIG = `
        release {
            def stillwebSigning = new File(rootDir, '../android-signing/keystore.properties')
            if (stillwebSigning.exists()) {
                def props = new Properties()
                stillwebSigning.withInputStream { props.load(it) }
                storeFile new File(stillwebSigning.parentFile, props['storeFile']).exists()
                    ? new File(stillwebSigning.parentFile, props['storeFile'])
                    : file(props['storeFile'])
                storePassword props['storePassword']
                keyAlias props['keyAlias']
                keyPassword props['keyPassword']
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (gradle.includes('stillwebSigning')) return cfg;

    const debugConfig = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/;
    if (!debugConfig.test(gradle)) throw new Error('with-release-signing: no signingConfigs.debug in app/build.gradle');
    gradle = gradle.replace(debugConfig, `$1${RELEASE_CONFIG}`);

    const releaseUsesDebug = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
    if (!releaseUsesDebug.test(gradle)) throw new Error('with-release-signing: release build type not found in app/build.gradle');
    gradle = gradle.replace(
      releaseUsesDebug,
      "$1signingConfig new File(rootDir, '../android-signing/keystore.properties').exists() ? signingConfigs.release : signingConfigs.debug",
    );

    cfg.modResults.contents = gradle;
    return cfg;
  });
};
