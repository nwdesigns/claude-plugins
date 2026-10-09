// Run: claude plugin test plugins/context-hub
// A fake hub through an `http.fetch` hook, a fake token file through `fs.*` and `process.run`, a mock clock.
import { expect, mock, test } from "claude-code/testing";
import type { Engine, MockClock } from "claude-code/testing";
import type { HttpResponse, On, Register } from "claude-code";
import type { HubHeader } from "../types";

const TOKEN = `hubch_${"a".repeat(43)}`;
const HOME = "/home/u";
const DIR = `${HOME}/.config/context-hub`;
const FILE = `${DIR}/ui-token`;
const ID = "abcdefghij0123456789";
const SURFACES = ["terminal", "desktop"] as const;
const PANE = {
  plugin: "context-hub",
  component: "Pane",
  requestId: "hub",
  props: {
    title: "hub",
    isFocused: true,
    bodyColumns: 80,
    placement: "inline",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;
const BAND = {
  plugin: "context-hub",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const;
const BODY = "Corpo segreto del messaggio";
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);

type Node = {
  kind: "file" | "dir";
  mode: string;
  text?: string;
  mtimeMs?: number;
  isLink?: boolean;
  realPath?: string;
  touchOnRead?: boolean;
};
type Reply = HttpResponse | "network";

const reply = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers,
  text: typeof body === "string" ? body : JSON.stringify(body),
});
const feed = (next: number, events: unknown[] = []) =>
  reply(200, { next, events });
