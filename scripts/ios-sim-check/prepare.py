import sys

# Prepares the app's native sources for the test app: no Expo import, and (test only) each site
# script set leaves its name on the page, so the check can tell which one a document actually
# ran. The app itself leaves no such trace.
out = sys.argv[1]
web = open(out + '/ShieldWebView.swift.in').read().replace('import ExpoModulesCore\n', '\n')
engine = open(out + '/ShieldEngine.swift.in').read()
guard = "if (h !== '\\(quoted)' && !h.endsWith('.\\(quoted)')) return;"
assert engine.count(guard) == 1, 'site script guard not found'
engine = engine.replace(guard, guard + "\n      window.__swSet = (window.__swSet || '') + '[\\(quoted)]';")
open(out + '/ShieldWebView.swift', 'w').write(web)
open(out + '/ShieldEngine.swift', 'w').write(engine)
