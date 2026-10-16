const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { webcrypto, createHash } = require("node:crypto");
const { test } = require("node:test");
const vm = require("node:vm");

const html = readFileSync(require("node:path").join(__dirname, "../replay-dock.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.classList = { toggle() {} };
    this.value = "";
    this.textContent = "";
    this.hidden = false;
  }
  replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ""; }
  append(...children) { this.children.push(...children); }
  add(child) { this.children.push(child); }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  pause() {}
  load() {}
  click() { this.clicked = true; }
  checkValidity() { return Number(this.value) >= 1 && Number(this.value) <= 100; }
}

function app({ scenes = [], inputs = [], storage = new Map(), password = "" } = {}) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get("settings").open = true;
  elements.get("limit").value = "20";
  elements.get("new-source-kind").value = "ffmpeg_source";
  let timerId = 0;
  const timers = new Map();
  const state = { connections: 0, offline: false, scenes, inputs, active: false, requests: [], socket: null, password, lastReplay: "", failCreateInput: false, inputKinds: ["ffmpeg_source", "vlc_source"] };
  const hash = value => createHash("sha256").update(value).digest("base64");
  class MockWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      state.socket = this;
      state.connections++;
      queueMicrotask(() => {
        if (state.silent) return;
        if (state.offline) this.close(1006);
        else this.emit(0, { rpcVersion: 1, ...(password ? { authentication: { salt: "salt", challenge: "challenge" } } : {}) });
      });
    }
    emit(op, d) { return this.onmessage?.({ data: JSON.stringify({ op, d }) }); }
    send(raw) {
      const { op, d } = JSON.parse(raw);
      if (op === 1) {
        state.identify = d;
        if (password && d.authentication !== hash(hash(password + "salt") + "challenge")) {
          this.close(4009);
          return;
        }
        queueMicrotask(() => this.emit(2, { negotiatedRpcVersion: 1 }));
        return;
      }
      state.requests.push(d);
      let responseData = {};
      let result = true;
      let comment = "";
      const data = d.requestData;
      switch (d.requestType) {
        case "GetSceneList": responseData = { scenes: state.scenes }; break;
        case "GetSceneItemList": responseData = { sceneItems: state.inputs.filter(input => input.sceneName === data.sceneName).map(input => ({ sourceName: input.inputName, inputKind: input.inputKind })) }; break;
        case "GetInputList": responseData = { inputs: state.inputs }; break;
        case "GetInputKindList": responseData = { inputKinds: state.inputKinds }; break;
        case "GetSourceActive": responseData = { videoActive: state.active }; break;
        case "GetReplayBufferStatus": responseData = { outputActive: true }; break;
        case "GetLastReplayBufferReplay": responseData = { savedReplayPath: state.lastReplay }; break;
        case "CreateScene": state.scenes.push({ sceneName: data.sceneName }); break;
        case "CreateInput":
          if (state.failCreateInput) { result = false; comment = "Input unavailable"; }
          else state.inputs.push(data);
          break;
        case "Fail": result = false; comment = "Test rejection"; break;
        case "Hang": return;
      }
      queueMicrotask(() => this.emit(7, { requestId: d.requestId, requestType: d.requestType, requestStatus: { result, comment }, responseData }));
    }
    close(code = 1000) {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code }));
    }
  }
  class PreviewURL extends URL {
    static createObjectURL() { return "blob:test-preview"; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    document: { documentElement: { dataset: { connection: "idle" } }, getElementById: id => elements.get(id), createElement: tag => new Element(tag), querySelectorAll: () => [] },
    window: { addEventListener: (name, callback) => { state[name] = callback; } },
    Option: function(text, value) { return { text, value }; },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    WebSocket: MockWebSocket, URL: PreviewURL, crypto: webcrypto, TextEncoder,
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(script, context);
  const evaluate = code => vm.runInContext(code, context);
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (!evaluate("busy")) return;
    }
    throw new Error("App did not settle");
  };
  const submit = async id => {
    await settle();
    elements.get(id).onsubmit({ preventDefault() {} });
    await settle();
  };
  const connect = async () => { elements.get("password").value = password; await submit("connection-form"); };
  const retry = async expectedDelay => {
    const timer = [...timers.entries()].find(([, timer]) => timer.delay === expectedDelay);
    assert.ok(timer, `Expected a retry after ${expectedDelay}ms`);
    timers.delete(timer[0]);
    timer[1].callback();
    await settle();
  };
  return { state, elements, storage, evaluate, settle, submit, connect, timers, retry };
}

test("restores the settings panel open or minimized state after a reload", () => {
  const storage = new Map();
  let desk = app({ storage });
  assert.equal(desk.elements.get("settings").open, true);
  for (const open of [false, true]) {
    desk.elements.get("settings").open = open;
    desk.elements.get("settings").ontoggle?.();
    desk = app({ storage });
    assert.equal(desk.elements.get("settings").open, open);
  }
});

