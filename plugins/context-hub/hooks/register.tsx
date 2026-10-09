// context-hub mod: polls the hub feed in the session host and draws the notices (toast, band, pane).
// UI only: no notice, header or text reaches the model by itself. "Chiedi a Claude" puts the header line
// (never the text) in the prompt, and the human sends it.
// `$.state` holds headers and the cursor only. The token and the fetched item live in module variables:
// a hot reload drops them, then the token is read again and the item is fetched again.
import { atom, read, update } from "claude-code";
import type { EngineInterface, HttpResponse, Register } from "claude-code";

import type { HubHeader, HubKind } from "../types";

type $ = EngineInterface;
type Item =
  | {
      kind: "handoff";
      fromName: string;
      project: string;
      at: number;
      title: string;
      body: string;
    }
  | {
      kind: "question";
      fromName: string;
      toName: string;
      project: string;
      state: string;
      text: string | null; // null: removed by the retention period
      blocks: string | null;
      answer: { text: string; label: string } | null;
      draft: string | null;
    };

const HUB = "https://hub.nwdesigns.it";
const INBOX = `${HUB}/inbox`;
const PANE = "hub";
const LABELS: Record<HubKind, string> = {
  handoff: "Nuovo messaggio",
  question: "Nuova domanda",
  confirmation: "Una risposta aspetta la tua conferma",
  answer: "Risposta",
  correction: "Risposta corretta",
};
const TOKEN = /^hubch_[A-Za-z0-9_-]{43}$/;
const PROJECT = /^[a-z0-9-]{1,64}$/;
const ID = /^[a-z0-9]{20}$/;
const INTERVAL = 30000;
const MAX_BACKOFF = 5 * 60 * 1000;
const UI_WAIT = 15000;
const ITEM_TTL = 10 * 60 * 1000;
const FEED_BYTES = 64 * 1024;
const ITEM_BYTES = 256 * 1024;
const REVOKED = "Hub: token revocato — /hub per ricaricare";

const cursorA = atom({ plugin: "context-hub", key: "cursor" } as const, null);
const eventsA = atom({ plugin: "context-hub", key: "events" } as const, []);
const unreadA = atom({ plugin: "context-hub", key: "unread" } as const, 0);
const hiddenA = atom(
  { plugin: "context-hub", key: "bandHidden" } as const,
  false,
);
const statusA = atom({ plugin: "context-hub", key: "status" } as const, "");

// Same filter as channel/server.mjs: letters, digits, space, `._-`, 30 chars.
const clean = (value: string) =>
  value.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 30);
