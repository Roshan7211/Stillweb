// Stillweb Plus app icons (iOS): adds assets/alt-icons/<Name>.png to the asset catalog as
// AppIcon-<Name> icon sets and lists them as alternate icons, so the app can switch with
// UIApplication.setAlternateIconName. Regenerate the images with scripts/gen-alt-icons.py.
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const ICONS = ['Midnight', 'Sunset', 'Forest', 'Violet'];

function withIconSets(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const { projectRoot, platformProjectRoot, projectName } = cfg.modRequest;
      const catalog = path.join(platformProjectRoot, projectName, 'Images.xcassets');
      for (const name of ICONS) {
        const source = path.join(projectRoot, 'assets', 'alt-icons', `${name}.png`);
        if (!fs.existsSync(source)) throw new Error(`with-alternate-icons: missing ${source}`);
        const dir = path.join(catalog, `AppIcon-${name}.appiconset`);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(source, path.join(dir, 'icon.png'));
        // A single 1024 image, like Expo's own AppIcon set; Xcode makes the smaller sizes.
        const contents = {
          images: [{ filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
          info: { author: 'expo', version: 1 },
        };
        fs.writeFileSync(path.join(dir, 'Contents.json'), JSON.stringify(contents, null, 2));
      }
      return cfg;
    },
  ]);
}

function withAlternateIconNames(config) {
  return withXcodeProject(config, (cfg) => {
    const configurations = cfg.modResults.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const settings = configurations[key].buildSettings;
      // The app target's configurations are the ones with an app icon.
      if (settings && settings.ASSETCATALOG_COMPILER_APPICON_NAME) {
        settings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = `"${ICONS.map((n) => `AppIcon-${n}`).join(' ')}"`;
      }
    }
    return cfg;
  });
}

module.exports = (config) => withAlternateIconNames(withIconSets(config));
module.exports.ICONS = ICONS;