test("authenticates and restores the saved scene and password from local storage", async () => {
  const storage = new Map([["reactive-replay-desk-v1", JSON.stringify({ address: "ws://127.0.0.1:4455/", scene: "Highlights", source: "Highlight Video" })]]);
  const desk = app({ storage, password: "secret-password", scenes: [{ sceneName: "Replays" }, { sceneName: "Highlights" }], inputs: [{ sceneName: "Highlights", inputName: "Highlight Video", inputKind: "ffmpeg_source" }] });
  await desk.connect();
  assert.equal(desk.evaluate("obs.ready"), true);
  assert.equal(desk.elements.get("scene").value, "Highlights");
  assert.equal(desk.elements.get("source").value, "Highlight Video");
  assert.equal(desk.elements.get("create-form").hidden, true);
  assert.equal(desk.elements.get("password").value, "secret-password");
  assert.equal(JSON.parse(storage.get("reactive-replay-desk-v1")).password, "secret-password");
  const restored = app({ storage, password: "secret-password", scenes: [{ sceneName: "Highlights" }] });
  assert.equal(restored.elements.get("password").value, "secret-password");
  await restored.submit("connection-form");
  assert.equal(restored.evaluate("obs.ready"), true);
  assert.equal(restored.elements.get("scene").value, "Highlights");
  desk.evaluate("obs.disconnect()");
  restored.evaluate("obs.disconnect()");
  restored.elements.get("password").value = "";
  restored.elements.get("password").onchange();
  assert.equal(JSON.parse(storage.get("reactive-replay-desk-v1")).password, "");
});

test("offers a named scene only when none matches and creates its media source", async () => {
  const desk = app({ scenes: [{ sceneName: "Camera" }] });
  await desk.connect();
  assert.equal(desk.elements.get("create-form").hidden, false);
  assert.match(desk.elements.get("scene-help").textContent, /No matching/);
  desk.elements.get("new-scene").value = "Match highlights";
  await desk.submit("create-form");
  assert.equal(desk.elements.get("scene").value, "Match highlights");
  assert.equal(desk.elements.get("source").value, "Match highlights Video");
  assert.equal(desk.elements.get("create-form").hidden, true);
  assert.equal(desk.state.requests.filter(request => request.requestType === "CreateScene").length, 1);
  assert.equal(desk.state.requests.some(request => request.requestType === "SetCurrentProgramScene"), false);
  assert.equal(JSON.parse(desk.storage.get("reactive-replay-desk-v1")).scene, "Match highlights");
  desk.evaluate("obs.disconnect()");
});

test("finds an existing replay scene and can add a missing source", async () => {
  const desk = app({ scenes: [{ sceneName: "Camera" }, { sceneName: "Instant Replay" }] });
  await desk.connect();
  assert.equal(desk.elements.get("scene").value, "Instant Replay");
  assert.equal(desk.elements.get("add-source").hidden, false);
  await desk.elements.get("add-source").onclick();
  assert.equal(desk.elements.get("source").value, "Instant Replay Video");
  assert.equal(desk.state.requests.some(request => request.requestType === "CreateScene"), false);
  desk.evaluate("obs.disconnect()");
});

test("does not duplicate a scene created elsewhere before the form is submitted", async () => {
  const desk = app();
  await desk.connect();
  desk.state.scenes.push({ sceneName: "Highlights" });
  desk.elements.get("new-scene").value = "Highlights";
  await desk.submit("create-form");
  assert.equal(desk.elements.get("scene").value, "Highlights");
  assert.equal(desk.state.requests.some(request => request.requestType === "CreateScene"), false);
  desk.evaluate("obs.disconnect()");
});

test("collects replay events, deduplicates, hides older history, and queues without switching scenes", async () => {
  const desk = app({ scenes: [{ sceneName: "Replays" }], inputs: [{ sceneName: "Replays", inputName: "Replay Video", inputKind: "ffmpeg_source" }] });
  await desk.connect();
  desk.elements.get("limit").value = "2";
  for (const path of ["/Clips/one.mp4", "/Clips/two.mp4", "/Clips/two.mp4", "/Clips/three.mp4"]) {
    await desk.state.socket.emit(5, { eventType: "ReplayBufferSaved", eventData: { savedReplayPath: path } });
  }
  assert.equal(desk.evaluate("replays.length"), 3);
  assert.equal(desk.evaluate("visibleReplays().length"), 2);
  assert.equal(desk.evaluate("replays[0].path"), "/Clips/three.mp4");
  await desk.evaluate("queueReplay(replays[0])");
  const update = desk.state.requests.find(request => request.requestType === "SetInputSettings");
  assert.equal(update.requestData.inputSettings.local_file, "/Clips/three.mp4");
  assert.equal(update.requestData.overlay, true);
  assert.equal(desk.state.requests.some(request => request.requestType === "SetCurrentProgramScene"), false);
  desk.state.active = true;
  await assert.rejects(desk.evaluate("queueReplay(replays[0])"), /active in OBS/);
  assert.equal(desk.state.requests.filter(request => request.requestType === "SetInputSettings").length, 1);
  desk.evaluate("obs.disconnect()");
});