const ev = (seq: number, extra: Record<string, unknown> = {}) => ({
  seq,
  id: ID,
  kind: "handoff",
  fromName: "Ana",
  project: "nwdesigns",
  at: 1,
  ...extra,
});
const handoff = (extra: Record<string, unknown> = {}) =>
  reply(200, {
    kind: "handoff",
    id: ID,
    fromName: "Ana",
    project: "nwdesigns",
    at: 1,
    title: "Titolo",
    body: BODY,
    ...extra,
  });

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, { HOME });
  const w = {
    clock,
    fs: new Map<string, Node>([
      [DIR, { kind: "dir", mode: "700" }],
      [FILE, { kind: "file", mode: "600", text: `${TOKEN}\n` }],
    ]),
    fetches: [] as string[],
    toasts: [] as string[],
    status: [] as (string | undefined)[],
    fills: [] as string[],
    argv: [] as string[][],
    writes: [] as string[],
    feed: (_url: string): Reply | Promise<Reply> => feed(0),
    item: (_url: string): Reply | Promise<Reply> => handoff(),
    beforeLn: () => {},
    state: {} as Record<string, unknown>,
    stored: [] as string[],
  };
  on("state.set", ($, e, next) => {
    w.state[e.key] = e.value;
    return next(e);
  });
  on("store.set", ($, e, next) => {
    w.stored.push(JSON.stringify(e));
    return next(e);
  });
  const out = (exitCode: number, stdout = "") => ({
    value: {
      exitCode,
      stdout,
      stderr: "",
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  });
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("ui.toast", ($, e) => {
    w.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.status", ($, e) => {
    w.status.push(e.text);
    return { value: undefined };
  });
  on("ui.open", () => ({ value: { isPlaced: true as const } }));
  on("ui.close", () => ({ value: undefined }));
  on("prompt.fill", ($, e) => {
    w.fills.push(e.text);
    return { isFilled: true };
  });
  on("fs.stat", ($, e) => {
    const n = w.fs.get(e.path);
    if (!n) return { deny: "ENOENT" };
    return {
      value: {
        kind: n.kind,
        size: n.text?.length ?? 64,
        mtimeMs: n.mtimeMs ?? 1,
        isLink: n.isLink ?? false,
        ...(e.resolve ? { realPath: n.realPath ?? e.path } : {}),
      },
    };
  });
  on("fs.read", ($, e) => {
    const n = w.fs.get(e.path);
    if (!n?.text) return { deny: "ENOENT" };
    if (n.touchOnRead) n.mtimeMs = (n.mtimeMs ?? 1) + 1;
    return { value: n.text };
  });
  // An engine that writes through a new file: the mode becomes 644 until the mod runs chmod.
  on("fs.write", ($, e) => {
    if (!w.fs.has(e.path)) return { deny: "ENOENT" };
    w.writes.push(e.path);
    w.fs.set(e.path, { kind: "file", mode: "644", text: e.text });
    return { value: undefined };
  });
  on("process.run", ($, e) => {
    const a = e.argv;
    w.argv.push([...a]);
    if (a[0] === "/usr/bin/id") return out(0, "501\n");
    if (a[0] === "/usr/bin/stat") {
      const n = w.fs.get(a[3] ?? "");
      return a[1] === "-f" && n ? out(0, `${n.mode} 501\n`) : out(1); // BSD stat, as on macOS
    }
    if (a[0] === "/usr/bin/install" && a[1] === "-d") {
      if (!w.fs.has(a[4] ?? ""))
        w.fs.set(a[4] ?? "", { kind: "dir", mode: "700" });
      return out(0);
    }
    // As on macOS: install from /dev/stdin fails with 71; from /dev/null it makes an empty 600 file.
    if (a[0] === "/usr/bin/install" && a.length === 5 && a[3] === "/dev/null") {
      w.fs.set(a[4] ?? "", { kind: "file", mode: a[2] ?? "", text: "" });
      return out(0);
    }
    if (a[0] === "/usr/bin/install") return out(71);
    if (a[0] === "/bin/chmod" && a.length === 3) {
      const n = w.fs.get(a[2] ?? "");
      if (!n) return out(1);
      n.mode = a[1] ?? "";
      return out(0);
    }
    if (a[0] === "/bin/ln") {
      w.beforeLn();
      const n = w.fs.get(a[1] ?? "");
      if (!n || w.fs.has(a[2] ?? "")) return out(1);
      w.fs.set(a[2] ?? "", { ...n });
      return out(0);
    }
    if (a[0] === "/bin/rm") {
      w.fs.delete(a[2] ?? "");
      return out(0);
    }
    return out(127);
  });
  on("http.fetch", async ($, e) => {
    w.fetches.push(e.url);
    expect(e.init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    const r = await (e.url.includes("/channel/item")
      ? w.item(e.url)
      : w.feed(e.url));
    return r === "network" ? { deny: "network" } : { value: r };
  });
  return w;
}

// Session start with a 0-10 s jitter: after 10 s exactly one poll ran.
async function start($: Engine, w: ReturnType<typeof world>) {
  await $.session.start({
    cwd: "/w",
    surface: "terminal",
    isInteractive: true,
  });
  await w.clock.advance(10000);
}
// The plugin's `$.state` as its writes left it (the test's `state.set` hook records each write).
const state = async (w: ReturnType<typeof world>) => ({
  cursor: null,
  events: [] as HubHeader[],
  unread: 0,
  status: "",
  ...w.state,
});
// An inline plugin that closes the pane, standing for the person's close.
const CLOSER = {
  name: "closer",
  register: ((on) => {
    on("session.start", async ($, e, next) => {
      await $.command.register({
        name: "close-hub",
        description: "Close the hub pane",
      });
      return next(e);
    });
    on("command.run", { command: "close-hub" }, async ($) => {
      await $.ui.close({ id: "hub" });
      return { text: "" };
    });
  }) as Register,
};
const run = ($: Engine, command: string) =>
  $.command.run({
    command,
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });
const sleepy = (clock: MockClock, ms: number, r: Reply) => async () => {
  await clock.sleep(ms);
  return r;
};

test("an unsafe or missing token file means no request", async ($, on) => {
  const w = world(on);
  const cases: [string, () => void, string][] = [
    ["missing", () => w.fs.delete(FILE), "Hub: nessun token"],
    [
      "link",
      () =>
        w.fs.set(FILE, {
          kind: "file",
          mode: "600",
          text: TOKEN,
          isLink: true,
        }),
      "Hub: token non valido",
    ],
    [
      "mode 644",
      () => w.fs.set(FILE, { kind: "file", mode: "644", text: TOKEN }),
      "Hub: token non valido",
    ],
    [
      "dir mode 755",
      () => w.fs.set(DIR, { kind: "dir", mode: "755" }),
      "Hub: token non valido",
    ],
    [
      "dir behind a link",
      () => w.fs.set(DIR, { kind: "dir", mode: "700", realPath: "/elsewhere" }),
      "Hub: token non valido",
    ],
    [
      "changed between stats",
      () =>
        w.fs.set(FILE, {
          kind: "file",
          mode: "600",
          text: TOKEN,
          touchOnRead: true,
        }),
      "Hub: token non valido",
    ],
    [
      "malformed",
      () => w.fs.set(FILE, { kind: "file", mode: "600", text: "hubch_short" }),
      "Hub: token non valido",
    ],
  ];
  for (const [name, arrange, message] of cases) {
    w.fs.set(DIR, { kind: "dir", mode: "700" });
    arrange();
    await run($, "hub");
    await w.clock.advance(60000);
    expect(w.fetches, name).toHaveLength(0);
    expect((await state(w)).status, name).toBe(message);
  }
});

test("first poll starts from now; new events toast; a reload keeps the cursor", async ($, on) => {
  const w = world(on);
  w.feed = () => feed(5);
  await start($, w);
  expect(w.fetches).toEqual(["https://hub.nwdesigns.it/channel/events"]);
  w.feed = () => feed(7, [ev(6), ev(7, { kind: "question", fromName: "Bea" })]);
  await w.clock.advance(30000);
  expect(w.fetches[1]).toBe("https://hub.nwdesigns.it/channel/events?after=5");
  expect(w.toasts).toEqual([
    "Nuovo messaggio da Ana (nwdesigns). Testo non incluso: https://hub.nwdesigns.it/inbox",
    "Nuova domanda da Bea (nwdesigns). Testo non incluso: https://hub.nwdesigns.it/inbox",
  ]);
  expect(await state(w)).toMatchObject({ cursor: 7, unread: 2 });
  // Reload: session.start runs again; the cursor stays and only one timer polls.
  await $.session.start({
    cwd: "/w",
    surface: "terminal",
    isInteractive: true,
  });
  w.feed = () => feed(7, [ev(7)]);
  await w.clock.advance(10000);
  expect(w.fetches.slice(2)).toEqual([
    "https://hub.nwdesigns.it/channel/events?after=7",
  ]);
  expect(w.toasts).toHaveLength(2);
  await w.clock.advance(30000);
  expect(w.fetches).toHaveLength(4);
});

test("envelope and event checks", async ($, on) => {
  const w = world(on);
  w.feed = () => feed(5);
  await start($, w);
  w.feed = () => reply(200, { next: "x", events: [] });
  await w.clock.advance(30000);
  expect((await state(w)).cursor).toBe(5);
  w.feed = () => reply(200, "not json");
  await w.clock.advance(60000);
  expect((await state(w)).cursor).toBe(5);
  w.feed = () =>
    feed(10, [
      ev(6, { kind: "bogus" }),
      ev(7, { project: "Bad Project" }),
      ev(8),
      ev(8),
      ev(7),
      ev(9, { fromName: `${RLO}\n` }),
      ev(11),
    ]);
  await w.clock.advance(300000);
  expect(await state(w)).toMatchObject({ cursor: 10, unread: 1 });
  expect((await state(w)).events.map((h) => h.seq)).toEqual([8]);
  // Feed reset: next below the cursor clears the headers.
  w.feed = () => feed(2);
  await w.clock.advance(30000);
  expect(await state(w)).toMatchObject({ cursor: 2, unread: 0, events: [] });
});

test("a hung poll is abandoned at 15 s and no second request starts", async ($, on) => {
  const w = world(on);
  w.feed = sleepy(w.clock, 70000, feed(0));
  await start($, w);
  await w.clock.advance(15000);
  expect((await state(w)).status).toBe("Hub non raggiungibile");
  await w.clock.advance(50000);
  expect(w.fetches).toHaveLength(1);
  w.feed = () => feed(0);
  await w.clock.advance(120000);
  expect(w.fetches.length).toBeGreaterThan(1);
  expect((await state(w)).status).toBe("");
});

test("429 backs off, Retry-After when larger", async ($, on) => {
  const w = world(on);
  w.feed = () => reply(429, "Too many requests", { "retry-after": "120" });
  await start($, w);
  await w.clock.advance(90000);
  expect(w.fetches).toHaveLength(1);
  await w.clock.advance(60000);
  expect(w.fetches).toHaveLength(2);
});

test("401 clears everything and stops polling; Ricarica token resumes", async ($, on) => {
  const w = world(on);
  w.feed = () => feed(1);
  await start($, w);
  w.feed = () => feed(2, [ev(2)]);
  await w.clock.advance(30000);
  w.feed = () => reply(401, "Unauthorized");
  await w.clock.advance(30000);
  expect(await state(w)).toMatchObject({
    events: [],
    unread: 0,
    status: "Hub: token revocato — /hub per ricaricare",
  });
  await w.clock.advance(120000);
  expect(w.fetches).toHaveLength(3);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    w.feed = () => feed(4);
    await ui.press({ key: "hub-reload" });
    await w.clock.advance(1);
    expect(w.fetches.at(-1)).toBe("https://hub.nwdesigns.it/channel/events");
    expect((await state(w)).cursor).toBe(4);
    w.feed = () => reply(401, "Unauthorized");
    await w.clock.advance(30000);
    await ui.unmount();
  }
});

