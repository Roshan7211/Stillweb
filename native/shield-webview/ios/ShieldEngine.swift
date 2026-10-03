import AVFoundation
import CryptoKit
import Foundation
import WebKit

/// Per-host scriptlet injections built by `filter-compiler` (see scripts/filters/build.mjs):
/// `{ lib: {name: js}, calls: [js], generic: [[deps], [callIdx]], hosts: {host: [[deps], [callIdx]]} }`
final class ScriptletIndex {
  private let lib: [String: String]
  private let calls: [String]
  private let generic: [Any]
  private let hosts: [String: Any]

  init?(data: Data) {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    lib = root["lib"] as? [String: String] ?? [:]
    calls = root["calls"] as? [String] ?? []
    generic = root["generic"] as? [Any] ?? []
    hosts = root["hosts"] as? [String: Any] ?? [:]
  }

  /// Script for a page host, wrapped so it only runs in frames of the matched domain.
  func script(forHost host: String) -> String? {
    var candidate = host.lowercased()
    var entry: [Any]?
    var matched = candidate
    while true {
      if let e = hosts[candidate] as? [Any] {
        entry = e
        matched = candidate
        break
      }
      guard let dot = candidate.firstIndex(of: ".") else { break }
      candidate = String(candidate[candidate.index(after: dot)...])
    }
    let chosen = entry ?? generic
    guard chosen.count == 2,
          let deps = chosen[0] as? [String],
          let indices = chosen[1] as? [Int],
          !indices.isEmpty else { return nil }

    var body = ""
    for dep in deps {
      if let code = lib[dep] { body += code + "\n" }
    }
    for i in indices where i >= 0 && i < calls.count {
      body += calls[i]
    }
    let guardHost = entry == nil ? host.lowercased() : matched
    let quoted = guardHost.replacingOccurrences(of: "'", with: "")
    return """
    (function () {
      var h = location.hostname;
      if (h !== '\(quoted)' && !h.endsWith('.\(quoted)')) return;
    \(body)
    })();
    """
  }
}

/// Process-wide filter state for iOS. All mutable state is confined to the main thread.
final class ShieldEngine {
  static let shared = ShieldEngine()

  private let queue = DispatchQueue(label: "shield.engine", qos: .utility)
  private let defaults = UserDefaults.standard
  private var initialized = false

  private(set) var ruleLists: [WKContentRuleList] = []
  private var scriptlets: ScriptletIndex?
  private(set) var version: String?
  private(set) var source = "none"
  private(set) var buildMillis = 0
  private(set) var lastError: String?
  /// Bumped when filters or per-site settings change so views reattach rules.
  private(set) var generation = 0

  var enabled = true
  var httpsUpgrade = true
  var blockPopups = true
  var cosmeticFiltering = true
  var backgroundPlay = true
  private var disabledSites = Set<String>()
  private(set) var totalBlocked = 0

  var onEngineChanged: (([String: Any?]) -> Void)?
  private var readyWaiters: [() -> Void] = []

  /// Runs `action` once rule lists are compiled (or loading failed); immediately if already done.
  func whenReady(_ action: @escaping () -> Void) {
    if isReady || lastError != nil { action() } else { readyWaiters.append(action) }
  }

  private func flushReadyWaiters() {
    let waiting = readyWaiters
    readyWaiters.removeAll()
    waiting.forEach { $0() }
  }

  var isReady: Bool { !ruleLists.isEmpty }

