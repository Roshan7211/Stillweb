Pod::Spec.new do |s|
  s.name           = 'ShieldWebView'
  s.version        = '0.1.0'
  s.summary        = 'Ad-blocking WKWebView with WKContentRuleList filters and scriptlets'
  s.description    = 'Compiles EasyList/EasyPrivacy-derived content rule lists and injects scriptlets at document start.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = 'MPL-2.0'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  # Default filter bundle (scripts/filters/build.mjs --bundle) for offline first launch.
  s.resource_bundles = {
    # A folder reference keeps the manifest's relative paths (shield/ios/rules-0.json, ...).
    # vendor/autoconsent.js: Calm Mode's cookie pop-up script (scripts/gen-autoconsent.mjs).
    'ShieldWebViewAssets' => ['Resources/shield', 'Resources/vendor/autoconsent.js']
  }
end