test(
  "pane: item text, clears, expiry, and every message",
  { plugins: [CLOSER] },
  async ($, on) => {
    const w = world(on);
    w.feed = () => feed(1);
    await start($, w);
    w.feed = () =>
      feed(3, [ev(2), ev(3, { id: undefined, fromName: `Ca${ZWSP}ra` })]);
    await w.clock.advance(30000);
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface });
      const text = async () =>
        (await ui.findAll({})).map((e) => e.text).join("\n");
      // Text, with control and format characters removed from every field.
      w.item = () =>
        handoff({
          title: `Ti\u001b[31mtolo${RLO}\u2028\u2029\ud800`,
          body: `${BODY}\u0007\n riga`,
        });
      await ui.press({ key: "hub-ev-2" });
      expect(await text()).toContain(`${BODY}\n riga`);
      expect(await text()).toContain("Ti[31mtolo");
      expect(await text()).not.toMatch(
        /[\u0007\u001b\u200b\u202e\u2028\u2029\ud800]/,
      );
      // Close drops it; a new selection drops it; 10 minutes drop it.
      await run($, "close-hub");
      expect(await text()).not.toContain(BODY);
      await ui.press({ key: "hub-ev-2" });
      await ui.press({ key: "hub-ev-3" });
      expect(await text()).toContain("Testo solo su /inbox");
      expect(await text()).not.toContain(BODY);
      await ui.press({ key: "hub-ev-2" });
      await w.clock.advance(10 * 60 * 1000);
      expect(await text()).not.toContain(BODY);
      // Each answer has its message; a non-200 answer leaves no item.
      const cases: [Reply, string][] = [
        [reply(403, "scope"), "Testo solo su /inbox"],
        [reply(404, "Not found"), "Messaggio chiuso o non disponibile"],
        [reply(429, "Too many requests"), "Troppe richieste, riprova"],
        ["network", "Hub non raggiungibile"],
        [reply(200, "x".repeat(300 * 1024)), "Risposta non valida"],
        [handoff({ id: "zzzzzzzzzzzzzzzzzzzz" }), "Risposta non valida"],
        [handoff({ kind: "question" }), "Risposta non valida"],
        [handoff({ body: "b".repeat(20001) }), "Risposta non valida"],
        [reply(302, ""), "Risposta non valida"],
      ];
      for (const [r, message] of cases) {
        w.item = () => r;
        await ui.press({ key: "hub-ev-2" });
        expect(await text(), message).toContain(message);
        expect(await text()).not.toContain(BODY);
      }
      await ui.unmount();
    }
  },
);