// Display policy for every drawn field: no control characters but newline and tab, no format characters.
const show = (value: string) =>
  value.replace(/[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|(?![\n\t])\p{Cc}/gu, "");
const bytes = (text: string) => new TextEncoder().encode(text).length;
const line = (h: HubHeader) =>
  `${LABELS[h.kind]} da ${show(h.from).slice(0, 80)} (${show(h.project).slice(0, 80)})`;
const notice = (h: HubHeader) => `${line(h)}. Testo non incluso: ${INBOX}`;

// Module variables: gone on hot reload, never in `$.state`.
let token: string | null = null;
let tokenState: "ok" | "none" | "bad" | "revoked" = "none";
let session = 0; // bumped on every clear and token change; poll and item answers check it
let selection = 0; // bumped on every select and pane close; item answers and the expiry timer check it
let selected: number | null = null;
let item: { data: Item; at: number } | null = null;
let itemMessage = "";
let entryMessage = "";
let pollBusy = false;
let itemBusy = false;
let delay = INTERVAL;
let resumeAt = 0;
let poller: { cancel: () => void } | null = null;
let expiry: { cancel: () => void } | null = null;

async function setStatus($: $, text: string) {
  await update($, statusA, () => text);
  $.ui.status(text || undefined);
}

// The real request keeps running after the UI gives up: `$.http.fetch` has no cancel signal.
// The caller's busy flag clears only when `request` settles, so one request per lane exists at a time.
async function race(
  request: Promise<HttpResponse>,
  $: $,
): Promise<HttpResponse | "timeout" | "error"> {
  let timer: { cancel: () => void } | undefined;
  const late = new Promise<"timeout">((resolve) => {
    timer = $.clock.after(UI_WAIT, () => resolve("timeout"));
  });
  try {
    return await Promise.race([request.catch(() => "error" as const), late]);
  } finally {
    timer?.cancel();
  }
}

async function run($: $, argv: string[], stdin?: string) {
  try {
    return await $.process.run(argv, {
      timeoutMs: 5000,
      ...(stdin === undefined ? {} : { stdin }),
    });
  } catch {
    return null;
  }
}

// "<mode> <uid>" of a path: GNU stat first, BSD stat on a non-zero exit.
async function modeOwner($: $, path: string) {
  for (const argv of [
    ["/usr/bin/stat", "-c", "%a %u", path],
    ["/usr/bin/stat", "-f", "%Lp %u", path],
  ]) {
    const r = await run($, argv);
    if (r?.exitCode === 0) return r.stdout.trim();
  }
  return null;
}

async function tokenDir($: $) {
  const base =
    (await $.env.get("XDG_CONFIG_HOME")) ||
    ((await $.env.get("HOME")) ? `${await $.env.get("HOME")}/.config` : "");
  return base.startsWith("/") ? `${base}/context-hub` : null;
}

// The dir is spelled as it is (no link on the path), yours, mode 700.
async function dirOk($: $, dir: string, uid: string) {
  try {
    const info = await $.fs.stat(dir, { resolve: true });
    return (
      info.kind === "dir" &&
      !info.isLink &&
      info.realPath === dir &&
      (await modeOwner($, dir)) === `700 ${uid}`
    );
  } catch {
    return false;
  }
}

// ponytail: stat-read-stat is not one handle like server.mjs; whoever can swap files in your home already holds your account.
async function readToken($: $): Promise<{ token: string } | "none" | "bad"> {
  const dir = await tokenDir($);
  if (!dir) return "none";
  const file = `${dir}/ui-token`;
  let before;
  try {
    before = await $.fs.stat(file);
  } catch {
    return "none";
  }
  const uid = (await run($, ["/usr/bin/id", "-u"]))?.stdout.trim();
  if (!uid || !/^\d+$/.test(uid) || !(await dirOk($, dir, uid))) return "bad";
  if (
    before.isLink ||
    before.kind !== "file" ||
    before.size > 256 ||
    (await modeOwner($, file)) !== `600 ${uid}`
  )
    return "bad";
  let text;
  try {
    text = await $.fs.read(file);
  } catch {
    return "bad";
  }
  let after;
  try {
    after = await $.fs.stat(file);
  } catch {
    return "bad";
  }
  if (
    after.isLink ||
    after.kind !== "file" ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  )
    return "bad";
  const value = typeof text === "string" ? text.trim() : "";
  return TOKEN.test(value) ? { token: value } : "bad";
}

function dropItem() {
  selection += 1;
  selected = null;
  item = null;
  itemMessage = "";
  expiry?.cancel();
  expiry = null;
}

async function clearHeaders($: $) {
  session += 1;
  dropItem();
  await update($, eventsA, () => []);
  await update($, unreadA, () => 0);
}

// Poll 401/403, item 401 or 403 grant: stop polling, forget the token, clear everything.
async function revoke($: $) {
  token = null;
  tokenState = "revoked";
  poller?.cancel();
  poller = null;
  await clearHeaders($);
  await setStatus($, REVOKED);
  $.ui.invalidate("ui.render");
}

function startPolling($: $, first: number) {
  poller?.cancel();
  delay = INTERVAL;
  resumeAt = 0;
  const timer = $.clock.after(first, () => {
    void poll($);
    const every = $.clock.every(INTERVAL, () => void poll($));
    if (poller === handle) poller = every;
    else every.cancel();
  });
  const handle = { cancel: () => timer.cancel() };
  poller = handle;
}

// Reads the token file (item 2) and starts polling. Recovery (`/hub`, `Ricarica token`) also resets the
// cursor and the headers; session start (and a hot reload) keeps them, so no notice shows twice.
async function loadToken($: $, first: number, reset: boolean) {
  poller?.cancel();
  poller = null;
  token = null;
  session += 1;
  if (reset) {
    await clearHeaders($);
    await update($, cursorA, () => null);
  }
  const got = await readToken($);
  if (typeof got === "object") {
    token = got.token;
    tokenState = "ok";
    await setStatus($, "");
    startPolling($, first);
  } else {
    tokenState = got;
    await setStatus(
      $,
      got === "none" ? "Hub: nessun token" : "Hub: token non valido",
    );
  }
  $.ui.invalidate("ui.render");
}

function header(event: unknown): HubHeader | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (typeof e.kind !== "string" || !Object.hasOwn(LABELS, e.kind)) return null;
  if (
    typeof e.project !== "string" ||
    !PROJECT.test(e.project) ||
    typeof e.fromName !== "string"
  )
    return null;
  if (!Number.isSafeInteger(e.seq) || !Number.isSafeInteger(e.at)) return null;
  const from = clean(e.fromName).trim();
  if (!from) return null;
  return {
    seq: e.seq as number,
    ...(typeof e.id === "string" && ID.test(e.id) ? { id: e.id } : {}),
    kind: e.kind as HubKind,
    from,
    project: e.project,
    at: e.at as number,
  };
}

