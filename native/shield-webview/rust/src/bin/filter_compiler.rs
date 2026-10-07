//! Host-side tool used by scripts/filters/build.mjs.
//!
//!   filter-compiler ios --list a.txt[:trusted] ... --resources resources.json --out DIR
//!
//! Writes:
//!   DIR/rules-N.json      WKContentRuleList JSON (network blocking + element hiding)
//!   DIR/scriptlets.json   { lib: {name: js}, calls: [js], generic: Entry, hosts: {host: Entry} }
//!                         where Entry = [[dependency names], [indices into calls]]
//!                         A host's script is its deps' `lib` code followed by its calls.
//! and prints a JSON summary on stdout.

use adblock::content_blocking::{CbRule, CbType};
use adblock::filters::cosmetic::CosmeticFilter;
use adblock::resources::PermissionMask;
use adblock::FilterSet;
use adblock_jni::{build_engine, parse_options, use_resources_json, ListSource};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

/// WebKit's per-list rule limit (ContentExtensionParser maxRuleCount).
const MAX_RULES_PER_LIST: usize = 150_000;
/// A real ending (so the family of `name.<ending>` is `name.*`) that sites in the lists don't use.
const FAMILY_PROBE_ENDING: &str = "bv";

struct Args {
    lists: Vec<(PathBuf, bool)>,
    /// Lists whose element-hiding exceptions also apply here, without emitting their rules
    /// (an optional group compiled on its own, like Calm Mode's annoyance lists).
    context: Vec<PathBuf>,
    resources: Option<PathBuf>,
    out: PathBuf,
    /// Output file names: `{prefix}-0.json` (network) and `{prefix}-1.json` (hiding).
    prefix: String,
    scriptlets: bool,
}

fn parse_args() -> Args {
    let mut it = std::env::args().skip(1);
    if it.next().as_deref() != Some("ios") {
        die("usage: filter-compiler ios --list FILE[:trusted]... [--context FILE]... \
             [--resources FILE | --no-scriptlets] [--prefix NAME] --out DIR");
    }
    let (mut lists, mut context, mut resources, mut out) = (vec![], vec![], None, None);
    let (mut prefix, mut scriptlets) = ("rules".to_string(), true);
    while let Some(arg) = it.next() {
        if arg == "--no-scriptlets" {
            scriptlets = false;
            continue;
        }
        let value = it.next().unwrap_or_else(|| die(&format!("missing value for {arg}")));
        match arg.as_str() {
            "--list" => match value.strip_suffix(":trusted") {
                Some(path) => lists.push((PathBuf::from(path), true)),
                None => lists.push((PathBuf::from(value), false)),
            },
            "--context" => context.push(PathBuf::from(value.trim_end_matches(":trusted"))),
            "--resources" => resources = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            "--prefix" => prefix = value,
            other => die(&format!("unknown argument {other}")),
        }
    }
    if scriptlets && resources.is_none() {
        die("--resources is required (or --no-scriptlets)");
    }
    Args {
        lists,
        context,
        resources,
        out: out.unwrap_or_else(|| die("--out is required")),
        prefix,
        scriptlets,
    }
}

fn die(msg: &str) -> ! {
    eprintln!("filter-compiler: {msg}");
    std::process::exit(2)
}

fn main() {
    let args = parse_args();
    std::fs::create_dir_all(&args.out).expect("create out dir");

    let read = |path: &PathBuf| {
        std::fs::read_to_string(path).unwrap_or_else(|e| die(&format!("read {}: {e}", path.display())))
    };
    let texts: Vec<(String, bool)> =
        args.lists.iter().map(|(path, trusted)| (read(path), *trusted)).collect();
    let context: Vec<String> = args.context.iter().map(read).collect();

    let rule_files = write_content_rules(&texts, &context, &args.out, &args.prefix);
    let hosts = match (&args.resources, args.scriptlets) {
        (Some(resources), true) => write_scriptlets(&texts, resources, &args.out),
        _ => 0,
    };

    println!(
        "{}",
        json!({ "ruleFiles": rule_files, "scriptletHosts": hosts })
    );
}

