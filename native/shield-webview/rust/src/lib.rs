//! Thin wrapper around Brave's adblock-rust engine.
//!
//! The core functions here are platform-neutral so they can be unit tested on the
//! host and reused by the `filter-compiler` tool. The `android` module exposes
//! them to Kotlin over JNI (`expo.modules.shieldwebview.AdblockNative`); the `wasm`
//! module exposes them to the desktop app (`desktop/src/main/engine/wasm.ts`).

use adblock::lists::ParseOptions;
use adblock::request::Request;
use adblock::resources::{PermissionMask, Resource};
use adblock::{Engine, FilterSet};
use std::collections::HashSet;

/// Permission bit granted to trusted lists (uBlock Origin's own lists) so they
/// may use "trusted-*" scriptlets, matching uBO's `requiresTrust` behaviour.
pub const TRUSTED: PermissionMask = PermissionMask::from_bits(0b0000_0001);

pub struct ListSource {
    pub text: String,
    pub trusted: bool,
}

pub fn parse_options(trusted: bool) -> ParseOptions {
    ParseOptions {
        permissions: if trusted { TRUSTED } else { PermissionMask::default() },
        ..ParseOptions::default()
    }
}

pub fn build_engine(lists: Vec<ListSource>) -> Engine {
    let mut set = FilterSet::new(false);
    for list in lists {
        set.add_filter_list(list.text, parse_options(list.trusted));
    }
    Engine::new_with_filter_set(set)
}

pub fn deserialize_engine(bytes: &[u8]) -> Option<Engine> {
    let mut engine = Engine::default();
    engine.deserialize(bytes).ok()?;
    Some(engine)
}

pub fn use_resources_json(engine: &mut Engine, json: &str) -> Result<usize, serde_json::Error> {
    let resources: Vec<Resource> = serde_json::from_str(json)?;
    let count = resources.len();
    engine.use_resources(resources);
    Ok(count)
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Allow,
    Block,
    /// Block, but answer with this `data:` URL (from a `$redirect` filter) instead of nothing.
    Redirect(String),
}

/// `request_type` uses adblock-rust's names: "script", "stylesheet", "image",
/// "media", "font", "xmlhttprequest", "sub_frame", "main_frame", "other", ...
pub fn check(engine: &Engine, url: &str, source_url: &str, request_type: &str) -> Verdict {
    let Ok(request) = Request::new(url, source_url, request_type, "GET") else {
        return Verdict::Allow;
    };
    let result = engine.check_network_request(&request);
    if !result.should_block() {
        return Verdict::Allow;
    }
    match result.redirect {
        Some(data_url) => Verdict::Redirect(data_url),
        None => Verdict::Block,
    }
}

pub fn cosmetic_json(engine: &Engine, url: &str) -> String {
    serde_json::to_string(&engine.url_cosmetic_resources(url)).unwrap_or_else(|_| "{}".into())
}

#[derive(serde::Deserialize)]
struct HiddenQuery {
    #[serde(default)]
    classes: Vec<String>,
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    exceptions: HashSet<String>,
}