async function backOff($: $, startedAt: number, response?: HttpResponse) {
  delay = Math.min(delay * 2, MAX_BACKOFF);
  const retry = response?.headers["retry-after"] ?? "";
  const asked = /^[1-9][0-9]{0,5}$/.test(retry)
    ? Math.min(Number(retry) * 1000, MAX_BACKOFF)
    : 0;
  resumeAt = startedAt + Math.max(delay, asked);
  await setStatus($, "Hub non raggiungibile");
}

async function poll($: $) {
  const startedAt = await $.clock.now();
  if (!token || pollBusy || startedAt < resumeAt) return;
  const gen = session;
  pollBusy = true;
  let cursor;
  let request;
  try {
    cursor = await read($, cursorA);
    // ponytail: HttpInit has no redirect option, so a redirect the host follows by itself is not
    // visible here; our hub sends none, and a 3xx the mod sees is refused (back off).
    request = $.http.fetch(
      `${HUB}/channel/events${cursor === null ? "" : `?after=${cursor}`}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    pollBusy = false;
    return;
  }
  request.then(
    () => {
      pollBusy = false;
    },
    () => {
      pollBusy = false;
    },
  );
  const r = await race(request, $);
  if (gen !== session) return;
  if (typeof r === "string") return backOff($, startedAt);
  if (r.status === 401 || r.status === 403) return revoke($);
  if (r.status !== 200) return backOff($, startedAt, r);
  // ponytail: the host reads the whole body before the mod sees it, so this cap is after download;
  // the server is our own hub, whose fields are size-capped at write.
  let body: { next?: unknown; events?: unknown } | null = null;
  try {
    if (bytes(r.text) <= FEED_BYTES) body = JSON.parse(r.text);
  } catch {
    body = null;
  }
  const next = body?.next;
  if (
    typeof next !== "number" ||
    !Number.isSafeInteger(next) ||
    next < 0 ||
    !Array.isArray(body?.events)
  )
    return backOff($, startedAt);
  delay = INTERVAL;
  resumeAt = 0;
  // A revoke or token change during any await below ends this answer: check before each write.
  if ((await read($, statusA)) !== "" && gen === session)
    await setStatus($, "");
  if (gen !== session) return;
  if (cursor !== null && next < cursor) {
    // Feed reset. ponytail: a restored feed whose seq already passed the old cursor is not detected.
    await clearHeaders($);
    await update($, cursorA, () => next);
    $.ui.invalidate("ui.render");
    return;
  }
  const fresh: HubHeader[] = [];
  if (cursor !== null) {
    let last = cursor;
    for (const event of (body.events as unknown[]).slice(0, 50)) {
      const h = header(event);
      if (!h || h.seq <= last || h.seq > next) continue;
      last = h.seq;
      fresh.push(h);
    }
  }
  // Each updater checks the generation itself: `update` may pause on its read, and a write that
  // started before a revoke must not land after it (the conditional write then retries on the
  // cleared value and keeps it).
  const live = () => gen === session;
  await update($, cursorA, (value) => (live() ? next : value));
  if (fresh.length === 0 || !live()) return;
  await update($, eventsA, (list) =>
    live() ? [...list, ...fresh].slice(-20) : list,
  );
  await update($, unreadA, (n) => (live() ? n + fresh.length : n));
  await update($, hiddenA, (hidden) => (live() ? false : hidden));
  if (!live()) return;
  for (const h of fresh) $.ui.toast(notice(h));
}

function parseItem(text: string, h: HubHeader): Item | null {
  if (bytes(text) > ITEM_BYTES) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  // The item kind is "handoff" or "question"; the feed event's kind only picks the family.
  if (
    !v ||
    typeof v !== "object" ||
    v.id !== h.id ||
    v.kind !== (h.kind === "handoff" ? "handoff" : "question")
  )
    return null;
  const ok = (x: unknown): x is string =>
    typeof x === "string" && x.length <= 20000;
  const okOrNull = (x: unknown): x is string | null => x === null || ok(x);
  let total = 0;
  const take = (x: string) => {
    total += x.length;
    return show(x);
  };
  let data: Item;
  if (v.kind === "handoff") {
    if (
      ![v.fromName, v.project, v.title, v.body].every(ok) ||
      !Number.isSafeInteger(v.at)
    )
      return null;
    data = {
      kind: "handoff",
      fromName: take(v.fromName),
      project: take(v.project),
      at: v.at,
      title: take(v.title),
      body: take(v.body),
    };
  } else {
    const answer = v.answer;
    if (![v.fromName, v.toName, v.project, v.state].every(ok)) return null;
    if (![v.text, v.blocks, v.draft].every(okOrNull)) return null;
    if (
      answer !== null &&
      !(
        answer &&
        typeof answer === "object" &&
        ok(answer.text) &&
        ok(answer.label)
      )
    )
      return null;
    data = {
      kind: "question",
      fromName: take(v.fromName),
      toName: take(v.toName),
      project: take(v.project),
      state: take(v.state),
      text: v.text === null ? null : take(v.text),
      blocks: v.blocks === null ? null : take(v.blocks),
      answer:
        answer === null
          ? null
          : { text: take(answer.text), label: take(answer.label) },
      draft: v.draft === null ? null : take(v.draft),
    };
  }
  return total <= 60000 ? data : null;
}

// The one place that reads a 4xx body: the hub sends text/plain "scope" or "grant".
function refusal(text: string) {
  return text.trim();
}

async function open($: $, h: HubHeader) {
  dropItem();
  const sel = selection;
  const gen = session;
  selected = h.seq;
  if (!h.id || !ID.test(h.id)) {
    itemMessage = "Testo solo su /inbox";
    return $.ui.invalidate("ui.render");
  }
  if (!token) {
    itemMessage = REVOKED;
    return $.ui.invalidate("ui.render");
  }
  if (itemBusy) {
    itemMessage = "Troppe richieste, riprova";
    return $.ui.invalidate("ui.render");
  }
  itemBusy = true;
  itemMessage = "Caricamento…";
  $.ui.invalidate("ui.render");
  const request = $.http.fetch(`${HUB}/channel/item?id=${h.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  request.then(
    () => {
      itemBusy = false;
    },
    () => {
      itemBusy = false;
    },
  );
  const r = await race(request, $);
  if (sel !== selection || gen !== session) return;
  if (typeof r === "string") itemMessage = "Hub non raggiungibile";
  else if (r.status === 200) {
    const data = parseItem(r.text, h);
    const at = await $.clock.now();
    // A close, reselect or revoke during that await must not bring the text back.
    if (sel !== selection || gen !== session) return;
    if (data) {
      item = { data, at };
      itemMessage = "";
      expiry = $.clock.after(ITEM_TTL, () => {
        if (sel === selection) {
          item = null;
          $.ui.invalidate("ui.render");
        }
      });
    } else itemMessage = "Risposta non valida";
  } else if (r.status === 401) return revoke($);
  else if (r.status === 403 && refusal(r.text) === "grant") {
    await revoke($);
    selected = h.seq;
    itemMessage = "Accesso revocato";
    return $.ui.invalidate("ui.render");
  } else if (r.status === 403 && refusal(r.text) === "scope")
    itemMessage = "Testo solo su /inbox";
  else if (r.status === 404) itemMessage = "Messaggio chiuso o non disponibile";
  else if (r.status === 429) itemMessage = "Troppe richieste, riprova";
  else if (r.status >= 500) itemMessage = "Hub non raggiungibile";
  else itemMessage = "Risposta non valida";
  $.ui.invalidate("ui.render");
}

// Token entry (item 6): only when no ui-token exists; it never replaces one. argv only, no shell.
async function saveToken($: $, value: string) {
  const fail = (text: string) => {
    entryMessage = text;
    $.ui.invalidate("ui.render");
  };
  const typed = value.trim();
  if (!TOKEN.test(typed)) return fail("Hub: token non valido");
  const dir = await tokenDir($);
  const uid = (await run($, ["/usr/bin/id", "-u"]))?.stdout.trim();
  if (!dir || !uid || !/^\d+$/.test(uid)) return fail("Hub: token non valido");
  if (
    (await run($, ["/usr/bin/install", "-d", "-m", "700", dir]))?.exitCode !==
      0 ||
    !(await dirOk($, dir, uid))
  )
    return fail("Hub: token non valido");
  const temp = `${dir}/.ui-token.${crypto.randomUUID().replace(/-/g, "")}`;
  let linked = false;
  try {
    // macOS install refuses /dev/stdin (exit 71): create an empty 600 file, write it, chmod again in
    // case the engine wrote through a new file.
    if (
      (await run($, ["/usr/bin/install", "-m", "600", "/dev/null", temp]))
        ?.exitCode !== 0
    )
      return fail("Hub: token non valido");
    try {
      await $.fs.write(temp, typed);
    } catch {
      return fail("Hub: token non valido");
    }
    if ((await run($, ["/bin/chmod", "600", temp]))?.exitCode !== 0)
      return fail("Hub: token non valido");
    // A hard link fails if the file exists, so a token another session wrote first is never replaced.
    linked =
      (await run($, ["/bin/ln", temp, `${dir}/ui-token`]))?.exitCode === 0;
  } finally {
    await run($, ["/bin/rm", "-f", temp]);
  }
  entryMessage = linked ? "" : "Token già presente";
  await loadToken($, 0, true);
}

async function openPane($: $) {
  await update($, unreadA, () => 0);
  await $.ui.open({ id: PANE, title: "Hub nwdesigns", focus: true });
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "hub",
      description: "Apri il pannello dei messaggi dell'hub nwdesigns",
    });
    void loadToken($, Math.floor(Math.random() * 10000), false);
    return next(e);
  });

  on("command.run", { command: "hub" }, async ($) => {
    if (!token) await loadToken($, 0, true);
    await openPane($);
    return { text: "Pannello hub aperto." };
  });

  on("ui.close", ($, e, next) => {
    if (e.id === PANE) {
      dropItem();
      $.ui.invalidate("ui.render");
    }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const unread = await read($, unreadA);
    const newest = (await read($, eventsA)).at(-1);
    if (!unread || !newest || (await read($, hiddenA))) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    return (
      <Box>
        <Text key="hub-band">
          Hub: {unread} {unread === 1 ? "nuovo" : "nuovi"}. {line(newest)}{" "}
        </Text>
        <Button key="hub-read" label="Leggi" onPress={() => openPane($)} />
        <Button
          key="hub-ask"
          label="Chiedi a Claude"
          onPress={async () => {
            await $.prompt.fill({
              text: `${line(newest)}. Usa gli strumenti dell'hub.`,
              mode: "insert",
            });
          }}
        />
        <Button
          key="hub-hide"
          label="Nascondi"
          onPress={() => update($, hiddenA, () => true)}
        />
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e);
    const { Box, Text, Button } = elements;
    const events = await read($, eventsA);
    const status = await read($, statusA);
    if (item && (await $.clock.now()) - item.at >= ITEM_TTL) item = null;
    const data = item?.data;
    return (
      <Box flexDirection="column">
        {status !== "" && (
          <Text key="hub-status" color="warning">
            {status}
          </Text>
        )}
        {tokenState === "none" && "Input" in elements && (
          <elements.Input
            key="hub-token"
            label="Token"
            placeholder="hubch_…"
            onSubmit={(value) => saveToken($, value)}
          />
        )}
        {entryMessage !== "" && <Text key="hub-entry">{entryMessage}</Text>}
        {events.length === 0 && (
          <Text dimColor>Nessun messaggio in questa sessione.</Text>
        )}
        {events
          .slice()
          .reverse()
          .map((event) => (
            <Button
              key={`hub-ev-${event.seq}`}
              label={`${event.seq === selected ? "> " : ""}${line(event)}`}
              onPress={() => open($, event)}
            />
          ))}
        {itemMessage !== "" && <Text key="hub-message">{itemMessage}</Text>}
        {data?.kind === "handoff" && (
          <Box key="hub-item" flexDirection="column">
            <Text bold>{data.title}</Text>
            <Text dimColor>
              Da {data.fromName} ({data.project})
            </Text>
            <Text>{data.body}</Text>
          </Box>
        )}
        {data?.kind === "question" && (
          <Box key="hub-item" flexDirection="column">
            <Text dimColor>
              Da {data.fromName} a {data.toName} ({data.project}), {data.state}
            </Text>
            {data.text === null ? (
              <Text dimColor>Contenuto rimosso</Text>
            ) : (
              <Text>{data.text}</Text>
            )}
            {data.text !== null && data.blocks !== null && (
              <Text>In attesa: {data.blocks}</Text>
            )}
            {data.answer && (
              <Text>
                {data.answer.label}: {data.answer.text}
              </Text>
            )}
            {data.draft !== null && <Text dimColor>Bozza: {data.draft}</Text>}
          </Box>
        )}
        <Button
          key="hub-reload"
          label="Ricarica token"
          onPress={() => loadToken($, 0, true)}
        />
        <Text key="hub-inbox" dimColor>
          {INBOX}
        </Text>
      </Box>
    );
  });
};
