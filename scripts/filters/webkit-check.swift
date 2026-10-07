// Compiles WKContentRuleList JSON files with this Mac's WebKit and exits non-zero if any is
// rejected. WebKit rejects a whole list for a single rule it doesn't accept, and the app then
// has no rules from it at all, so scripts/filters/build.mjs runs this on everything it built.
//   webkit-check <rules.json>...
import AppKit
import WebKit

let files = Array(CommandLine.arguments.dropFirst())
guard !files.isEmpty, let store = WKContentRuleListStore.default() else {
  print("webkit-check: nothing to check")
  exit(files.isEmpty ? 0 : 1)
}
var pending = files.count
var rejected = 0
for (index, path) in files.enumerated() {
  let name = (path as NSString).lastPathComponent
  guard let json = try? String(contentsOfFile: path, encoding: .utf8) else {
    print("\(name): cannot be read")
    exit(1)
  }
  let identifier = "stillweb-webkit-check-\(index)"
  store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: json) { list, error in
    if list == nil {
      rejected += 1
      let reason = (error as NSError?)?.userInfo[NSHelpAnchorErrorKey] ?? error?.localizedDescription ?? "unknown error"
      print("\(name): REJECTED by WebKit: \(reason)")
    } else {
      print("\(name): accepted by WebKit")
    }
    store.removeContentRuleList(forIdentifier: identifier) { _ in
      pending -= 1
      if pending == 0 { exit(rejected == 0 ? 0 : 1) }
    }
  }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 600) {
  print("webkit-check: timed out")
  exit(1)
}
NSApplication.shared.setActivationPolicy(.prohibited)
NSApplication.shared.run()
