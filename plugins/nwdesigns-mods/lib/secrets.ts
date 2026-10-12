// secret-redact: the pure matcher for stored tool results. No runtime imports.
//
// Two tiers. Exact: the values of the secret files, parsed as data (never
// sourced), each replaced by [REDACTED:<NAME>]. Regex: known secret formats,
// each replaced by [REDACTED:<kind>]. Not a guarantee: an unknown format, a
// split or encoded value, or a secret in an image passes.
//
// Every pattern is linear without a length cap: a match can start only at a
// token boundary (lookbehind), so a long run is scanned once and a long
// credential is consumed whole, never cut with a tail left. A result over
// LIMITS (size, time, depth) throws RedactLimitError, and the caller withholds
// it: the engine's own budget would hand the raw result back.

export type Named = { name: string; value: string };
export type Matcher = { exact: RegExp | null; names: Map<string, string> };
export type Limits = { maxChars: number; ms: number; depth: number };

export const MIN_LEN = 12; // a value under a credential name: 8
export const WITHHELD = "[withheld: secret redaction failed]";
export const LIMITS: Limits = { maxChars: 8_000_000, ms: 3000, depth: 64 };

export class RedactLimitError extends Error {}

// KEY=value lines; `export`, quotes and trailing comments handled. Never run.
// indexOf and trim, no regex over the whole line: linear for any input.
export function parseEnv(text: string): Named[] {
  const out: Named[] = [];
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let name = line.slice(0, eq).trim();
    if (/^export\s/.test(name)) name = name.slice(7).trim();
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) continue;
    let v = line.slice(eq + 1).trim();
    const q = v[0];
    if (q === '"') {
      // As the shell reads it: \ before \ " $ ` is dropped, any other stays.
      let s = "";
      let i = 1;
      for (; i < v.length && v[i] !== '"'; i++) {
        if (v[i] === "\\" && '\\"$`'.includes(v[i + 1] ?? "x")) i++;
        s += v[i];
      }
      v = s;
    } else if (q === "'") {
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      // A comment starts at whitespace + `#`; indexOf-style, linear.
      const at = v.search(/\s#/);
      if (at >= 0) v = v.slice(0, at).trimEnd();
    }
    out.push({ name, value: v });
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// String leaves of an auth.json, named by their key path; `keep` drops the
// ids and dates.
export function jsonLeaves(text: string): Named[] {
  const out: Named[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > LIMITS.depth) return;
    if (typeof v === "string") out.push({ name: path || "auth", value: v });
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v))
        walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(JSON.parse(text), "", 0);
  return out;
}

// Which loaded values become exact secrets, decided by the key name first.
// A credential name (KEY, TOKEN, SECRET, PASS, AUTH, ...) is always matched
// (8+ characters, not a plain URL, path, email, date or boolean). Otherwise a
// value needs 12+ characters and is dropped when it is a number or a
// model-like name (`claude-opus-5-5`), or a hex SHA or UUID under an
// identifier name (*_ID, *_SHA, COMMIT, VERSION, PORT, ...). A hex or UUID
// value under any other name is kept: the safe side.
const CREDENTIAL_NAME =
  /key|token|secret|pass|auth|credential|private|session|cookie|signature|access|refresh|bearer|cert/i;
const IDENTIFIER_NAME =
  /(^|[_.])(ids?|sha|commit|rev|revision|version|hash|uuid|port|build|ref|tag|region|zone)$|[a-z]_?id$/i;

// Every test is anchored at the start and has one way to match, so each is
// linear (the URL user part excludes `:`, the old quadratic case).
function plain(v: string): boolean {
  return (
    /^(true|false|yes|no|on|off|null)$/i.test(v) ||
    /^[^\s@]+@[\w-]+(\.[\w-]+)+$/.test(v) ||
    /^\d{4}-\d{2}-\d{2}/.test(v) ||
    (/^[a-z][a-z\d+.-]*:\/\//i.test(v) &&
      !/:\/\/[^/\s@:]*:[^/\s@]*@/.test(v)) ||
    /^(~|\.{0,2})\/[\w./ -]*$/.test(v)
  );
}