test("instant replay is opt-in and persists without queuing existing history", async () => {
  const desk = app({ scenes: [{ sceneName: "Replays" }], inputs: [{ sceneName: "Replays", inputName: "Replay Video", inputKind: "ffmpeg_source" }] });
  await desk.connect();
  assert.equal(desk.elements.get("instant-replay").checked, false);
  await desk.state.socket.emit(5, { eventType: "ReplayBufferSaved", eventData: { savedReplayPath: "/Clips/manual.mp4" } });
  desk.elements.get("instant-replay").checked = true;
  desk.elements.get("instant-replay").onchange();
  await desk.settle();
  assert.equal(desk.state.requests.some(request => request.requestType === "SetInputSettings"), false);
  const restored = app({ storage: desk.storage });
  assert.equal(restored.elements.get("instant-replay").checked, true);
  desk.elements.get("instant-replay").checked = false;
  desk.elements.get("instant-replay").onchange();
  assert.equal(JSON.parse(desk.storage.get("reactive-replay-desk-v1")).instantReplay, false);
});

test("instant replay queues new saves for Media and VLC sources and ignores duplicate events", async () => {
  for (const kind of ["ffmpeg_source", "vlc_source"]) {
    const desk = app({ scenes: [{ sceneName: "Replays" }], inputs: [{ sceneName: "Replays", inputName: "Replay Video", inputKind: kind }] });
    await desk.connect();
    desk.elements.get("instant-replay").checked = true;
    desk.elements.get("instant-replay").onchange();
    for (const path of ["/Clips/one.mp4", "/Clips/two.mp4", "/Clips/two.mp4"]) {
      await desk.state.socket.emit(5, { eventType: "ReplayBufferSaved", eventData: { savedReplayPath: path } });
      await desk.settle();
    }
    const updates = desk.state.requests.filter(request => request.requestType === "SetInputSettings");
    assert.equal(updates.length, 2);
    assert.equal(updates[1].requestData.inputName, "Replay Video");
    if (kind === "vlc_source") assert.deepEqual(updates[1].requestData.inputSettings.playlist, [{ value: "/Clips/two.mp4" }]);
    else assert.equal(updates[1].requestData.inputSettings.local_file, "/Clips/two.mp4");
    assert.equal(desk.elements.get("queued").textContent, "two.mp4");
    assert.equal(desk.state.requests.some(request => request.requestType === "SetCurrentProgramScene"), false);
  }
});

test("instant replay reports active or missing targets and retains the saved clip", async () => {
  for (const active of [false, true]) {
    const desk = app({ scenes: [{ sceneName: "Replays" }], inputs: active ? [{ sceneName: "Replays", inputName: "Replay Video", inputKind: "ffmpeg_source" }] : [] });
    await desk.connect();
    desk.state.active = active;
    desk.elements.get("instant-replay").checked = true;
    await desk.state.socket.emit(5, { eventType: "ReplayBufferSaved", eventData: { savedReplayPath: "/Clips/one.mp4" } });
    await desk.settle();
    assert.equal(desk.evaluate("replays.length"), 1);
    assert.equal(desk.state.requests.some(request => request.requestType === "SetInputSettings"), false);
    assert.match(desk.elements.get("message").textContent, active ? /active in OBS/ : /Choose a replay scene/);
  }
});

test("instant replay queues only the latest save received during another action", async () => {
  const desk = app({ scenes: [{ sceneName: "Replays" }], inputs: [{ sceneName: "Replays", inputName: "Replay Video", inputKind: "ffmpeg_source" }] });
  await desk.connect();
  desk.elements.get("instant-replay").checked = true;
  desk.evaluate('run(() => new Promise(resolve => { globalThis.finishAction = resolve; }))');
  for (const path of ["/Clips/one.mp4", "/Clips/two.mp4"]) {
    await desk.state.socket.emit(5, { eventType: "ReplayBufferSaved", eventData: { savedReplayPath: path } });
  }
  assert.equal(desk.state.requests.some(request => request.requestType === "SetInputSettings"), false);
  desk.evaluate("finishAction()");
  await desk.settle();
  const updates = desk.state.requests.filter(request => request.requestType === "SetInputSettings");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].requestData.inputSettings.local_file, "/Clips/two.mp4");
});

test("disabling instant replay cancels a pending save", async () => {
  const desk = app({ scenes: [{ sceneName: "Replays" }], inputs: [{ sceneName: "Replays", inputName: "Replay Video", inputKind: "ffmpeg_source" }] });
  await desk.connect();
  desk.elements.get("instant-replay").checked = true;
  desk.evaluate('run(() => new Promise(resolve => { globalThis.finishAction = resolve; }))');
  await desk.state.socket.emit(5, { eventType: "ReplayBufferSaved", eventData: { savedReplayPath: "/Clips/one.mp4" } });
  desk.elements.get("instant-replay").checked = false;
  desk.elements.get("instant-replay").onchange();
  desk.evaluate("finishAction()");
  await desk.settle();
  assert.equal(desk.state.requests.some(request => request.requestType === "SetInputSettings"), false);
});