test("a question draws text, blocks, answer and draft; a hung item is abandoned", async ($, on) => {
  const w = world(on);
  w.feed = () => feed(1);
  await start($, w);
  w.feed = () => feed(2, [ev(2, { kind: "answer" })]);
  await w.clock.advance(30000);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const text = async () =>
      (await ui.findAll({})).map((e) => e.text).join("\n");
    w.item = () =>
      reply(200, {
        kind: "question",
        id: ID,
        fromName: "Ana",
        toName: "Lu",
        project: "nwdesigns",
        state: "answered",
        text: "Domanda?",
        blocks: "Blocco",
        answer: { text: "Sì", label: "Confermata" },
        draft: null,
      });
    await ui.press({ key: "hub-ev-2" });
    for (const part of ["Domanda?", "In attesa: Blocco", "Confermata: Sì"])
      expect(await text()).toContain(part);
    w.item = sleepy(w.clock, 40000, handoff());
    void ui.press({ key: "hub-ev-2" });
    await w.clock.advance(15000);
    expect(await text()).toContain("Hub non raggiungibile");
    await w.clock.advance(30000);
    expect(await text()).not.toContain(BODY);
    await ui.unmount();
  }
});

test("item 403 grant and a late 200 after a poll 401", async ($, on) => {
  const w = world(on);
  for (const surface of SURFACES) {
    w.feed = () => feed(1);
    await run($, "hub");
    await w.clock.advance(1);
    w.feed = () => feed(2, [ev(2)]);
    await w.clock.advance(30000);
    const ui = await $.ui.mount({ ...PANE, surface });
    const text = async () =>
      (await ui.findAll({})).map((e) => e.text).join("\n");
    w.item = () => reply(403, "grant");
    await ui.press({ key: "hub-ev-2" });
    expect(await text()).toContain("Accesso revocato");
    expect(await state(w)).toMatchObject({
      events: [],
      status: "Hub: token revocato — /hub per ricaricare",
    });
    // Back on; the item hangs, the poll answers 401, then the item's 200 arrives late and is dropped.
    w.feed = () => feed(1);
    await ui.press({ key: "hub-reload" });
    await w.clock.advance(1);
    w.feed = () => feed(2, [ev(2)]);
    await w.clock.advance(30000);
    // The next poll is 5 s away; the item answers at 10 s, inside the 15 s UI wait.
    await w.clock.advance(25000);
    w.item = sleepy(w.clock, 10000, handoff());
    const items = w.fetches.filter((u) => u.includes("/channel/item")).length;
    const pending = ui.press({ key: "hub-ev-2" });
    w.feed = () => reply(401, "Unauthorized");
    await w.clock.advance(30000);
    await pending;
    expect(w.fetches.filter((u) => u.includes("/channel/item"))).toHaveLength(
      items + 1,
    );
    expect(await text()).not.toContain(BODY);
    await ui.unmount();
  }
});