// `name` is an env key or a JSON key path; only its last segment counts
// (`tokens.account_id` is an id, not a token).
export function keep(name: string, v: string): boolean {
  if (v.length < 8 || plain(v)) return false;
  name = name.slice(name.lastIndexOf(".") + 1);
  if (CREDENTIAL_NAME.test(name)) return true;
  if (v.length < MIN_LEN) return false;
  if (/^[\d.:,\s-]+$/.test(v) || /^[a-z]+([-_.]([a-z]+|\d{1,4}))*$/.test(v))
    return false;
  const idShape = /^[0-9a-f]{7,40}$/i.test(v) || UUID.test(v);
  return !(idShape && IDENTIFIER_NAME.test(name));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Values a person typed into secret-box: always exact secrets, whatever their
// name. In this module's memory only, like the file values.
const HANDED = new Map<string, string>();
export function handed(name: string, value: string): void {
  if (value.length >= 6) HANDED.set(value, name);
}
export const handedCount = () => HANDED.size;

export function buildMatcher(entries: Named[]): Matcher {
  const names = new Map(HANDED);
  for (const { name, value } of entries)
    if (keep(name, value) && !names.has(value)) names.set(value, name);
  const values = [...names.keys()].sort((a, b) => b.length - a.length);
  return {
    exact: values.length ? new RegExp(values.map(escape).join("|"), "g") : null,
    names,
  };
}

// Not already redacted, not a variable reference ($TOKEN, ${TOKEN}).
const NOT_DONE = "(?!\\[REDACTED|\\$)";

// Order matters: the specific prefixes before the generic `sk-`, the header
// forms after the token forms (they skip what is already redacted).
const PATTERNS: Array<[RegExp, string]> = [
  [/(?<![\w-])eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, "[REDACTED:jwt]"],
  [/(?<![\w-])sk-ant-[\w-]{20,}/g, "[REDACTED:anthropic-key]"],
  [/(?<![\w-])sk-[\w-]{20,}/g, "[REDACTED:openai-key]"],
  [/(?<!\w)gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"],
  [/(?<!\w)github_pat_\w{20,}/g, "[REDACTED:github-token]"],
  [/(?<![\w-])glpat-[\w-]{20,}/g, "[REDACTED:gitlab-token]"],
  [/(?<![\w-])xox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"],
  [/(?<!\w)AKIA[0-9A-Z]{16}(?!\w)/g, "[REDACTED:aws-key]"],
  [
    new RegExp(`(?<!\\w)(Bearer\\s{1,8})${NOT_DONE}[\\w.~+/=-]{20,}`, "gi"),
    "$1[REDACTED:bearer]",
  ],
  [
    new RegExp(
      `(authorization["']?\\s{0,8}[:=]\\s{0,8}["']?(?:(?:Bearer|Basic|Token)\\s{1,8})?)${NOT_DONE}[^\\s"',;]{8,}`,
      "gi",
    ),
    "$1[REDACTED:authorization]",
  ],
  [
    // One start per `://` (the scheme starts a run); user and password runs
    // end at `/`, `@` or whitespace, so each is scanned once.
    new RegExp(
      `((?<![\\w+.-])[a-z][a-z\\d+.-]{0,30}://[^\\s/:@]+:)${NOT_DONE}[^\\s/@]+@`,
      "gi",
    ),
    "$1[REDACTED:url-password]@",
  ],
];

// PEM private keys by one forward scan, not a regex: linear for any input.
// The block runs from BEGIN over the key body to its END line; without an
// END, to the first character that cannot be in a key body. No length cap. A
// backslash belongs to the body: a JSON-escaped key (`\n` as two characters)
// runs to its END too, or else to the closing quote of its string.
const PEM_BODY = /[A-Za-z0-9+/=\s:,.\\-]/;
function redactPem(text: string): string {
  // indexOf within a small window, so no search runs to the end of the text.
  const find = (s: string, from: number) => {
    const i = text.slice(from, from + 64).indexOf(s);
    return i < 0 ? -1 : from + i;
  };
  let out = "";
  let from = 0;
  for (;;) {
    const at = text.indexOf("-----BEGIN ", from);
    if (at < 0) break;
    const head = find("PRIVATE KEY-----", at);
    if (head < 0) {
      out += text.slice(from, at + 11);
      from = at + 11;
      continue;
    }
    let stop = head + 16;
    while (stop < text.length) {
      if (text.startsWith("-----END ", stop)) {
        const end = find("PRIVATE KEY-----", stop);
        if (end >= 0) {
          stop = end + 16;
          break;
        }
      }
      if (!PEM_BODY.test(text[stop]!)) break;
      stop++;
    }
    out += text.slice(from, at) + "[REDACTED:private-key]";
    from = stop;
  }
  return from === 0 ? text : out + text.slice(from);
}

export function redactText(text: string, m: Matcher): string {
  let t = m.exact
    ? text.replace(m.exact, (v) => `[REDACTED:${m.names.get(v) ?? "secret"}]`)
    : text;
  t = redactPem(t);
  for (const [re, to] of PATTERNS) t = t.replace(re, to);
  return t;
}

// Binary payloads are left whole: an image or audio block, a base64 source, a
// Read image (`file.base64`), and the `data`/`blob` of an object whose media
// type is not text. Text payloads (an MCP text resource) are redacted.
const TEXT_TYPE = /^text\/|json|xml|javascript|yaml|csv|x-sh/i;
function isBinaryKey(o: Record<string, unknown>, k: string): boolean {
  if (k === "base64") return true;
  if (k !== "data" && k !== "blob") return false;
  if (o.type === "base64" || k === "blob") return true;
  const t = o.mimeType ?? o.media_type;
  return typeof t === "string" && !TEXT_TYPE.test(t);
}

// A new value with every string redacted; arrays and plain objects rebuilt,
// the rest kept. `changed` is false when nothing matched, so the caller can
// hand the original back untouched. Throws RedactLimitError past `limits`.
export function redactDeep(
  value: unknown,
  m: Matcher,
  limits: Limits = LIMITS,
  now: () => number = Date.now,
): { value: unknown; changed: boolean } {
  let changed = false;
  let chars = 0;
  const deadline = now() + limits.ms;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > limits.depth) throw new RedactLimitError("depth");
    if (typeof v === "string") {
      chars += v.length;
      if (chars > limits.maxChars) throw new RedactLimitError("size");
      if (now() > deadline) throw new RedactLimitError("time");
      const r = redactText(v, m);
      if (r !== v) changed = true;
      return r;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && Object.getPrototypeOf(v) === Object.prototype) {
      const o = v as Record<string, unknown>;
      if (o.type === "image" || o.type === "audio") return o;
      return Object.fromEntries(
        Object.entries(o).map(([k, x]) => [
          k,
          isBinaryKey(o, k) ? x : walk(x, depth + 1),
        ]),
      );
    }
    return v;
  };
  const out = walk(value, 0);
  if (now() > deadline) throw new RedactLimitError("time");
  return { value: changed ? out : value, changed };
}