test("instant replay does not queue the last clip retrieved on connection", async () => {
  const desk = app({ scenes: [{ sceneName: "Replays" }], inputs: [{ sceneName: "Replays", inputName: "Replay Video", inputKind: "ffmpeg_source" }] });
  desk.elements.get("instant-replay").checked = true;
  desk.state.lastReplay = "/Clips/old.mp4";
  await desk.connect();
  assert.equal(desk.evaluate("replays.length"), 1);
  assert.equal(desk.state.requests.some(request => request.requestType === "SetInputSettings"), false);
});

test("restores a VLC source alongside Media Sources and queues a single-clip playlist", async () => {
  const storage = new Map([["reactive-replay-desk-v1", JSON.stringify({ address: "ws://127.0.0.1:4455/", scene: "Replays", source: "VLC Replays" })]]);
  const desk = app({ storage, scenes: [{ sceneName: "Replays" }], inputs: [
    { sceneName: "Replays", inputName: "Replay Video", inputKind: "ffmpeg_source" },
    { sceneName: "Replays", inputName: "VLC Replays", inputKind: "vlc_source" },
    { sceneName: "Replays", inputName: "Camera", inputKind: "av_capture_input" }
  ] });
  await desk.connect();
  assert.equal(desk.elements.get("source").value, "VLC Replays");
  assert.equal(desk.elements.get("source").children.length, 3);
  assert.equal(desk.elements.get("add-source").hidden, true);
  desk.evaluate('addReplay("/Clips/vlc.mp4")');
  await desk.evaluate("queueReplay(replays[0])");
  const update = desk.state.requests.find(request => request.requestType === "SetInputSettings");
  assert.deepEqual(update.requestData.inputSettings, {
    playlist: [{ value: "/Clips/vlc.mp4" }], loop: false, shuffle: false, playback_behavior: "stop_restart"
  });
  assert.equal(update.requestData.overlay, true);
  assert.equal(update.requestData.inputName, "VLC Replays");
  desk.state.active = true;
  await assert.rejects(desk.evaluate("queueReplay(replays[0])"), /active in OBS/);
  assert.equal(desk.state.requests.filter(request => request.requestType === "SetInputSettings").length, 1);
  desk.evaluate("obs.disconnect()");
});

test("automatically selects a scene's only VLC source without offering another source", async () => {
  const desk = app({ scenes: [{ sceneName: "Replays" }], inputs: [{ sceneName: "Replays", inputName: "VLC Replays", inputKind: "vlc_source" }] });
  await desk.connect();
  assert.equal(desk.elements.get("source").value, "VLC Replays");
  assert.equal(desk.elements.get("add-source").hidden, true);
  desk.evaluate("obs.disconnect()");
});

test("creates a VLC source for a new scene or an existing scene", async () => {
  for (const existing of [false, true]) {
    const desk = app({ scenes: existing ? [{ sceneName: "Replays" }] : [] });
    await desk.connect();
    desk.elements.get("new-source-kind").value = "vlc_source";
    if (existing) await desk.elements.get("add-source").onclick();
    else {
      desk.elements.get("new-scene").value = "Replays";
      await desk.submit("create-form");
    }
    const create = desk.state.requests.find(request => request.requestType === "CreateInput");
    assert.equal(create.requestData.inputKind, "vlc_source");
    assert.deepEqual(create.requestData.inputSettings, { playlist: [], loop: false, shuffle: false, playback_behavior: "stop_restart" });
    assert.equal(desk.elements.get("source").value, "Replays Video");
    desk.evaluate("obs.disconnect()");
  }
});

test("unavailable VLC support leaves OBS scenes unchanged", async () => {
  const desk = app();
  await desk.connect();
  desk.state.inputKinds = ["ffmpeg_source"];
  desk.elements.get("new-source-kind").value = "vlc_source";
  desk.elements.get("new-scene").value = "Replays";
  await desk.submit("create-form");
  assert.match(desk.elements.get("message").textContent, /VLC Video Source is unavailable/);
  assert.equal(desk.state.requests.some(request => ["CreateScene", "CreateInput"].includes(request.requestType)), false);
  desk.evaluate("obs.disconnect()");
});

test("folder matching supports Windows paths and avoids ambiguous basenames", () => {
  const desk = app();
  const first = { name: "clip.mp4", webkitRelativePath: "Clips/Match/clip.mp4" };
  const second = { name: "clip.mp4", webkitRelativePath: "Clips/Other/clip.mp4" };
  desk.evaluate("globalThis.lookup = findPreviewFile");
  const lookup = desk.evaluate("lookup");
  assert.equal(lookup("C:\\Clips\\Match\\clip.mp4", [first, second]), first);
  assert.equal(lookup("/unknown/clip.mp4", [first, second]), null);
  assert.equal(lookup("/Clips/clip.mp4", [first]), first);
});