test("band: Chiedi a Claude fills the header only; text and token never in state, store or session", async ($, on) => {
  const w = world(on);

  const session = mock.session(on);
  w.feed = () => feed(1);
  await start($, w);
  for (const surface of SURFACES) {
    // Opening the pane sets unread to 0 and the band goes; each surface gets a new event.
    w.feed = () => feed(2, [ev(2, { fromName: `An\na${RLO}` })]);
    if (surface === "desktop")
      w.feed = () => feed(3, [ev(3, { fromName: `An\na${RLO}` })]);
    await w.clock.advance(30000);
    const band = await $.ui.mount({ ...BAND, surface });
    await band.press({ key: "hub-ask" });
    expect(w.fills.at(-1)).toBe(
      "Nuovo messaggio da Ana (nwdesigns). Usa gli strumenti dell'hub.",
    );
    await band.press({ key: "hub-read" });
    const pane = await $.ui.mount({ ...PANE, surface });
    await pane.press({ key: "hub-ev-2" });
    expect((await pane.findAll({})).map((e) => e.text).join("\n")).toContain(
      BODY,
    );
    await pane.unmount();
    await band.unmount();
  }
  const seen = JSON.stringify([
    await state(w),
    w.fills,
    w.toasts,
    w.status,
    session.appended(),
    w.stored,
  ]);
  expect(seen).not.toContain(BODY);
  expect(seen).not.toContain(TOKEN);
});

