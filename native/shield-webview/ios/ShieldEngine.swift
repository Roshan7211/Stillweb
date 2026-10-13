import AVFoundation
import CryptoKit
import Foundation
import WebKit

/// Per-host scriptlet injections built by `filter-compiler` (see scripts/filters/build.mjs):
/// `{ lib: {name: js}, calls: [js], generic: [[deps], [callIdx]], hosts: {host: [[deps], [callIdx]]} }`
/// A host key ending in `.*` is a site family (see `familyEntry`).
final class ScriptletIndex {
  private let lib: [String: String]
  private let calls: [String]
  private let generic: [Any]
  fileprivate let hosts: [String: Any]

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
    if entry == nil, let family = familyEntry(forHost: host.lowercased()) {
      entry = family.entry
      matched = family.site
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
    // The scriptlets (uBlock Origin's) read their settings from `scriptletGlobals`, which
    // uBlock Origin defines around them: without it every one stops at its first line.
    return """
    (function () {
      var h = location.hostname;
      if (h !== '\(quoted)' && !h.endsWith('.\(quoted)')) return;
      const scriptletGlobals = {};
    \(body)
    })();
    """
  }
}

extension ScriptletIndex {
  /// The lists cover sites that keep changing their address as a family: `name.*`, the name
  /// under any ending. A host that isn't listed itself is looked up by its name without the
  /// ending, which is one label (`.com`) or two (`.co.uk`: a short label before the last).
  /// `site` is the part of the host the family matched (`name.ending`).
  fileprivate func familyEntry(forHost host: String) -> (entry: [Any], site: String)? {
    let labels = host.split(separator: ".").map(String.init)
    for ending in 1...2 where labels.count > ending {
      if ending == 2, labels[labels.count - 2].count > 3 { continue }
      var name = Array(labels.dropLast(ending))
      while !name.isEmpty {
        if let entry = hosts[name.joined(separator: ".") + ".*"] as? [Any] {
          return (entry, (name + labels.suffix(ending)).joined(separator: "."))
        }
        name.removeFirst()
      }
    }
    return nil
  }
}

/// Process-wide filter state for iOS. All mutable state is confined to the main thread.
final class ShieldEngine {
  static let shared = ShieldEngine()

  private let queue = DispatchQueue(label: "shield.engine", qos: .utility)
  private let defaults = UserDefaults.standard
  private var initialized = false

  private(set) var ruleLists: [WKContentRuleList] = []
  /// Calm Mode's annoyance lists (attached only while it's on).
  private(set) var calmRuleLists: [WKContentRuleList] = []
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
  /// Stillweb Plus: annoyance lists and automatic cookie pop-up rejection.
  var calmMode = false
  /// Stillweb Plus: private tabs' downloads go to the vault (not visible in the Files app).
  var vault = false
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

  /// DuckDuckGo's autoconsent (MPL-2.0), run in pages while Calm Mode is on to reject cookie
  /// pop-ups (Resources/vendor/autoconsent.js, from scripts/gen-autoconsent.mjs).
  private(set) lazy var autoconsentSource: String? = {
    for bundle in [Bundle.main, Bundle(for: ShieldEngine.self)] {
      if let url = bundle.url(forResource: "ShieldWebViewAssets", withExtension: "bundle"),
         let assets = Bundle(url: url),
         let file = assets.url(forResource: "autoconsent", withExtension: "js"),
         let source = try? String(contentsOf: file, encoding: .utf8) {
        return source
      }
    }
    return nil
  }()

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
    calmMode = prefs["calmMode"] as? Bool ?? false
    vault = prefs["vault"] as? Bool ?? false
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

  // MARK: - Private browsing

  /// One in-memory cookie and storage jar shared by all private tabs, so signing in carries
  /// over to links opened in other private tabs. Nothing in it is ever written to disk.
  private var privateStore: WKWebsiteDataStore?

  func privateDataStore() -> WKWebsiteDataStore {
    if let privateStore { return privateStore }
    let store = WKWebsiteDataStore.nonPersistent()
    privateStore = store
    return store
  }