test("preview uses a local blob and never changes OBS", async () => {
  const desk = app();
  desk.evaluate('addReplay("/Clips/clip.mp4"); files = [{ name: "clip.mp4", webkitRelativePath: "Clips/clip.mp4" }]');
  await desk.evaluate("selectReplay(replays[0])");
  assert.equal(desk.elements.get("video").src, "blob:test-preview");
  assert.equal(desk.state.requests.length, 0);
});

test("disconnect rejects pending requests and reconnect can authenticate again", async () => {
  const desk = app();
  await desk.connect();
  const pending = desk.evaluate('obs.request("Hang")');
  const rejected = assert.rejects(pending, /disconnected/);
  desk.evaluate("obs.disconnect()");
  await rejected;
  await desk.connect();
  assert.equal(desk.evaluate("obs.ready"), true);
  await assert.rejects(desk.evaluate('obs.request("Fail")'), /Test rejection/);
  desk.evaluate("obs.disconnect()");
});

test("reports partial creation without creating another scene", async () => {
  const desk = app();
  await desk.connect();
  desk.state.failCreateInput = true;
  desk.elements.get("new-scene").value = "Replays";
  await desk.submit("create-form");
  assert.match(desk.elements.get("message").textContent, /was created, but its media source/);
  assert.equal(desk.elements.get("add-source").hidden, false);
  assert.equal(desk.state.scenes.length, 1);
  desk.evaluate("obs.disconnect()");
});


test("automatic reconnection defaults on, backs off to 30 seconds, and restores the replay target", async () => {
  const desk = app({ scenes: [{ sceneName: "Replays" }], inputs: [{ sceneName: "Replays", inputName: "Replay Video", inputKind: "ffmpeg_source" }] });
  assert.equal(desk.elements.get("auto-reconnect").checked, true);
  assert.equal(desk.state.connections, 0);
  await desk.connect();
  desk.state.offline = true;
  desk.state.socket.close(1006);
  await desk.settle();
  assert.match(desk.elements.get("status").textContent, /Reconnecting in 1s/);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) await desk.retry(delay);
  desk.state.offline = false;
  await desk.retry(30000);
  assert.equal(desk.evaluate("obs.ready"), true);
  assert.equal(desk.elements.get("scene").value, "Replays");
  assert.equal(desk.elements.get("source").value, "Replay Video");
  desk.state.socket.close(1006);
  await desk.settle();
  await desk.retry(1000);
  assert.equal(desk.evaluate("obs.ready"), true);
  desk.elements.get("disconnect").onclick();
  await desk.settle();
  assert.equal(desk.timers.size, 0);
});

test("reload connects with saved credentials and restores a disabled reconnect setting", async () => {
  const original = app({ password: "secret-password" });
  await original.connect();
  const restored = app({ storage: original.storage, password: "secret-password" });
  await restored.settle();
  assert.equal(restored.evaluate("obs.ready"), true);
  assert.equal(restored.state.connections, 1);
  assert.equal(restored.elements.get("password").value, "secret-password");
  restored.elements.get("auto-reconnect").checked = false;
  restored.elements.get("auto-reconnect").onchange();
  assert.equal(restored.evaluate("obs.ready"), true);
  restored.state.socket.close(1006);
  await restored.settle();
  assert.equal(restored.timers.size, 0);
  const disabled = app({ storage: restored.storage });
  await disabled.settle();
  assert.equal(disabled.elements.get("auto-reconnect").checked, false);
  assert.equal(disabled.state.connections, 0);
});

test("disconnect, disabling reconnect, and unloading cancel pending retries", async () => {
  for (const cancel of ["disconnect", "disable", "unload"]) {
    const desk = app();
    await desk.connect();
    desk.state.socket.close(1006);
    await desk.settle();
    assert.equal(desk.timers.size, 1);
    assert.equal(desk.elements.get("disconnect").disabled, false);
    if (cancel === "disconnect") desk.elements.get("disconnect").onclick();
    if (cancel === "disable") {
      desk.elements.get("auto-reconnect").checked = false;
      desk.elements.get("auto-reconnect").onchange();
    }
    if (cancel === "unload") desk.state.beforeunload();
    await desk.settle();
    assert.equal(desk.timers.size, 0);
    if (cancel === "disable") {
      desk.elements.get("auto-reconnect").checked = true;
      desk.elements.get("auto-reconnect").onchange();
      await desk.settle();
      assert.equal(desk.evaluate("obs.ready"), true);
    }
  }
});

test("failed initial connections save settings and retry without overlapping sockets", async () => {
  const desk = app();
  desk.state.offline = true;
  await desk.connect();
  assert.equal(JSON.parse(desk.storage.get("reactive-replay-desk-v1")).autoReconnect, true);
  assert.equal(desk.state.connections, 1);
  assert.equal(desk.timers.size, 1);
  await desk.retry(1000);
  assert.equal(desk.state.connections, 2);
  await desk.submit("connection-form");
  assert.equal(desk.state.connections, 3);
  assert.equal(desk.timers.size, 1);
  desk.state.offline = false;
  await desk.retry(1000);
  assert.equal(desk.evaluate("obs.ready"), true);
  assert.equal(desk.timers.size, 0);
});