test("token entry: exclusive creation, never replaces a file", async ($, on) => {
  const w = world(on);
  w.fs.delete(FILE);
  w.fs.delete(DIR);
  await start($, w);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    if (w.fs.has(FILE)) {
      // Second surface: a token exists, so there is no entry field.
      expect(await ui.find({ key: "hub-token" })).toBeUndefined();
      await ui.unmount();
      continue;
    }
    await ui.input({ key: "hub-token", text: "not a token" });
    expect(w.fs.has(FILE)).toBe(false);
    await ui.input({ key: "hub-token", text: TOKEN });
    expect(
      w.argv
        .filter((a) => a[0] !== "/usr/bin/stat" && a[0] !== "/usr/bin/id")
        .map((a) => a.join(" ").replace(/\.ui-token\.\w+/, ".ui-token.X")),
    ).toEqual([
      `/usr/bin/install -d -m 700 ${DIR}`,
      `/usr/bin/install -m 600 /dev/null ${DIR}/.ui-token.X`,
      `/bin/chmod 600 ${DIR}/.ui-token.X`,
      `/bin/ln ${DIR}/.ui-token.X ${FILE}`,
      `/bin/rm -f ${DIR}/.ui-token.X`,
    ]);
    expect(
      w.writes.map((p) => p.replace(/\.ui-token\.\w+/, ".ui-token.X")),
    ).toEqual([`${DIR}/.ui-token.X`]);
    expect(w.fs.get(FILE)).toMatchObject({ mode: "600", text: TOKEN });
    expect([...w.fs.keys()].filter((p) => p.includes(".ui-token."))).toEqual(
      [],
    );
    await w.clock.advance(1);
    expect(w.fetches).toHaveLength(1);
    await ui.unmount();
  }
});

test("token entry: ln fails when another session wrote the file first", async ($, on) => {
  const w = world(on);
  w.fs.delete(FILE);
  await start($, w);
  // Another session links its file between our check and our ln.
  w.beforeLn = () => w.fs.set(FILE, { kind: "file", mode: "600", text: TOKEN });
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.input({ key: "hub-token", text: TOKEN });
  expect((await ui.findAll({})).map((e) => e.text).join("\n")).toContain(
    "Token già presente",
  );
  expect([...w.fs.keys()].filter((p) => p.includes(".ui-token."))).toEqual([]);
  await w.clock.advance(1);
  expect(w.fetches).toHaveLength(1);
  await ui.unmount();
});

test("hub contract: a question exactly as GET /channel/item sends it, and a removed text", async ($, on) => {
  const w = world(on);
  w.feed = () => feed(1);
  await start($, w);
  w.feed = () => feed(2, [ev(2, { kind: "confirmation" })]);
  await w.clock.advance(30000);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const text = async () =>
      (await ui.findAll({})).map((e) => e.text).join("\n");
    // The body spike/src/channel.test.ts expects for a question where I am `to`, keys in its order.
    w.item = () =>
      reply(200, {
        kind: "question",
        id: ID,
        fromName: "Alice <b>",
        toName: "Bob",
        project: "alpha",
        state: "awaiting_confirmation",
        text: "Q1?",
        blocks: "W1",
        answer: null,
        draft: "Draft 1",
      });
    await ui.press({ key: "hub-ev-2" });
    for (const part of [
      "Da Alice <b> a Bob (alpha), awaiting_confirmation",
      "Q1?",
      "In attesa: W1",
      "Bozza: Draft 1",
    ])
      expect(await text()).toContain(part);
    // After the retention period the hub sends text and blocks as null.
    w.item = () =>
      reply(200, {
        kind: "question",
        id: ID,
        fromName: "Alice <b>",
        toName: "Bob",
        project: "alpha",
        state: "expired",
        text: null,
        blocks: null,
        answer: null,
        draft: null,
      });
    await ui.press({ key: "hub-ev-2" });
    expect(await text()).toContain("Contenuto rimosso");
    // A question item must say "question", whatever the feed event kind.
    w.item = () =>
      reply(200, {
        kind: "confirmation",
        id: ID,
        fromName: "A",
        toName: "B",
        project: "alpha",
        state: "s",
        text: "Q1?",
        blocks: null,
        answer: null,
        draft: null,
      });
    await ui.press({ key: "hub-ev-2" });
    expect(await text()).toContain("Risposta non valida");
    await ui.unmount();
  }
});

