// The adblock-rust engine, compiled to WebAssembly (native/shield-webview/rust, `mod wasm`).
// Text and bytes are copied into the module's memory; answers are read from its out buffer.

type Exports = {
  memory: WebAssembly.Memory;
  sw_alloc(len: number): number;
  sw_free(ptr: number, len: number): void;
  sw_out_ptr(): number;
  sw_out_len(): number;
  sw_lists_new(): number;
  sw_lists_add(lists: number, ptr: number, len: number, trusted: number): void;
  sw_lists_build(lists: number): number;
  sw_deserialize(ptr: number, len: number): number;
  sw_serialize(engine: number): void;
  sw_use_resources(engine: number, ptr: number, len: number): number;
  sw_check(engine: number, url: number, urlLen: number, source: number, sourceLen: number, kind: number, kindLen: number): number;
  sw_cosmetic(engine: number, url: number, urlLen: number): void;
  sw_hidden_selectors(engine: number, query: number, queryLen: number): void;
  sw_third_party(url: number, urlLen: number, source: number, sourceLen: number): number;
  sw_engine_free(engine: number): void;
};

// Status codes returned by sw_check; keep in sync with lib.rs.
const BLOCK = 1;
const REDIRECT = 2;

export type Verdict = { action: 'allow' } | { action: 'block' } | { action: 'redirect'; dataUrl: string };
const ALLOW: Verdict = { action: 'allow' };
const BLOCKED: Verdict = { action: 'block' };

export type CosmeticResources = {
  hide_selectors: string[];
  procedural_actions: string[];
  exceptions: string[];
  injected_script: string;
  generichide: boolean;
};

/** One engine: a compiled set of filter lists. Free it when a newer one replaces it. */
export type Engine = { readonly handle: number };

export class AdblockWasm {
  private readonly x: Exports;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  // A buffer in the module's memory that is reused for the strings of every call.
  private scratch = 0;
  private scratchSize = 0;

  constructor(wasm: BufferSource) {
    const module = new WebAssembly.Module(wasm);
    this.x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  }

  /** Copies strings into the scratch buffer, one after another; returns [ptr, len] pairs. */
  private put(...strings: string[]): number[] {
    // A UTF-16 unit never needs more than three UTF-8 bytes.
    let needed = 0;
    for (const s of strings) needed += s.length * 3;
    if (needed > this.scratchSize) {
      if (this.scratch) this.x.sw_free(this.scratch, this.scratchSize);
      this.scratchSize = Math.max(needed, 16 * 1024);
      this.scratch = this.x.sw_alloc(this.scratchSize);
    }
    // The memory's buffer is replaced whenever the memory grows, so look it up each time.
    const view = new Uint8Array(this.x.memory.buffer, this.scratch, this.scratchSize);
    const out: number[] = [];
    let offset = 0;
    for (const s of strings) {
      const { written } = this.encoder.encodeInto(s, view.subarray(offset));
      out.push(this.scratch + offset, written);
      offset += written;
    }
    return out;
  }

  private withBytes<T>(bytes: Uint8Array, use: (ptr: number, len: number) => T): T {
    const ptr = this.x.sw_alloc(bytes.length);
    try {
      new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
      return use(ptr, bytes.length);
    } finally {
      this.x.sw_free(ptr, bytes.length);
    }
  }

  private outBytes(): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, this.x.sw_out_ptr(), this.x.sw_out_len());
  }

  private outText(): string {
    return this.decoder.decode(this.outBytes());
  }

  build(lists: { text: Uint8Array; trusted: boolean }[]): Engine {
    const set = this.x.sw_lists_new();
    for (const list of lists) {
      this.withBytes(list.text, (ptr, len) => this.x.sw_lists_add(set, ptr, len, list.trusted ? 1 : 0));
    }
    const handle = this.x.sw_lists_build(set);
    if (!handle) throw new Error('engine build failed');
    return { handle };
  }

  /** Null when the bytes are not an engine this version can read (an old cache file). */
  deserialize(bytes: Uint8Array): Engine | null {
    const handle = this.withBytes(bytes, (ptr, len) => this.x.sw_deserialize(ptr, len));
    return handle ? { handle } : null;
  }

  serialize(engine: Engine): Uint8Array {
    this.x.sw_serialize(engine.handle);
    return this.outBytes().slice();
  }

  /** Loads scriptlets and redirect resources (resources.json); returns how many, or -1. */
  useResources(engine: Engine, json: Uint8Array): number {
    return this.withBytes(json, (ptr, len) => this.x.sw_use_resources(engine.handle, ptr, len));
  }

  /** `requestType` uses adblock-rust's names: "script", "image", "sub_frame", "xmlhttprequest", ... */
  check(engine: Engine, url: string, sourceUrl: string, requestType: string): Verdict {
    const [u, ul, s, sl, k, kl] = this.put(url, sourceUrl, requestType);
    const result = this.x.sw_check(engine.handle, u, ul, s, sl, k, kl);
    if (result === BLOCK) return BLOCKED;
    if (result === REDIRECT) return { action: 'redirect', dataUrl: this.outText() };
    return ALLOW;
  }

  cosmeticResources(engine: Engine, url: string): CosmeticResources {
    const [u, ul] = this.put(url);
    this.x.sw_cosmetic(engine.handle, u, ul);
    return JSON.parse(this.outText()) as CosmeticResources;
  }

  /** Takes {"classes","ids","exceptions"} JSON, returns a JSON array of selectors. */
  hiddenSelectors(engine: Engine, queryJson: string): string {
    const [q, ql] = this.put(queryJson);
    this.x.sw_hidden_selectors(engine.handle, q, ql);
    return this.outText();
  }

  /** Whether a request for `url` from a page at `sourceUrl` goes to another site (public suffix list). */
  isThirdParty(url: string, sourceUrl: string): boolean {
    const [u, ul, s, sl] = this.put(url, sourceUrl);
    return this.x.sw_third_party(u, ul, s, sl) === 1;
  }

  free(engine: Engine): void {
    this.x.sw_engine_free(engine.handle);
  }
}