test("handshake timeouts retry and an in-progress connection can be cancelled", async () => {
  const desk = app();
  desk.state.silent = true;
  desk.elements.get("connection-form").onsubmit({ preventDefault() {} });
  assert.equal(desk.elements.get("disconnect").disabled, false);
  await desk.retry(10000);
  assert.equal(desk.evaluate("obs.ready"), false);
  desk.state.silent = false;
  await desk.retry(1000);
  assert.equal(desk.evaluate("obs.ready"), true);
  desk.elements.get("disconnect").onclick();
  await desk.settle();
  assert.equal(desk.timers.size, 0);
  desk.state.silent = true;
  desk.elements.get("connection-form").onsubmit({ preventDefault() {} });
  desk.elements.get("disconnect").onclick();
  await desk.settle();
  assert.equal(desk.timers.size, 0);
});


test("reload preserves an explicit disconnect even when automatic reconnection is enabled", async () => {
  const desk = app();
  await desk.connect();
  desk.elements.get("disconnect").onclick();
  await desk.settle();
  assert.equal(JSON.parse(desk.storage.get("reactive-replay-desk-v1")).connectionWanted, false);
  const restored = app({ storage: desk.storage });
  await restored.settle();
  assert.equal(restored.elements.get("auto-reconnect").checked, true);
  assert.equal(restored.state.connections, 0);
  restored.elements.get("auto-reconnect").checked = false;
  restored.elements.get("auto-reconnect").onchange();
  restored.elements.get("auto-reconnect").checked = true;
  restored.elements.get("auto-reconnect").onchange();
  await restored.settle();
  assert.equal(restored.state.connections, 0);
  await restored.connect();
  const connected = app({ storage: restored.storage });
  await connected.settle();
  assert.equal(connected.evaluate("obs.ready"), true);
});

test("unloading after connection loss preserves the last Connect action", async () => {
  const desk = app();
  await desk.connect();
  desk.state.offline = true;
  desk.state.socket.close(1006);
  await desk.settle();
  desk.state.beforeunload();
  await desk.settle();
  assert.equal(JSON.parse(desk.storage.get("reactive-replay-desk-v1")).connectionWanted, true);
  const restored = app({ storage: desk.storage });
  await restored.settle();
  assert.equal(restored.evaluate("obs.ready"), true);
});

test("reload with automatic reconnection disabled retains the last Connect action", async () => {
  const desk = app();
  await desk.connect();
  desk.elements.get("auto-reconnect").checked = false;
  desk.elements.get("auto-reconnect").onchange();
  const restored = app({ storage: desk.storage });
  await restored.settle();
  assert.equal(restored.state.connections, 0);
  restored.elements.get("auto-reconnect").checked = true;
  restored.elements.get("auto-reconnect").onchange();
  await restored.settle();
  assert.equal(restored.evaluate("obs.ready"), true);
});


test("keeps and restores all tracked history, with paged access to hidden clips", () => {
  const desk = app();
  desk.evaluate('for (let i = 0; i < 130; i++) addReplay(`/Clips/${i}.mp4`)');
  assert.equal(desk.evaluate("replays.length"), 130);
  assert.equal(desk.evaluate("visibleReplays().length"), 20);
  desk.elements.get("limit").value = "5";
  desk.elements.get("limit").onchange();
  assert.equal(desk.evaluate("replays.length"), 130);
  desk.elements.get("show-hidden").onclick();
  assert.equal(desk.evaluate("visibleReplays()[0].path"), "/Clips/124.mp4");
  assert.equal(desk.elements.get("replays").children.length, 24);
  desk.elements.get("next-page").onclick();
  assert.equal(desk.evaluate("visibleReplays()[0].path"), "/Clips/100.mp4");
  desk.elements.get("previous-page").onclick();
  assert.equal(desk.evaluate("visibleReplays()[0].path"), "/Clips/124.mp4");
  const restored = app({ storage: desk.storage });
  assert.equal(restored.evaluate("replays.length"), 130);
  assert.equal(restored.evaluate("visibleReplays().length"), 5);
  desk.elements.get("limit").value = "200";
  desk.elements.get("limit").onchange();
  desk.elements.get("show-recent").onclick();
  assert.equal(desk.evaluate("visibleReplays().length"), 130);
});

