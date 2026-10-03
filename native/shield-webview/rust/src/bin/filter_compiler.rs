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
use adblock::FilterSet;
use adblock_jni::{build_engine, parse_options, use_resources_json, ListSource};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

/// WebKit's per-list rule limit (ContentExtensionParser maxRuleCount).
const MAX_RULES_PER_LIST: usize = 150_000;

struct Args {
    lists: Vec<(PathBuf, bool)>,
    resources: PathBuf,
    out: PathBuf,
}

fn parse_args() -> Args {
    let mut it = std::env::args().skip(1);
    if it.next().as_deref() != Some("ios") {
        die("usage: filter-compiler ios --list FILE[:trusted]... --resources FILE --out DIR");
    }
    let (mut lists, mut resources, mut out) = (vec![], None, None);
    while let Some(arg) = it.next() {
        let value = it.next().unwrap_or_else(|| die(&format!("missing value for {arg}")));
        match arg.as_str() {
            "--list" => match value.strip_suffix(":trusted") {
                Some(path) => lists.push((PathBuf::from(path), true)),
                None => lists.push((PathBuf::from(value), false)),
            },
            "--resources" => resources = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            other => die(&format!("unknown argument {other}")),
        }
    }
    Args {
        lists,
        resources: resources.unwrap_or_else(|| die("--resources is required")),
        out: out.unwrap_or_else(|| die("--out is required")),
    }
}

fn die(msg: &str) -> ! {
    eprintln!("filter-compiler: {msg}");
    std::process::exit(2)
}

fn main() {
    let args = parse_args();
    std::fs::create_dir_all(&args.out).expect("create out dir");

    let texts: Vec<(String, bool)> = args
        .lists
        .iter()
        .map(|(path, trusted)| {
            let text = std::fs::read_to_string(path)
                .unwrap_or_else(|e| die(&format!("read {}: {e}", path.display())));
            (text, *trusted)
        })
        .collect();

    let rule_files = write_content_rules(&texts, &args.out);
    let hosts = write_scriptlets(&texts, &args.resources, &args.out);

    println!(
        "{}",
        json!({ "ruleFiles": rule_files, "scriptletHosts": hosts })
    );
}

// ---------------------------------------------------------------------------
// Content blocking rules

fn write_content_rules(texts: &[(String, bool)], out: &PathBuf) -> Vec<Value> {
    let mut set = FilterSet::new(true); // debug mode is required for conversion
    for (text, trusted) in texts {
        set.add_filter_list(text.clone(), parse_options(*trusted));
    }
    let (rules, _) = set
        .into_content_blocking()
        .unwrap_or_else(|_| die("content blocking conversion failed"));

    // One list keeps exception (ignore-previous-rules) semantics exact. WebKit only
    // applies an exception to rules in the same list, so if we must split, exceptions
    // are copied into both halves.
    let groups: Vec<(&str, Vec<CbRule>)> = if rules.len() <= MAX_RULES_PER_LIST {
        vec![("rules-0.json", rules)]
    } else {
        let (mut network, mut cosmetic) = (vec![], vec![]);
        for rule in rules {
            match rule.action.typ {
                CbType::CssDisplayNone => cosmetic.push(rule),
                CbType::IgnorePreviousRules => {
                    cosmetic.push(rule.clone());
                    network.push(rule);
                }
                _ => network.push(rule),
            }
        }
        vec![("rules-0.json", network), ("rules-1.json", cosmetic)]
    };

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
            std::fs::write(out.join(name), data).expect("write rules");
            json!({ "file": name, "count": rules.len() })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Scriptlets

/// Hostnames that have `##+js(...)` filters. Entity (`example.*`), regex and
/// negated domains are skipped since they cannot be keyed by hostname.
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
        let script = engine.url_cosmetic_resources(&format!("https://{host}/")).injected_script;
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