// ---------------------------------------------------------------------------
// Content blocking rules

fn write_content_rules(texts: &[(String, bool)], context: &[String], out: &PathBuf, prefix: &str) -> Vec<Value> {
    // adblock-rust turns `site#@#sel` into a *hiding* rule for every other site, and drops
    // `$generichide` / `$elemhide`. Both are handled here instead (see cosmetic_rules).
    let mut exceptions = CosmeticExceptions::default();
    for text in context {
        text.lines().for_each(|line| {
            exceptions.take(line);
        });
    }
    let mut set = FilterSet::new(true); // debug mode is required for conversion
    for (text, trusted) in texts {
        let kept: Vec<&str> = text.lines().filter(|line| !exceptions.take(line)).collect();
        set.add_filter_list(kept.join("\n"), parse_options(*trusted));
    }
    let (rules, _) = set
        .into_content_blocking()
        .unwrap_or_else(|_| die("content blocking conversion failed"));

    // Network rules and element hiding always go in separate lists: an ignore-previous-rules
    // only affects earlier rules in its own list, so exceptions in one can't undo the other.
    // Network exceptions (including the trailing first-party document one) stay out of the
    // hiding list, where they would switch off hiding for whole pages.
    let (mut network, mut cosmetic) = (vec![], vec![]);
    for rule in rules {
        match rule.action.typ {
            CbType::CssDisplayNone => cosmetic.push(rule),
            _ => network.push(rule),
        }
    }
    cosmetic.extend(family_hiding_rules(texts));
    let groups: Vec<(String, Vec<CbRule>)> = vec![
        (format!("{prefix}-0.json"), site_family_rules(network)),
        (format!("{prefix}-1.json"), cosmetic_rules(cosmetic, &exceptions)),
    ];

    groups
        .into_iter()
        .map(|(name, mut rules)| {
            if rules.len() > MAX_RULES_PER_LIST {
                eprintln!(
                    "filter-compiler: {name} has {} rules; truncating to {MAX_RULES_PER_LIST}",
                    rules.len()
                );
                rules.truncate(MAX_RULES_PER_LIST);
            }
            let data = serde_json::to_vec(&rules).expect("serialize rules");
            std::fs::write(out.join(&name), data).expect("write rules");
            json!({ "file": name, "count": rules.len() })
        })
        .collect()
}

/// Element hiding exceptions, collected from the raw lists.
#[derive(Default)]
struct CosmeticExceptions {
    /// `a.com,b.com#@#sel`: selector -> hostnames where it must not hide anything.
    unhide: HashMap<String, BTreeSet<String>>,
    /// `@@||host^$generichide`: no generic (all-site) hiding on these hosts.
    generichide: BTreeSet<String>,
    /// `@@||host^$elemhide`: no hiding at all on these hosts.
    elemhide: BTreeSet<String>,
}