// An inline plugin that holds for 20 s of mock time: after /hold-now the next `$.clock.now()`,
// after /hold-status or /hold-events the next read of that context-hub state value.
const HOLDER = {
  name: "holder",
  register: ((on) => {
    let armed = "";
    on("session.start", async ($, e, next) => {
      for (const name of ["hold-now", "hold-status", "hold-events"])
        await $.command.register({ name, description: "Hold the next read" });
      return next(e);
    });
    on("command.run", async ($, e, next) => {
      if (!e.command.startsWith("hold-")) return next(e);
      armed = e.command.slice(5);
      return { text: "" };
    });
    on("clock.now", async ($, e, next) => {
      if (armed === "now") {
        armed = "";
        await $.clock.sleep(20000);
      }
      return next(e);
    });
    on("state.get", async ($, e, next) => {
      if (armed !== "" && e.plugin === "context-hub" && e.key === armed) {
        armed = "";
        await $.clock.sleep(20000);
      }
      return next(e);
    });
  }) as Register,
};

// Each surface starts with `Ricarica token`: it polls at once and then every 30 s, so ticks are known.
async function restart(ui: { press: (t: { key: string }) => Promise<unknown> }, w: ReturnType<typeof world>) {
  w.feed = () => feed(1);
  await ui.press({ key: "hub-reload" });
  await w.clock.advance(1);
  w.feed = () => feed(2, [ev(2)]);
  await w.clock.advance(30000);
  await w.clock.advance(25000); // the next poll is 5 s away
}

test("a revoke during a poll's later awaits writes no header and no toast", { plugins: [HOLDER] }, async ($, on) => {
  const w = world(on);
  await start($, w);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await restart(ui, w);
    // The item answers 401 in 10 s, while the poll that answers in 5 s waits 20 s on its status read.
    w.item = sleepy(w.clock, 10000, reply(401, "Unauthorized"));
    const pending = ui.press({ key: "hub-ev-2" });
    await w.clock.settle();
    await ui.unmount(); // no pane render reads the status meanwhile
    await run($, "hold-status");
    const toasts = w.toasts.length;
    w.feed = () => feed(3, [ev(3)]);
    await w.clock.advance(30000);
    await pending;
    expect((await state(w)).status).toBe("Hub: token revocato — /hub per ricaricare");
    expect(w.toasts).toHaveLength(toasts);
    expect((await state(w)).events).toEqual([]);
  }
});

test("a revoke while the poll's header write waits on its read restores nothing", { plugins: [HOLDER] }, async ($, on) => {
  const w = world(on);
  await start($, w);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await restart(ui, w);
    // The poll in 5 s pauses 20 s inside its events update; the item's 401 at 10 s clears everything.
    w.item = sleepy(w.clock, 10000, reply(401, "Unauthorized"));
    const pending = ui.press({ key: "hub-ev-2" });
    await w.clock.settle();
    await ui.unmount(); // no pane render reads the events meanwhile
    await run($, "hold-events");
    const toasts = w.toasts.length;
    w.feed = () => feed(3, [ev(3)]);
    await w.clock.advance(30000);
    await pending;
    expect(await state(w)).toMatchObject({ events: [], unread: 0, status: "Hub: token revocato — /hub per ricaricare" });
    expect(w.toasts).toHaveLength(toasts);
  }
});

test("a close or a revoke while the item's timestamp is read keeps the text away", { plugins: [CLOSER, HOLDER] }, async ($, on) => {
  const w = world(on);
  await start($, w);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const text = async () => (await ui.findAll({})).map((e) => e.text).join("\n");
    await restart(ui, w);
    // Close (selection) during the held clock read.
    await run($, "hold-now");
    const closed = ui.press({ key: "hub-ev-2" });
    await w.clock.settle();
    await run($, "close-hub");
    await w.clock.advance(20000);
    await closed;
    expect(await text()).not.toContain(BODY);
    // Revoke (session): the poll 15 s away answers 401 while the clock read is held.
    await run($, "hold-now");
    const revoked = ui.press({ key: "hub-ev-2" });
    await w.clock.settle();
    w.feed = () => reply(401, "Unauthorized");
    await w.clock.advance(20000);
    await revoked;
    expect(await text()).not.toContain(BODY);
    expect((await state(w)).status).toBe("Hub: token revocato — /hub per ricaricare");
    await ui.unmount();
  }
});
