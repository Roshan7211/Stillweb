import ExpoModulesCore
import QuickLook
import UIKit
import WebKit

/// While private tabs are open, covers the app when it leaves the screen, so private pages
/// don't show in the app switcher (iOS takes its snapshot then).
final class PrivacyCover {
  static let shared = PrivacyCover()
  var enabled = false {
    didSet { if !enabled { hide() } }
  }
  private var covers: [UIView] = []

  private init() {
    let center = NotificationCenter.default
    center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.show()
    }
    center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.hide()
    }
  }

  private func show() {
    guard enabled, covers.isEmpty else { return }
    for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
      for window in scene.windows where !window.isHidden {
        let cover = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
        cover.frame = window.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(cover)
        covers.append(cover)
      }
    }
  }

  private func hide() {
    covers.forEach { $0.removeFromSuperview() }
    covers.removeAll()
  }
}

/// Shows a downloaded file in the system previewer (with Share, Save to Files, Open in…).
final class FilePreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private static var current: FilePreview?
  private let url: URL

  private init(url: URL) { self.url = url }

  static func present(path: String) -> Bool {
    let file = ShieldEngine.currentPath(path)
    let url = URL(fileURLWithPath: file)
    guard FileManager.default.fileExists(atPath: file), let top = topViewController(for: nil) else { return false }
    let preview = FilePreview(url: url)
    current = preview
    let controller = QLPreviewController()
    controller.dataSource = preview
    controller.delegate = preview
    top.present(controller, animated: true)
    return true
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    url as NSURL
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    FilePreview.current = nil
  }
}

public class ShieldEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShieldEngine")

    Events("onEngineChanged", "onSleepTimerFired")

    // Private tabs use a non-persistent WKWebsiteDataStore, which is always isolated.
    Constant("privateTabsIsolated") { true }

    OnCreate {
      DispatchQueue.main.async {
        ShieldEngine.shared.onEngineChanged = { [weak self] status in
          self?.sendEvent("onEngineChanged", status.compactMapValues { $0 })
        }
        SleepTimer.shared.onFired = { [weak self] in
          self?.sendEvent("onSleepTimerFired", [:])
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

    // Per-site desktop website / JavaScript off / hidden elements.
    Function("setSiteFixes") { (fixes: [String: Any]) in
      DispatchQueue.main.async { ShieldEngine.shared.setSiteFixes(fixes) }
    }

    Function("setOptions") { (options: [String: Any]) in
      DispatchQueue.main.async { ShieldEngine.shared.setOptions(options) }
    }

    // Listen Mode: pause all media after this many seconds (nil cancels).
    AsyncFunction("setSleepTimer") { (seconds: Double?) in
      SleepTimer.shared.set(seconds: seconds)
    }.runOnQueue(.main)

    Function("resetStats") {
      DispatchQueue.main.async { ShieldEngine.shared.resetStats() }
    }

    AsyncFunction("clearBrowsingData") { (promise: Promise) in
      let store = WKWebsiteDataStore.default()
      store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
        promise.resolve(nil)
      }
    }.runOnQueue(.main)

    // Wipes the shared in-memory jar of private tabs (called once none are left).
    AsyncFunction("clearPrivateData") { (promise: Promise) in
      ShieldEngine.shared.clearPrivateData { promise.resolve(nil) }
    }.runOnQueue(.main)

    // iOS downloads are handled by the web view itself (WKDownload) and saved to
    // Documents/Downloads; onDownloadRequest reports them with handledNatively = true.
    AsyncFunction("startDownload") { (_: [String: Any]) -> [String: Any] in
      throw Exception(name: "E_UNSUPPORTED", description: "Downloads are handled by the web view on iOS")
    }

    // Android download ids; iOS tracks downloads by file (getFileDownloads / openFile).
    AsyncFunction("getDownloads") { (_: [Double]) -> [[String: Any]] in [] }

    AsyncFunction("openDownload") { (_: Double) -> Bool in false }

    AsyncFunction("getFileDownloads") { (paths: [String]) -> [[String: Any]] in
      ShieldEngine.shared.downloadStatus(paths: paths)
    }.runOnQueue(.main)

    AsyncFunction("openFile") { (path: String) -> Bool in
      FilePreview.present(path: path)
    }.runOnQueue(.main)

    // Deletes a downloaded file (vault downloads aren't reachable from the Files app).
    AsyncFunction("deleteFile") { (path: String) -> Bool in
      let file = ShieldEngine.currentPath(path)
      return (try? FileManager.default.removeItem(atPath: file)) != nil
    }

    // iOS can't block screenshots, but the app switcher snapshot gets covered.
    AsyncFunction("setSecureWindow") { (secure: Bool) in
      PrivacyCover.shared.enabled = secure
    }.runOnQueue(.main)

    AsyncFunction("setDebugProxy") { (_: String?) -> Bool in false }

    AsyncFunction("openExternal") { (url: String, promise: Promise) in
      guard let target = URL(string: url) else { return promise.resolve(false) }
      UIApplication.shared.open(target) { promise.resolve($0) }
    }.runOnQueue(.main)
  }
}