impl CosmeticExceptions {
    /// Records `line` if it is an element hiding exception; true means it was consumed.
    fn take(&mut self, line: &str) -> bool {
        let line = line.trim();
        if let Some(idx) = line.find("#@#") {
            if line[idx..].starts_with("#@#+js(") {
                return false;
            }
            let Ok(filter) = CosmeticFilter::parse(line, false, PermissionMask::default()) else {
                return true;
            };
            let hosts: Vec<String> = line[..idx].split(',').filter_map(plain_hostname).collect();
            if let (Some(selector), false) = (filter.plain_css_selector(), hosts.is_empty()) {
                self.unhide.entry(selector.to_string()).or_default().extend(hosts);
            }
            return true;
        }
        let Some(rest) = line.strip_prefix("@@||") else { return false };
        let Some((pattern, options)) = rest.split_once('$') else { return false };
        let Some(host) = pattern.strip_suffix('^').and_then(plain_hostname) else { return false };
        let options: Vec<&str> = options.split(',').map(str::trim).collect();
        let is = |names: &[&str]| options.iter().all(|o| names.contains(o));
        if is(&["elemhide", "ehide"]) {
            self.elemhide.insert(host);
            true
        } else if is(&["generichide", "ghide"]) {
            self.generichide.insert(host);
            true
        } else {
            // A `$document` allowlisting also turns hiding off; the network rule stays.
            if is(&["document", "doc"]) {
                self.elemhide.insert(host);
            }
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Site families. The lists write `name.*` for a site under every ending it uses (uBO's
// "entity"): sites that change their address every few weeks are only covered that way.
// WebKit's `if-domain` has no such wildcard (`*name.*` matches nothing), so a family is
// matched by the address of the page instead (`if-top-url`).

/// `name` of a `name.*` (or `*name.*`) entry.
fn family_name(entry: &str) -> Option<&str> {
    let name = entry.trim_start_matches('*').strip_suffix(".*")?;
    let valid = !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    valid.then_some(name)
}

/// Pages of `host` and its subdomains; with `family`, under any ending.
fn top_url_pattern(host: &str, family: bool) -> String {
    let host = host.replace('.', "\\.");
    let ending = if family { "\\.[^:/]+" } else { "" };
    format!("^[^:]+://([^:/]+\\.)?{host}{ending}[:/]")
}

/// Moves the families of `if-domain` / `unless-domain` to `if-top-url` / `unless-top-url`. A
/// trigger takes one kind of condition, so a rule for plain sites and families becomes two
/// (kept together: an ignore-previous-rules only undoes what comes before it).
fn site_family_rules(rules: Vec<CbRule>) -> Vec<CbRule> {
    let mut out = Vec::with_capacity(rules.len());
    for mut rule in rules {
        let has_family = |list: &Option<Vec<String>>| list.iter().flatten().any(|d| family_name(d).is_some());
        if has_family(&rule.trigger.if_domain) {
            let domains = rule.trigger.if_domain.take().unwrap_or_default();
            let (families, plain): (Vec<String>, Vec<String>) = domains.into_iter().partition(|d| family_name(d).is_some());
            if !plain.is_empty() {
                let mut for_plain = rule.clone();
                for_plain.trigger.if_domain = Some(plain);
                out.push(for_plain);
            }
            rule.trigger.if_top_url =
                Some(families.iter().filter_map(|d| family_name(d)).map(|name| top_url_pattern(name, true)).collect());
            out.push(rule);
        } else if has_family(&rule.trigger.unless_domain) {
            // "Everywhere but": every entry becomes a page address pattern.
            let domains = rule.trigger.unless_domain.take().unwrap_or_default();
            rule.trigger.unless_top_url = Some(
                domains
                    .iter()
                    .map(|d| match family_name(d) {
                        Some(name) => top_url_pattern(name, true),
                        None => top_url_pattern(d.trim_start_matches('*'), false),
                    })
                    .collect(),
            );
            out.push(rule);
        } else {
            out.push(rule);
        }
    }
    out
}

/// Element hiding for families (`name.*##.ad`), which adblock-rust's conversion leaves out.
fn family_hiding_rules(texts: &[(String, bool)]) -> Vec<CbRule> {
    // selector -> families, so a selector shared by many families is one rule.
    let mut by_selector: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (text, _) in texts {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('!') || !line.contains(".*") {
                continue;
            }
            let Some(idx) = line.find("##") else { continue };
            if line[idx..].starts_with("##+js(") || line[idx..].starts_with("##^") {
                continue;
            }
            let families: Vec<&str> = line[..idx].split(',').filter_map(|d| family_name(d.trim())).collect();
            if families.is_empty() {
                continue;
            }
            let Ok(filter) = CosmeticFilter::parse(line, false, PermissionMask::default()) else { continue };
            let Some(selector) = filter.plain_css_selector() else { continue };
            by_selector.entry(selector.to_string()).or_default().extend(families.iter().map(|f| f.to_string()));
        }
    }
    by_selector
        .into_iter()
        .map(|(selector, families)| {
            let patterns: Vec<String> = families.iter().map(|name| top_url_pattern(name, true)).collect();
            serde_json::from_value(json!({
                "trigger": { "url-filter": ".*", "if-top-url": patterns },
                "action": { "type": "css-display-none", "selector": selector },
            }))
            .unwrap()
        })
        .collect()
}

fn plain_hostname(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    let valid = s.contains('.')
        && !s.starts_with('.')
        && !s.ends_with('.')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    valid.then_some(s)
}

/// True if `host` is `domain` or one of its subdomains.
fn within(host: &str, domain: &str) -> bool {
    host == domain || host.strip_suffix(domain).is_some_and(|rest| rest.ends_with('.'))
}

fn ignore_rules_for(hosts: &BTreeSet<String>) -> Vec<CbRule> {
    hosts
        .iter()
        .map(|host| {
            serde_json::from_value(json!({
                "trigger": { "url-filter": ".*", "if-domain": [format!("*{host}")] },
                "action": { "type": "ignore-previous-rules" },
            }))
            .unwrap()
        })
        .collect()
}

/// Orders the hiding list as: generic rules, `$generichide` exceptions, site-specific rules,
/// `$elemhide` exceptions. WebKit applies an ignore-previous-rules only to rules before it.
fn cosmetic_rules(rules: Vec<CbRule>, exceptions: &CosmeticExceptions) -> Vec<CbRule> {
    let (mut generic, mut specific) = (vec![], vec![]);
    for mut rule in rules {
        let t = &mut rule.trigger;
        // WebKit matches a bare domain exactly; `*domain` also covers www., m. and the rest.
        for list in [&mut t.if_domain, &mut t.unless_domain].into_iter().flatten() {
            for d in list.iter_mut() {
                if !d.starts_with('*') {
                    *d = format!("*{d}");
                }
            }
        }
        let exempt = rule.action.selector.as_ref().and_then(|s| exceptions.unhide.get(s));
        match (&mut t.if_domain, exempt) {
            (Some(domains), Some(exempt)) => {
                domains.retain(|d| !exempt.iter().any(|e| within(&d[1..], e)));
                if domains.is_empty() {
                    continue;
                }
            }
            (None, Some(exempt)) => {
                let unless = t.unless_domain.get_or_insert_with(Vec::new);
                unless.extend(exempt.iter().map(|e| format!("*{e}")));
                unless.sort();
                unless.dedup();
            }
            _ => {}
        }
        if t.if_domain.is_some() || t.if_top_url.is_some() {
            specific.push(rule);
        } else {
            generic.push(rule);
        }
    }
    let mut out = generic;
    out.extend(ignore_rules_for(&exceptions.generichide));
    out.extend(specific);
    out.extend(ignore_rules_for(&exceptions.elemhide));
    out
}

// ---------------------------------------------------------------------------
// Scriptlets

/// Hostnames that have `##+js(...)` filters, and site families (`example.*`, kept with
/// their `.*`). Regex and negated domains are skipped since they cannot be keyed by hostname.
fn scriptlet_hosts(texts: &[(String, bool)]) -> BTreeSet<String> {
    let mut hosts = BTreeSet::new();
    for (text, _) in texts {
        for line in text.lines() {
            if line.starts_with('!') {
                continue;
            }
            let Some(idx) = line.find("##+js(") else { continue };
            for domain in line[..idx].split(',') {
                let domain = domain.trim().to_ascii_lowercase();
                let valid = domain.contains('.')
                    && !domain.starts_with('.')
                    && !domain.ends_with('.')
                    && domain.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
                if valid {
                    hosts.insert(domain);
                } else if family_name(&domain).is_some() {
                    hosts.insert(domain.trim_start_matches('*').to_string());
                }
            }
        }
    }
    hosts
}

fn write_scriptlets(texts: &[(String, bool)], resources: &PathBuf, out: &PathBuf) -> usize {
    let mut engine = build_engine(
        texts
            .iter()
            .map(|(text, trusted)| ListSource { text: text.clone(), trusted: *trusted })
            .collect(),
    );
    let resources_json = std::fs::read_to_string(resources).expect("read resources");
    use_resources_json(&mut engine, &resources_json).expect("parse resources");

    // name -> decoded JS, used to split an injected script into shared deps + invocations.
    let resources_list: Vec<Value> = serde_json::from_str(&resources_json).unwrap();
    let mut library: Vec<(String, String)> = resources_list
        .iter()
        .filter_map(|r| {
            let mime = r["kind"]["mime"].as_str()?;
            if mime != "application/javascript" && mime != "fn/javascript" {
                return None;
            }
            let content = decode_base64(r["content"].as_str()?)?;
            Some((r["name"].as_str()?.to_string(), content))
        })
        .collect();
    // Longest first so a resource whose text prefixes another can't shadow it.
    library.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

    // Many hosts share the same invocations, so each distinct `try { call } catch` block is
    // stored once in `calls` and hosts reference it by index.
    const CALL_END: &str = "\n} catch ( e ) { }\n";
    let mut used_lib: BTreeMap<String, String> = BTreeMap::new();
    let mut calls: Vec<String> = vec![];
    let mut call_index: HashMap<String, usize> = HashMap::new();
    let mut split = |script: &str| -> Value {
        let mut deps = vec![];
        let mut rest = script;
        'outer: loop {
            for (name, content) in &library {
                if let Some(after) = rest.strip_prefix(content.as_str()) {
                    if let Some(after) = after.strip_prefix('\n') {
                        deps.push(name.clone());
                        used_lib.insert(name.clone(), content.clone());
                        rest = after;
                        continue 'outer;
                    }
                }
            }
            break;
        }
        let mut indices = vec![];
        while !rest.is_empty() {
            let end = rest.find(CALL_END).map_or(rest.len(), |i| i + CALL_END.len());
            let call = &rest[..end];
            let next = calls.len();
            let idx = *call_index.entry(call.to_string()).or_insert_with(|| {
                calls.push(call.to_string());
                next
            });
            indices.push(idx);
            rest = &rest[end..];
        }
        json!([deps, indices])
    };

    let generic_script = engine.url_cosmetic_resources("https://generic.invalid/").injected_script;
    let generic = split(&generic_script);

    let mut hosts = Map::new();
    for host in scriptlet_hosts(texts) {
        // A family is asked about under an ending that no list names a site for; the app
        // looks it up by `name.*` when a site's own address isn't listed.
        let asked = match family_name(&host) {
            Some(name) => format!("{name}.{FAMILY_PROBE_ENDING}"),
            None => host.clone(),
        };
        let script = engine.url_cosmetic_resources(&format!("https://{asked}/")).injected_script;
        if script.is_empty() || script == generic_script {
            continue;
        }
        hosts.insert(host, split(&script));
    }
    let count = hosts.len();

    let doc = json!({ "lib": used_lib, "calls": calls, "generic": generic, "hosts": hosts });
    std::fs::write(out.join("scriptlets.json"), serde_json::to_vec(&doc).unwrap())
        .expect("write scriptlets");
    count
}

fn decode_base64(input: &str) -> Option<String> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [255u8; 256];
    for (i, c) in ALPHABET.iter().enumerate() {
        table[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in input.bytes().filter(|c| *c != b'=' && !c.is_ascii_whitespace()) {
        let v = table[c as usize];
        if v == 255 {
            return None;
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    String::from_utf8(out).ok()
}