  private var rootDir: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("shield", isDirectory: true)
  }

  private var activeDir: URL { rootDir.appendingPathComponent("active", isDirectory: true) }

  private var bundledDir: URL? {
    for bundle in [Bundle.main, Bundle(for: ShieldEngine.self)] {
      if let url = bundle.url(forResource: "ShieldWebViewAssets", withExtension: "bundle"),
         let assets = Bundle(url: url),
         let dir = assets.url(forResource: "shield", withExtension: nil) {
        return dir
      }
    }
    return nil
  }

  func initialize() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !initialized else { return }
    initialized = true
    let prefs = defaults.dictionary(forKey: "shield.options") ?? [:]
    enabled = prefs["enabled"] as? Bool ?? true
    httpsUpgrade = prefs["httpsUpgrade"] as? Bool ?? true
    blockPopups = prefs["blockPopups"] as? Bool ?? true
    cosmeticFiltering = prefs["cosmeticFiltering"] as? Bool ?? true
    backgroundPlay = prefs["backgroundPlay"] as? Bool ?? true
    configureAudioSession()
    disabledSites = Set(defaults.stringArray(forKey: "shield.disabledSites") ?? [])
    totalBlocked = defaults.integer(forKey: "shield.totalBlocked")
    loadBest(completion: nil)
  }

  /// Playback category lets web audio continue in the background (with UIBackgroundModes audio).
  private func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(backgroundPlay ? .playback : .ambient, mode: .default)
  }

  // MARK: - Queries

  func shieldsEnabled(forHost host: String?) -> Bool {
    guard enabled else { return false }
    guard var h = host?.lowercased(), !h.isEmpty else { return true }
    while true {
      if disabledSites.contains(h) { return false }
      guard let dot = h.firstIndex(of: ".") else { return true }
      h = String(h[h.index(after: dot)...])
    }
  }

  func scriptletSource(forHost host: String) -> String? {
    scriptlets?.script(forHost: host)
  }

  func recordBlocked(_ count: Int) {
    totalBlocked += count
    defaults.set(totalBlocked, forKey: "shield.totalBlocked")
  }

  func resetStats() {
    totalBlocked = 0
    defaults.set(0, forKey: "shield.totalBlocked")
  }

  // MARK: - Settings

  func setDisabledSites(_ hosts: [String]) {
    disabledSites = Set(hosts.map { $0.lowercased() })
    defaults.set(Array(disabledSites), forKey: "shield.disabledSites")
    generation += 1
  }

  func setOptions(_ options: [String: Any]) {
    if let v = options["enabled"] as? Bool { enabled = v }
    if let v = options["httpsUpgrade"] as? Bool { httpsUpgrade = v }
    if let v = options["blockPopups"] as? Bool { blockPopups = v }
    if let v = options["cosmeticFiltering"] as? Bool { cosmeticFiltering = v }
    if let v = options["backgroundPlay"] as? Bool {
      backgroundPlay = v
      configureAudioSession()
    }
    defaults.set(
      [
        "enabled": enabled, "httpsUpgrade": httpsUpgrade, "blockPopups": blockPopups,
        "cosmeticFiltering": cosmeticFiltering, "backgroundPlay": backgroundPlay,
      ],
      forKey: "shield.options"
    )
    generation += 1
  }

  func status() -> [String: Any?] {
    [
      "ready": isReady,
      "version": version,
      "source": source,
      "buildMillis": buildMillis,
      "lastError": lastError,
      // iOS ships one precompiled rule set; individual lists can't be toggled on device.
      "enabledLists": nil,
      "totalBlocked": totalBlocked,
    ]
  }

  // MARK: - Updates

  /// Verifies a downloaded bundle (manifest.json + the iOS files it lists), activates it and
  /// recompiles. Completion runs on the main thread with the new version or an error.
  func applyUpdate(from staging: URL, completion: @escaping (Result<String?, Error>) -> Void) {
    queue.async {
      do {
        let manifest = try Self.readManifest(staging)
        guard let ios = manifest["ios"] as? [String: Any],
              let rules = ios["rules"] as? [[String: Any]],
              let scriptlets = ios["scriptlets"] as? [String: Any] else {
          throw ShieldError("manifest has no iOS section")
        }
        for entry in rules + [scriptlets] {
          guard let rel = entry["file"] as? String, let expected = entry["sha256"] as? String else {
            throw ShieldError("manifest entry is incomplete")
          }
          let file = staging.appendingPathComponent(rel).standardizedFileURL
          guard file.path.hasPrefix(staging.standardizedFileURL.path) else { throw ShieldError("bad path \(rel)") }
          let digest = SHA256.hash(data: try Data(contentsOf: file)).map { String(format: "%02x", $0) }.joined()
          guard digest == expected else { throw ShieldError("checksum mismatch for \(rel)") }
        }
        let fm = FileManager.default
        try fm.createDirectory(at: self.rootDir, withIntermediateDirectories: true)
        let incoming = self.rootDir.appendingPathComponent("active.incoming", isDirectory: true)
        try? fm.removeItem(at: incoming)
        try fm.copyItem(at: staging, to: incoming)
        try? fm.removeItem(at: self.activeDir)
        try fm.moveItem(at: incoming, to: self.activeDir)
        DispatchQueue.main.async {
          self.loadBest { result in completion(result) }
        }
      } catch {
        DispatchQueue.main.async { completion(.failure(error)) }
      }
    }
  }

  // MARK: - Loading

  private static func readManifest(_ dir: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: dir.appendingPathComponent("manifest.json"))
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw ShieldError("manifest.json is not an object")
    }
    return json
  }

  private func loadBest(completion: ((Result<String?, Error>) -> Void)?) {
    let bundled = bundledDir
    let active = activeDir
    let bundledVersion = bundled.flatMap { try? Self.readManifest($0)["version"] as? String }
    let activeVersion = (try? Self.readManifest(active))?["version"] as? String

    // ISO-8601 UTC timestamps compare correctly as strings.
    if let activeVersion, activeVersion > (bundledVersion ?? "") {
      load(dir: active, source: "downloaded") { result in
        if case .failure = result, let bundled {
          self.load(dir: bundled, source: "bundled") { completion?($0) }
        } else {
          completion?(result)
        }
      }
    } else if let bundled {
      load(dir: bundled, source: "bundled") { completion?($0) }
    } else {
      fail(ShieldError("no filter bundle found"), completion)
    }
  }

  private func fail(_ error: Error, _ completion: ((Result<String?, Error>) -> Void)?) {
    lastError = error.localizedDescription
    flushReadyWaiters()
    onEngineChanged?(status())
    completion?(.failure(error))
  }

  private func load(dir: URL, source: String, completion: @escaping (Result<String?, Error>) -> Void) {
    let started = Date()
    guard let manifest = try? Self.readManifest(dir),
          let version = manifest["version"] as? String,
          let ios = manifest["ios"] as? [String: Any],
          let rules = ios["rules"] as? [[String: Any]],
          let scriptletFile = (ios["scriptlets"] as? [String: Any])?["file"] as? String,
          let store = WKContentRuleListStore.default() else {
      return fail(ShieldError("invalid filter bundle at \(dir.lastPathComponent)"), completion)
    }

    let idPrefix = "shield-" + version.filter { $0.isLetter || $0.isNumber }
    var compiled = [WKContentRuleList?](repeating: nil, count: rules.count)
    var firstError: Error?
    let group = DispatchGroup()

    for (index, rule) in rules.enumerated() {
      guard let file = rule["file"] as? String else { continue }
      let identifier = "\(idPrefix)-\(index)"
      group.enter()
      store.lookUpContentRuleList(forIdentifier: identifier) { cached, _ in
        if let cached {
          compiled[index] = cached
          group.leave()
          return
        }
        self.queue.async {
          let json = try? String(contentsOf: dir.appendingPathComponent(file), encoding: .utf8)
          DispatchQueue.main.async {
            guard let json else {
              firstError = firstError ?? ShieldError("cannot read \(file)")
              group.leave()
              return
            }
            store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: json) { list, error in
              compiled[index] = list
              if let error { firstError = firstError ?? error }
              group.leave()
            }
          }
        }
      }
    }

    var index: ScriptletIndex?
    group.enter()
    queue.async {
      index = (try? Data(contentsOf: dir.appendingPathComponent(scriptletFile))).flatMap(ScriptletIndex.init(data:))
      DispatchQueue.main.async { group.leave() }
    }

    group.notify(queue: .main) {
      let lists = compiled.compactMap { $0 }
      guard lists.count == rules.count else {
        return self.fail(firstError ?? ShieldError("rule compilation failed"), completion)
      }
      self.ruleLists = lists
      self.scriptlets = index
      self.version = version
      self.source = source
      self.lastError = nil
      self.buildMillis = Int(Date().timeIntervalSince(started) * 1000)
      self.generation += 1
      self.removeStaleRuleLists(keepingPrefix: idPrefix, store: store)
      self.flushReadyWaiters()
      self.onEngineChanged?(self.status())
      completion(.success(version))
    }
  }

  private func removeStaleRuleLists(keepingPrefix prefix: String, store: WKContentRuleListStore) {
    store.getAvailableContentRuleListIdentifiers { ids in
      for id in ids ?? [] where id.hasPrefix("shield-") && !id.hasPrefix(prefix + "-") {
        store.removeContentRuleList(forIdentifier: id) { _ in }
      }
    }
  }
}

struct ShieldError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