test("age filtering expires clips without a new event and persists its settings", async () => {
  const desk = app();
  desk.evaluate('addReplay("/Clips/old.mp4"); addReplay("/Clips/recent.mp4"); replays[1].savedAt -= 6 * 60000');
  desk.elements.get("hide-mode").value = "age";
  desk.elements.get("minutes").value = "5";
  desk.elements.get("hide-mode").onchange();
  assert.equal(desk.evaluate("visibleReplays().length"), 1);
  assert.equal(desk.elements.get("show-hidden").textContent, "Hidden (1)");
  const expiry = [...desk.timers.values()][0];
  assert.ok(expiry.delay > 290000 && expiry.delay <= 300000);
  desk.evaluate("replays[0].savedAt -= 6 * 60000");
  expiry.callback();
  assert.equal(desk.evaluate("visibleReplays().length"), 0);
  assert.equal(desk.elements.get("show-hidden").textContent, "Hidden (2)");
  assert.equal(desk.evaluate("replays.length"), 2);
  desk.elements.get("show-hidden").onclick();
  assert.equal(desk.evaluate("visibleReplays().length"), 2);
  const restored = app({ storage: desk.storage });
  assert.equal(restored.elements.get("hide-mode").value, "age");
  assert.equal(Number(restored.elements.get("minutes").value), 5);
});

test("clears only history older than the default 24 hours for the current server", async () => {
  const desk = app();
  assert.equal(Number(desk.elements.get("cleanup-hours").value), 24);
  desk.evaluate(`
    Date.now = () => 100 * 3600000;
    addReplay("/Clips/old.mp4");
    replays[0].savedAt = Date.now() - 25 * 3600000;
    addReplay("/Clips/boundary.mp4");
    replays[0].savedAt = Date.now() - 24 * 3600000;
    addReplay("/Clips/recent.mp4");
    replays.push({ path: "/Clips/other.mp4", savedAt: 0, endpoint: "ws://other:4455" });
    $("limit").value = 1;
    renderReplays();
  `);
  await desk.submit("cleanup-form");
  assert.deepEqual(Array.from(desk.evaluate("replays.map(item => item.path)")), ["/Clips/recent.mp4", "/Clips/boundary.mp4", "/Clips/other.mp4"]);
  assert.equal(desk.evaluate("selected"), null);
  assert.equal(desk.elements.get("preview-name").textContent, "Select a replay");
  assert.equal(desk.elements.get("show-hidden").textContent, "Hidden (1)");
  assert.match(desk.elements.get("message").textContent, /Cleared 1 history item\./);
  assert.equal(desk.state.requests.length, 0);
  const restored = app({ storage: desk.storage });
  assert.equal(restored.evaluate("replays.length"), 3);
});

test("custom cleanup age persists and preserves a retained preview", async () => {
  const desk = app();
  desk.evaluate(`
    addReplay("/Clips/old.mp4");
    replays[0].savedAt -= 2 * 3600000;
    addReplay("/Clips/recent.mp4");
    selectReplay(replays[0]);
    fileOverrides.set(replays[0].path, { name: "recent.mp4" });
    fileOverrides.set(replays[1].path, { name: "old.mp4" });
  `);
  await desk.settle();
  const selected = desk.evaluate("selected");
  const oldCard = desk.evaluate("replayCards.get(replays[1])");
  desk.elements.get("cleanup-hours").value = "0.5";
  desk.elements.get("cleanup-hours").onchange();
  assert.equal(Number(app({ storage: desk.storage }).elements.get("cleanup-hours").value), 0.5);
  await desk.submit("cleanup-form");
  assert.equal(desk.evaluate("replays.length"), 1);
  assert.equal(desk.evaluate("selected"), selected);
  assert.equal(desk.elements.get("preview-name").textContent, "recent.mp4");
  assert.equal(desk.evaluate("fileOverrides.has('/Clips/recent.mp4')"), true);
  assert.equal(desk.evaluate("fileOverrides.has('/Clips/old.mp4')"), false);
  assert.equal(oldCard.video.src, undefined);
  assert.equal(desk.evaluate("replayCards.size"), 1);
});

test("invalid cleanup ages leave history intact and invalid saved ages default to 24 hours", async () => {
  const desk = app();
  desk.evaluate('addReplay("/Clips/old.mp4"); replays[0].savedAt = 0');
  for (const value of ["", "0", "-1", "NaN", "Infinity", "1e308"]) {
    desk.elements.get("cleanup-hours").value = value;
    await desk.submit("cleanup-form");
    assert.equal(desk.evaluate("replays.length"), 1);
    assert.equal(desk.elements.get("message").dataset.kind, "error");
  }
  for (const cleanupHours of [null, 0, -1, "12", 1e308]) {
    const storage = new Map([["reactive-replay-desk-v1", JSON.stringify({ cleanupHours })]]);
    assert.equal(Number(app({ storage }).elements.get("cleanup-hours").value), 24);
  }
});