  /// Wipes and forgets the private jar (the last private tab closed); the next private tab
  /// starts with a fresh one.
  func clearPrivateData(completion: @escaping () -> Void) {
    guard let store = privateStore else { return completion() }
    privateStore = nil
    store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast, completionHandler: completion)
  }

  // MARK: - Profiles (Stillweb Plus)

  /// Profiles need WebKit's named data stores (iOS 17).
  static var profilesSupported: Bool {
    #if compiler(>=5.9)
    if #available(iOS 17.0, *) { return true }
    #endif
    return false
  }

  /// One store object per profile, shared by its tabs (like the private jar).
  private static var profileStores: [UUID: WKWebsiteDataStore] = [:]

  /// The persistent cookie and storage jar of a profile, or nil for the default one.
  static func profileDataStore(_ id: String?) -> WKWebsiteDataStore? {
    #if compiler(>=5.9)
    if #available(iOS 17.0, *), let id, let uuid = UUID(uuidString: id) {
      return profileStore(uuid)
    }
    #endif
    return nil
  }

  #if compiler(>=5.9)
  @available(iOS 17.0, *)
  private static func profileStore(_ uuid: UUID) -> WKWebsiteDataStore {
    if let store = profileStores[uuid] { return store }
    let store = WKWebsiteDataStore(forIdentifier: uuid)
    profileStores[uuid] = store
    return store
  }
  #endif

  /// Deletes a profile's jar (its tabs are closed by then). A store still held by a closing
  /// web view can't be removed yet, so it is emptied instead.
  static func deleteProfileData(_ id: String, completion: @escaping () -> Void) {
    #if compiler(>=5.9)
    if #available(iOS 17.0, *), let uuid = UUID(uuidString: id) {
      profileStores[uuid] = nil
      WKWebsiteDataStore.remove(forIdentifier: uuid) { error in
        guard error != nil else { return completion() }
        WKWebsiteDataStore(forIdentifier: uuid)
          .removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast, completionHandler: completion)
      }
      return
    }
    #endif
    completion()
  }

  /// Empties every profile's jar (Clear browsing data).
  static func clearProfileData(completion: @escaping () -> Void) {
    #if compiler(>=5.9)
    if #available(iOS 17.0, *) {
      WKWebsiteDataStore.fetchAllDataStoreIdentifiers { ids in
        let group = DispatchGroup()
        for uuid in ids {
          group.enter()
          profileStore(uuid)
            .removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { group.leave() }
        }
        group.notify(queue: .main, execute: completion)
      }
      return
    }
    #endif
    completion()
  }

  // MARK: - Downloads

  struct DownloadState {
    var status: String // running | done | failed
    var bytes: Int64
    var total: Int64
  }

  /// Downloads started this session, by destination path.
  private var downloads: [String: DownloadState] = [:]

  func updateDownload(path: String, status: String, bytes: Int64, total: Int64) {
    downloads[path] = DownloadState(status: status, bytes: bytes, total: total)
  }

  /// Status of downloaded files: running, done (with size), failed, or missing (deleted).
  func downloadStatus(paths: [String]) -> [[String: Any]] {
    paths.map { path in
      if let state = downloads[path], state.status != "done" {
        return ["path": path, "status": state.status, "bytes": state.bytes, "total": state.total]
      }
      let file = Self.currentPath(path)
      let size = (try? FileManager.default.attributesOfItem(atPath: file)[.size] as? NSNumber)?.int64Value
      guard let size else { return ["path": path, "status": "missing", "bytes": 0, "total": 0] }
      return ["path": path, "status": "done", "bytes": size, "total": size]
    }
  }

  /// iOS can move the app's container (its path changes) on updates and restores; a saved
  /// path inside it (Documents, Library) is rebased onto the current container.
  static func currentPath(_ path: String) -> String {
    guard !FileManager.default.fileExists(atPath: path) else { return path }
    for folder in ["/Documents/", "/Library/"] {
      if let range = path.range(of: folder) {
        let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        return home.appendingPathComponent(String(path[range.lowerBound...].dropFirst())).path
      }
    }
    return path
  }

  /// The vault's downloads: inside the app, out of the Files app.
  static var vaultDownloadsDir: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Vault/Downloads", isDirectory: true)
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

  // MARK: - Site fixes

  /// Per-site changes the user made: desktop website, JavaScript off, hidden elements (CSS selectors).
  struct SiteFix: Equatable {
    var desktop = false
    var noScript = false
    var hidden: [String] = []
  }

  private(set) var siteFixes: [String: SiteFix] = [:]

  /// `{ "example.com": { desktop, noScript, hidden: [selector] } }`, keyed by site (host without www).
  func setSiteFixes(_ raw: [String: Any]) {
    var fixes: [String: SiteFix] = [:]
    for (site, value) in raw {
      guard let entry = value as? [String: Any] else { continue }
      let fix = SiteFix(
        desktop: entry["desktop"] as? Bool ?? false,
        noScript: entry["noScript"] as? Bool ?? false,
        hidden: (entry["hidden"] as? [String] ?? []).filter { !$0.isEmpty }
      )
      if fix.desktop || fix.noScript || !fix.hidden.isEmpty { fixes[site.lowercased()] = fix }
    }
    // Unchanged (most settings changes): tabs keep their rules and scripts.
    guard fixes != siteFixes else { return }
    siteFixes = fixes
    generation += 1
  }

  /// The fix for a host or the closest parent site that has one.
  func siteFix(forHost host: String?) -> SiteFix? {
    guard var h = host?.lowercased(), !h.isEmpty else { return nil }
    if h.hasPrefix("www.") { h.removeFirst(4) }
    while true {
      if let fix = siteFixes[h] { return fix }
      guard let dot = h.firstIndex(of: ".") else { return nil }
      h = String(h[h.index(after: dot)...])
    }
  }

  func setDisabledSites(_ hosts: [String]) {
    let sites = Set(hosts.map { $0.lowercased() })
    guard sites != disabledSites else { return }
    disabledSites = sites
    defaults.set(Array(disabledSites), forKey: "shield.disabledSites")
    generation += 1
  }

  func setOptions(_ options: [String: Any]) {
    let before = [enabled, httpsUpgrade, blockPopups, cosmeticFiltering, backgroundPlay, calmMode, vault]
    if let v = options["enabled"] as? Bool { enabled = v }
    if let v = options["httpsUpgrade"] as? Bool { httpsUpgrade = v }
    if let v = options["blockPopups"] as? Bool { blockPopups = v }
    if let v = options["cosmeticFiltering"] as? Bool { cosmeticFiltering = v }
    if let v = options["backgroundPlay"] as? Bool, v != backgroundPlay {
      backgroundPlay = v
      configureAudioSession()
    }
    if let v = options["calmMode"] as? Bool { calmMode = v }
    if let v = options["vault"] as? Bool { vault = v }
    // Unchanged (most settings changes): tabs keep their rules and scripts.
    guard [enabled, httpsUpgrade, blockPopups, cosmeticFiltering, backgroundPlay, calmMode, vault] != before else { return }
    defaults.set(
      [
        "enabled": enabled, "httpsUpgrade": httpsUpgrade, "blockPopups": blockPopups,
        "cosmeticFiltering": cosmeticFiltering, "backgroundPlay": backgroundPlay, "calmMode": calmMode, "vault": vault,
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
        let calm = ios["calm"] as? [[String: Any]] ?? []
        for entry in rules + calm + [scriptlets] {
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

  /// Compiles (or finds already compiled) rule lists `{prefix}-{index}`. Completes with the
  /// lists WebKit accepted and, if some weren't, the first error (WebKit rejects a whole list
  /// for a single rule it doesn't take).
  private func compileLists(
    _ entries: [[String: Any]],
    prefix: String,
    dir: URL,
    store: WKContentRuleListStore,
    completion: @escaping ([WKContentRuleList], Error?) -> Void
  ) {
    var compiled = [WKContentRuleList?](repeating: nil, count: entries.count)
    var firstError: Error?
    let group = DispatchGroup()

    for (index, rule) in entries.enumerated() {
      guard let file = rule["file"] as? String else { continue }
      let identifier = "\(prefix)-\(index)"
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
              if let error {
                // WebKit's reason is in the help anchor ("Rule list compilation failed: ...").
                let reason = (error as NSError).userInfo[NSHelpAnchorErrorKey] as? String
                firstError = firstError ?? ShieldError("\(file): \(reason ?? error.localizedDescription)")
              }
              group.leave()
            }
          }
        }
      }
    }

    group.notify(queue: .main) {
      let lists = compiled.compactMap { $0 }
      let incomplete = lists.count != entries.count
      completion(lists, incomplete ? firstError ?? ShieldError("rule compilation failed") : nil)
    }
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
    let calm = ios["calm"] as? [[String: Any]] ?? []

    let idPrefix = "shield-" + version.filter { $0.isLetter || $0.isNumber }
    var coreLists: [WKContentRuleList] = []
    var coreError: Error?
    let group = DispatchGroup()

    group.enter()
    compileLists(rules, prefix: idPrefix, dir: dir, store: store) { lists, error in
      coreLists = lists
      coreError = error
      group.leave()
    }

    var index: ScriptletIndex?
    group.enter()
    queue.async {
      index = (try? Data(contentsOf: dir.appendingPathComponent(scriptletFile))).flatMap(ScriptletIndex.init(data:))
      DispatchQueue.main.async { group.leave() }
    }

    group.notify(queue: .main) {
      // A downloaded bundle has to be whole: the bundled one is there to fall back on. The
      // bundled one is the last resort, so it is used as far as WebKit accepts it (blocking
      // without element hiding beats no protection at all); Settings shows the problem.
      guard !coreLists.isEmpty, coreError == nil || source == "bundled" else {
        return self.fail(coreError ?? ShieldError("rule compilation failed"), completion)
      }
      self.ruleLists = coreLists
      self.calmRuleLists = []
      self.scriptlets = index
      self.version = version
      self.source = source
      self.lastError = coreError.map { "Some rules could not be loaded (\($0.localizedDescription))" }
      self.buildMillis = Int(Date().timeIntervalSince(started) * 1000)
      self.generation += 1
      self.removeStaleRuleLists(keepingPrefix: idPrefix, store: store)
      self.flushReadyWaiters()
      self.onEngineChanged?(self.status())
      completion(.success(version))

      // Calm Mode's lists after the core ones, so the first pages never wait for them.
      guard !calm.isEmpty else { return }
      self.compileLists(calm, prefix: "\(idPrefix)-calm", dir: dir, store: store) { lists, _ in
        guard !lists.isEmpty, self.version == version else { return }
        self.calmRuleLists = lists
        self.generation += 1
      }
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
