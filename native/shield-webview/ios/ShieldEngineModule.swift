import ExpoModulesCore
import UIKit
import WebKit

public class ShieldEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShieldEngine")

    Events("onEngineChanged")

    // Private tabs use a non-persistent WKWebsiteDataStore, which is always isolated.
    Constant("privateTabsIsolated") { true }

    OnCreate {
      DispatchQueue.main.async {
        ShieldEngine.shared.onEngineChanged = { [weak self] status in
          self?.sendEvent("onEngineChanged", status.compactMapValues { $0 })
        }
        ShieldEngine.shared.initialize()
      }
    }

    AsyncFunction("getStatus") { () -> [String: Any] in
      ShieldEngine.shared.status().compactMapValues { $0 }
    }.runOnQueue(.main)

    AsyncFunction("applyFilterUpdate") { (directory: String, promise: Promise) in
      let path = directory.hasPrefix("file://") ? (URL(string: directory)?.path ?? directory) : directory
      ShieldEngine.shared.applyUpdate(from: URL(fileURLWithPath: path, isDirectory: true)) { result in
        switch result {
        case .success(let version): promise.resolve(version)
        case .failure(let error): promise.reject("E_FILTER_UPDATE", error.localizedDescription)
        }
      }
    }.runOnQueue(.main)

    // Lists are precompiled together into WKContentRuleLists for iOS; toggling single
    // lists needs a server-side build per combination, so this is a no-op here.
    AsyncFunction("setEnabledLists") { (_: [String]?) -> String? in
      ShieldEngine.shared.version
    }.runOnQueue(.main)

    Function("setDisabledSites") { (hosts: [String]) in
      DispatchQueue.main.async { ShieldEngine.shared.setDisabledSites(hosts) }
    }

    Function("setOptions") { (options: [String: Any]) in
      DispatchQueue.main.async { ShieldEngine.shared.setOptions(options) }
    }

    Function("resetStats") {
      DispatchQueue.main.async { ShieldEngine.shared.resetStats() }
    }

    AsyncFunction("clearBrowsingData") { (promise: Promise) in
      let store = WKWebsiteDataStore.default()
      store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
        promise.resolve(nil)
      }
    }.runOnQueue(.main)

    // Non-persistent data stores are discarded together with their web views.
    AsyncFunction("clearPrivateData") {}

    // iOS downloads are handled by the web view itself (WKDownload) and saved to
    // Documents/Downloads; onDownloadRequest reports them with handledNatively = true.
    AsyncFunction("startDownload") { (_: [String: Any]) -> [String: Any] in
      throw Exception(name: "E_UNSUPPORTED", description: "Downloads are handled by the web view on iOS")
    }

    AsyncFunction("getDownloads") { (_: [Double]) -> [[String: Any]] in [] }

    AsyncFunction("openDownload") { (_: Double) -> Bool in false }

    // iOS has no FLAG_SECURE equivalent for app-switcher snapshots.
    AsyncFunction("setSecureWindow") { (_: Bool) in }

    AsyncFunction("setDebugProxy") { (_: String?) -> Bool in false }

    AsyncFunction("openExternal") { (url: String, promise: Promise) in
      guard let target = URL(string: url) else { return promise.resolve(false) }
      UIApplication.shared.open(target) { promise.resolve($0) }
    }.runOnQueue(.main)
  }
}