test("loads grid thumbnails from folder access and releases them when hidden", async () => {
  const desk = app();
  desk.evaluate('addReplay("/Clips/one.mp4"); addReplay("/Clips/two.mp4")');
  desk.elements.get("folder-input").onchange({ target: { files: [
    { name: "one.mp4", webkitRelativePath: "Clips/one.mp4" },
    { name: "two.mp4", webkitRelativePath: "Clips/two.mp4" }
  ] } });
  await desk.settle();
  assert.equal(desk.evaluate("replayCards.size"), 2);
  assert.equal(desk.evaluate("[...replayCards.values()].every(card => card.video.src === 'blob:test-preview')"), true);
  assert.equal(desk.evaluate("[...replayCards.values()][0].video.preload"), "auto");
  const oldCard = desk.evaluate("replayCards.get(replays[1])");
  desk.elements.get("limit").value = "1";
  desk.elements.get("limit").onchange();
  assert.equal(desk.evaluate("replayCards.size"), 1);
  assert.equal(oldCard.video.src, undefined);
  assert.equal(desk.state.requests.length, 0);
  desk.elements.get("show-hidden").onclick();
  await desk.settle();
  assert.equal(desk.evaluate("[...replayCards.values()][0].video.src"), "blob:test-preview");
  desk.elements.get("clear").onclick();
  assert.equal(desk.evaluate("replayCards.size"), 0);
  assert.equal(desk.evaluate("replays.length"), 0);
});

test("discards thumbnail reads completed after clearing history", async () => {
  const desk = app();
  desk.evaluate(`directoryHandle = { name: "Clips", getFileHandle: () => new Promise(resolve => { globalThis.finishRead = resolve; }) }; addReplay("/Clips/one.mp4")`);
  const card = desk.evaluate("replayCards.get(replays[0])");
  desk.elements.get("clear").onclick();
  desk.evaluate("finishRead({ getFile: async () => ({ name: 'one.mp4' }) })");
  await desk.settle();
  assert.equal(card.video.src, undefined);
  assert.equal(desk.evaluate("replayCards.size"), 0);
});

test("missing video access shows overlays with inline folder pickers", async () => {
  const desk = app();
  desk.evaluate('addReplay("/Clips/one.mp4")');
  await desk.settle();
  assert.equal(desk.elements.get("preview-access").hidden, false);
  assert.match(desk.elements.get("preview-access-message").textContent, /Folder access needed/);
  const card = desk.evaluate("replayCards.get(replays[0])");
  assert.equal(card.overlay.hidden, false);
  assert.equal(card.overlay.children[1].textContent, "Choose replay folder");
  await card.overlay.children[1].onclick();
  assert.equal(desk.elements.get("folder-input").clicked, true);
  desk.elements.get("folder-input").clicked = false;
  await desk.elements.get("preview-folder").onclick();
  assert.equal(desk.elements.get("folder-input").clicked, true);
  assert.equal(desk.state.requests.length, 0);
});

test("granting folder access inline loads thumbnails and removes the preview overlay", async () => {
  const desk = app();
  desk.evaluate('addReplay("/Clips/one.mp4")');
  await desk.settle();
  desk.evaluate(`window.showDirectoryPicker = async () => ({
    name: "Clips",
    getFileHandle: async () => ({ getFile: async () => ({ name: "one.mp4" }) })
  })`);
  await desk.elements.get("preview-folder").onclick();
  await desk.settle();
  assert.equal(desk.elements.get("preview-access").hidden, true);
  assert.equal(desk.evaluate("replayCards.get(replays[0]).overlay.hidden"), true);
  assert.equal(desk.elements.get("video").src, "blob:test-preview");
  assert.equal(desk.state.requests.length, 0);
});

test("cancelling inline folder access retains the warning and snapshot access clears it", async () => {
  const desk = app();
  desk.evaluate('addReplay("/Clips/one.mp4")');
  await desk.settle();
  desk.evaluate('window.showDirectoryPicker = async () => { const error = new Error("Cancelled"); error.name = "AbortError"; throw error; }');
  await desk.elements.get("preview-folder").onclick();
  assert.equal(desk.elements.get("preview-access").hidden, false);
  desk.elements.get("folder-input").onchange({ target: { files: [
    { name: "one.mp4", webkitRelativePath: "Clips/one.mp4" }
  ] } });
  await desk.settle();
  assert.equal(desk.elements.get("preview-access").hidden, true);
  assert.equal(desk.evaluate("replayCards.get(replays[0]).overlay.hidden"), true);
});


test("accent follows connection success, loss, retries, and explicit disconnect", async () => {
  const desk = app();
  const accent = () => desk.evaluate("document.documentElement.dataset.connection");
  assert.equal(accent(), "idle");
  await desk.connect();
  assert.equal(accent(), "connected");
  desk.state.offline = true;
  desk.state.socket.close(1006);
  await desk.settle();
  assert.equal(accent(), "lost");
  await desk.retry(1000);
  assert.equal(accent(), "lost");
  desk.state.offline = false;
  await desk.retry(2000);
  assert.equal(accent(), "connected");
  desk.elements.get("disconnect").onclick();
  assert.equal(accent(), "idle");
  await desk.connect();
  desk.state.socket.close(1006);
  await desk.settle();
  assert.equal(accent(), "lost");
  desk.elements.get("disconnect").onclick();
  assert.equal(accent(), "idle");
});
