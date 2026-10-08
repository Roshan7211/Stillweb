import sys

# Prepares the app's native sources for the test app: no Expo import, and (test only) each site
# script set leaves its name on the page, so the check can tell which one a document actually
# ran. The app itself leaves no such trace. Older sources also get the two members the driver
# uses that they did not have yet.
out = sys.argv[1]
web = open(out + '/ShieldWebView.swift.in').read().replace('import ExpoModulesCore\n', '\n')
engine = open(out + '/ShieldEngine.swift.in').read()
guard = "if (h !== '\\(quoted)' && !h.endsWith('.\\(quoted)')) return;"
if engine.count(guard) == 1:
    engine = engine.replace(guard, guard + "\n      window.__swSet = (window.__swSet || '') + '[\\(quoted)]';")
else:
    print('note: site script guard not found, the page will not name its script set')

if 'var restored' not in web:
    anchor = '  var active = true\n'
    assert web.count(anchor) == 1, 'cannot add `restored`'
    web = web.replace(anchor, anchor + '  var restored = false\n')
if 'func layoutInfo' not in web:
    web += r"""
extension ShieldWebView {
  func layoutInfo() -> [String: Any] {
    guard let webView else { return [:] }
    let scroll = webView.scrollView
    let edges = { (i: UIEdgeInsets) -> [Double] in [i.top, i.left, i.bottom, i.right].map { Double($0) } }
    var info: [String: Any] = [
      "webView": [webView.frame.minX, webView.frame.minY, webView.frame.width, webView.frame.height].map { Double($0) },
      "content": [Double(scroll.contentSize.width), Double(scroll.contentSize.height)],
      "offset": [Double(scroll.contentOffset.x), Double(scroll.contentOffset.y)],
      "zoom": Double(scroll.zoomScale),
      "minZoom": Double(scroll.minimumZoomScale),
      "inset": edges(scroll.contentInset),
      "scripts": webView.configuration.userContentController.userScripts.count,
    ]
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) { info["obscured"] = edges(webView.obscuredContentInsets) }
    #endif
    return info
  }
}
"""
open(out + '/ShieldWebView.swift', 'w').write(web)
open(out + '/ShieldEngine.swift', 'w').write(engine)