/// Takes `{"classes":[..],"ids":[..],"exceptions":[..]}` and returns a JSON array of
/// generic hide selectors that apply to those classes/ids.
pub fn hidden_selectors_json(engine: &Engine, query_json: &str) -> String {
    let Ok(query) = serde_json::from_str::<HiddenQuery>(query_json) else {
        return "[]".into();
    };
    let selectors = engine.hidden_class_id_selectors(&query.classes, &query.ids, &query.exceptions);
    serde_json::to_string(&selectors).unwrap_or_else(|_| "[]".into())
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use jni::objects::{JBooleanArray, JByteArray, JClass, JObjectArray, JString};
    use jni::sys::{jboolean, jbyteArray, jint, jlong, jstring, JNI_FALSE, JNI_TRUE};
    use jni::JNIEnv;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    // Status codes returned by nativeCheck; keep in sync with AdblockNative.kt.
    const ALLOW: jint = 0;
    const BLOCK: jint = 1;
    const REDIRECT: jint = 2;

    fn engine<'a>(handle: jlong) -> Option<&'a Engine> {
        if handle == 0 {
            None
        } else {
            // SAFETY: handles come from Box::into_raw below and Kotlin guards
            // destroy() with a write lock, so no check runs on a freed engine.
            Some(unsafe { &*(handle as *const Engine) })
        }
    }

    fn engine_mut<'a>(handle: jlong) -> Option<&'a mut Engine> {
        if handle == 0 {
            None
        } else {
            Some(unsafe { &mut *(handle as *mut Engine) })
        }
    }

    fn into_handle(engine: Engine) -> jlong {
        Box::into_raw(Box::new(engine)) as jlong
    }

    fn read_string(env: &mut JNIEnv, s: &JString) -> Option<String> {
        env.get_string(s).ok().map(Into::into)
    }

    fn new_jstring(env: &mut JNIEnv, s: &str) -> jstring {
        env.new_string(s)
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut())
    }

    /// Builds an engine from filter list files. `trusted[i]` marks list `paths[i]` as trusted.
    #[no_mangle]
    pub extern "system" fn Java_expo_modules_shieldwebview_AdblockNative_nativeCreate(
        mut env: JNIEnv,
        _class: JClass,
        paths: JObjectArray,
        trusted: JBooleanArray,
    ) -> jlong {
        catch_unwind(AssertUnwindSafe(|| {
            let len = env.get_array_length(&paths).unwrap_or(0);
            let mut flags = vec![JNI_FALSE; len as usize];
            if len > 0 {
                let _ = env.get_boolean_array_region(&trusted, 0, &mut flags);
            }
            let mut lists = Vec::with_capacity(len as usize);
            for i in 0..len {
                let Ok(obj) = env.get_object_array_element(&paths, i) else { continue };
                let Some(path) = read_string(&mut env, &JString::from(obj)) else { continue };
                if let Ok(text) = std::fs::read_to_string(&path) {
                    lists.push(ListSource { text, trusted: flags[i as usize] == JNI_TRUE });
                }
            }
            into_handle(build_engine(lists))
        }))
        .unwrap_or(0)
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_shieldwebview_AdblockNative_nativeDeserialize(
        env: JNIEnv,
        _class: JClass,
        data: JByteArray,
    ) -> jlong {
        catch_unwind(AssertUnwindSafe(|| {
            let Ok(bytes) = env.convert_byte_array(&data) else { return 0 };
            deserialize_engine(&bytes).map(into_handle).unwrap_or(0)
        }))
        .unwrap_or(0)
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_shieldwebview_AdblockNative_nativeSerialize(
        env: JNIEnv,
        _class: JClass,
        handle: jlong,
    ) -> jbyteArray {
        catch_unwind(AssertUnwindSafe(|| {
            let Some(engine) = engine(handle) else { return std::ptr::null_mut() };
            env.byte_array_from_slice(&engine.serialize())
                .map(|a| a.into_raw())
                .unwrap_or(std::ptr::null_mut())
        }))
        .unwrap_or(std::ptr::null_mut())
    }

    /// Returns the number of resources loaded, or -1 on failure.
    #[no_mangle]
    pub extern "system" fn Java_expo_modules_shieldwebview_AdblockNative_nativeUseResources(
        mut env: JNIEnv,
        _class: JClass,
        handle: jlong,
        path: JString,
    ) -> jint {
        catch_unwind(AssertUnwindSafe(|| {
            let Some(engine) = engine_mut(handle) else { return -1 };
            let Some(path) = read_string(&mut env, &path) else { return -1 };
            let Ok(json) = std::fs::read_to_string(path) else { return -1 };
            use_resources_json(engine, &json).map(|n| n as jint).unwrap_or(-1)
        }))
        .unwrap_or(-1)
    }

    /// Returns ALLOW, BLOCK or REDIRECT. For REDIRECT, `redirect_out[0]` receives the data URL.
    #[no_mangle]
    pub extern "system" fn Java_expo_modules_shieldwebview_AdblockNative_nativeCheck(
        mut env: JNIEnv,
        _class: JClass,
        handle: jlong,
        url: JString,
        source_url: JString,
        request_type: JString,
        redirect_out: JObjectArray,
    ) -> jint {
        catch_unwind(AssertUnwindSafe(|| {
            let Some(engine) = engine(handle) else { return ALLOW };
            let (Some(url), Some(source), Some(kind)) = (
                read_string(&mut env, &url),
                read_string(&mut env, &source_url),
                read_string(&mut env, &request_type),
            ) else {
                return ALLOW;
            };
            match check(engine, &url, &source, &kind) {
                Verdict::Allow => ALLOW,
                Verdict::Block => BLOCK,
                Verdict::Redirect(data_url) => {
                    if let Ok(s) = env.new_string(data_url) {
                        let _ = env.set_object_array_element(&redirect_out, 0, s);
                    }
                    REDIRECT
                }
            }
        }))
        .unwrap_or(ALLOW)
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_shieldwebview_AdblockNative_nativeCosmetic(
        mut env: JNIEnv,
        _class: JClass,
        handle: jlong,
        url: JString,
    ) -> jstring {
        let json = catch_unwind(AssertUnwindSafe(|| {
            let engine = engine(handle)?;
            let url = read_string(&mut env, &url)?;
            Some(cosmetic_json(engine, &url))
        }))
        .ok()
        .flatten()
        .unwrap_or_else(|| "{}".into());
        new_jstring(&mut env, &json)
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_shieldwebview_AdblockNative_nativeHiddenSelectors(
        mut env: JNIEnv,
        _class: JClass,
        handle: jlong,
        query_json: JString,
    ) -> jstring {
        let json = catch_unwind(AssertUnwindSafe(|| {
            let engine = engine(handle)?;
            let query = read_string(&mut env, &query_json)?;
            Some(hidden_selectors_json(engine, &query))
        }))
        .ok()
        .flatten()
        .unwrap_or_else(|| "[]".into());
        new_jstring(&mut env, &json)
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_shieldwebview_AdblockNative_nativeDestroy(
        _env: JNIEnv,
        _class: JClass,
        handle: jlong,
    ) -> jboolean {
        if handle == 0 {
            return JNI_FALSE;
        }
        // SAFETY: see `engine()`; Kotlin never uses a handle after destroying it.
        drop(unsafe { Box::from_raw(handle as *mut Engine) });
        JNI_TRUE
    }
}

/// The same functions for the desktop app, which runs this crate as WebAssembly
/// (`npm run build:engine` in desktop/). Text and bytes cross as a pointer and a length in
/// this module's memory: the caller gets room with `sw_alloc`, and reads answers from the
/// buffer at `sw_out_ptr` / `sw_out_len`, which stays valid until the next call.
#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use std::cell::RefCell;

    // Status codes returned by sw_check; keep in sync with desktop/src/main/engine/wasm.ts.
    const ALLOW: i32 = 0;
    const BLOCK: i32 = 1;
    const REDIRECT: i32 = 2;

    thread_local! {
        static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    fn set_out(bytes: Vec<u8>) {
        OUT.with(|out| *out.borrow_mut() = bytes);
    }

    /// SAFETY: `ptr`/`len` describe bytes the caller wrote into a `sw_alloc` buffer.
    unsafe fn text<'a>(ptr: *const u8, len: usize) -> std::borrow::Cow<'a, str> {
        String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len))
    }

    #[no_mangle]
    pub extern "C" fn sw_alloc(len: usize) -> *mut u8 {
        let mut buffer = Vec::<u8>::with_capacity(len.max(1));
        let ptr = buffer.as_mut_ptr();
        std::mem::forget(buffer);
        ptr
    }

    /// Frees a `sw_alloc` buffer; `len` is the length it was asked for.
    #[no_mangle]
    pub unsafe extern "C" fn sw_free(ptr: *mut u8, len: usize) {
        if !ptr.is_null() {
            drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
        }
    }

    #[no_mangle]
    pub extern "C" fn sw_out_ptr() -> *const u8 {
        OUT.with(|out| out.borrow().as_ptr())
    }

    #[no_mangle]
    pub extern "C" fn sw_out_len() -> usize {
        OUT.with(|out| out.borrow().len())
    }

    /// Filter lists are added one at a time, so only one of them is in memory twice.
    #[no_mangle]
    pub extern "C" fn sw_lists_new() -> *mut FilterSet {
        Box::into_raw(Box::new(FilterSet::new(false)))
    }

    #[no_mangle]
    pub unsafe extern "C" fn sw_lists_add(lists: *mut FilterSet, ptr: *const u8, len: usize, trusted: i32) {
        let Some(lists) = lists.as_mut() else { return };
        lists.add_filter_list(text(ptr, len).into_owned(), parse_options(trusted != 0));
    }

    /// Consumes the lists and returns the engine built from them.
    #[no_mangle]
    pub unsafe extern "C" fn sw_lists_build(lists: *mut FilterSet) -> *mut Engine {
        if lists.is_null() {
            return std::ptr::null_mut();
        }
        Box::into_raw(Box::new(Engine::new_with_filter_set(*Box::from_raw(lists))))
    }

    /// Returns null when the bytes are not an engine this version can read.
    #[no_mangle]
    pub unsafe extern "C" fn sw_deserialize(ptr: *const u8, len: usize) -> *mut Engine {
        match deserialize_engine(std::slice::from_raw_parts(ptr, len)) {
            Some(engine) => Box::into_raw(Box::new(engine)),
            None => std::ptr::null_mut(),
        }
    }

    /// Leaves the serialized engine in the out buffer.
    #[no_mangle]
    pub unsafe extern "C" fn sw_serialize(engine: *const Engine) {
        set_out(engine.as_ref().map(|e| e.serialize()).unwrap_or_default());
    }

    /// Returns the number of resources loaded, or -1 on failure.
    #[no_mangle]
    pub unsafe extern "C" fn sw_use_resources(engine: *mut Engine, ptr: *const u8, len: usize) -> i32 {
        let Some(engine) = engine.as_mut() else { return -1 };
        use_resources_json(engine, &text(ptr, len)).map(|n| n as i32).unwrap_or(-1)
    }

    /// Returns ALLOW, BLOCK or REDIRECT. For REDIRECT the out buffer holds the data URL.
    #[no_mangle]
    pub unsafe extern "C" fn sw_check(
        engine: *const Engine,
        url: *const u8,
        url_len: usize,
        source: *const u8,
        source_len: usize,
        kind: *const u8,
        kind_len: usize,
    ) -> i32 {
        let Some(engine) = engine.as_ref() else { return ALLOW };
        match check(engine, &text(url, url_len), &text(source, source_len), &text(kind, kind_len)) {
            Verdict::Allow => ALLOW,
            Verdict::Block => BLOCK,
            Verdict::Redirect(data_url) => {
                set_out(data_url.into_bytes());
                REDIRECT
            }
        }
    }

    /// Leaves adblock-rust's UrlSpecificResources for the URL, as JSON, in the out buffer.
    #[no_mangle]
    pub unsafe extern "C" fn sw_cosmetic(engine: *const Engine, url: *const u8, url_len: usize) {
        let json = engine.as_ref().map(|e| cosmetic_json(e, &text(url, url_len)));
        set_out(json.unwrap_or_else(|| "{}".into()).into_bytes());
    }

    /// Takes {"classes","ids","exceptions"} JSON; leaves a JSON array of selectors in the out buffer.
    #[no_mangle]
    pub unsafe extern "C" fn sw_hidden_selectors(engine: *const Engine, query: *const u8, query_len: usize) {
        let json = engine.as_ref().map(|e| hidden_selectors_json(e, &text(query, query_len)));
        set_out(json.unwrap_or_else(|| "[]".into()).into_bytes());
    }

    /// 1 when a request for `url` from a page at `source` goes to another site (by the public
    /// suffix list), 0 when it stays on the same site, -1 when either is not a web address.
    #[no_mangle]
    pub unsafe extern "C" fn sw_third_party(url: *const u8, url_len: usize, source: *const u8, source_len: usize) -> i32 {
        match Request::new(&text(url, url_len), &text(source, source_len), "other", "GET") {
            Ok(request) => request.is_third_party as i32,
            Err(_) => -1,
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn sw_engine_free(engine: *mut Engine) {
        if !engine.is_null() {
            drop(Box::from_raw(engine));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        build_engine(vec![ListSource {
            text: [
                "||ads.example.com^",
                "||tracker.example.net^$third-party",
                "@@||ads.example.com/allowed.js",
                "example.org##.sponsored-box",
                "##.ad-banner",
            ]
            .join("\n"),
            trusted: false,
        }])
    }

    #[test]
    fn blocks_and_allows() {
        let e = engine();
        let page = "https://news.example.org/article";
        assert_eq!(check(&e, "https://ads.example.com/a.js", page, "script"), Verdict::Block);
        assert_eq!(check(&e, "https://ads.example.com/allowed.js", page, "script"), Verdict::Allow);
        assert_eq!(check(&e, "https://cdn.example.org/app.js", page, "script"), Verdict::Allow);
        assert_eq!(check(&e, "https://tracker.example.net/p.gif", page, "image"), Verdict::Block);
    }

    #[test]
    fn cosmetics() {
        let e = engine();
        let json = cosmetic_json(&e, "https://example.org/");
        assert!(json.contains(".sponsored-box"), "{json}");
        let hidden = hidden_selectors_json(&e, r#"{"classes":["ad-banner","x"],"ids":[]}"#);
        assert_eq!(hidden, r#"[".ad-banner"]"#);
    }

    #[test]
    fn serialization_round_trip() {
        let e = engine();
        let restored = deserialize_engine(&e.serialize()).expect("deserialize");
        let page = "https://news.example.org/";
        assert_eq!(check(&restored, "https://ads.example.com/x", page, "image"), Verdict::Block);
    }
}

#[cfg(test)]
mod entity_tests {
    use super::*;

    #[test]
    fn entity_domains_match_in_network_filters() {
        let e = build_engine(vec![ListSource {
            text: "*$script,3p,domain=hdhub4u.*\n@@||googleapis.com^$script,3p,domain=hdhub4u.*".into(),
            trusted: true,
        }]);
        let page = "https://new1.hdhub4u.free/movie/";
        assert_eq!(check(&e, "https://eu.adnet.com/abc/131627", page, "script"), Verdict::Block);
        assert_eq!(check(&e, "https://ajax.googleapis.com/jquery.js", page, "script"), Verdict::Allow);
        assert_eq!(check(&e, "https://eu.adnet.com/abc/131627", "https://example.com/", "script"), Verdict::Allow);
    }
}
