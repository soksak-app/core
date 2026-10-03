// 메인 페이지의 공개 항목 등록소.
//
// 코어(exposure.json)와 불러온 플러그인(plugin.json 의 exposes)의 선언을 갖고, 코어
// 항목의 등록과 표면 페이지의 등록을 받는다. 네이티브 호스트가 보낸 exposure-request
// 에 답하고, 표면이 등록한 이름의 요청은 그 표면으로 전달한다. 명세는
// docs/spec/exposure.md 에 있다.
//
// 호스트가 없는 브라우저 런타임에서도 등록소는 이 문서 안에서 동작한다. 그때는 요청을
// 받는 경로와 표면이 없다.
import { host } from "@soksak/runtime";
import { timed, trace } from "./performance.js";
import {
  EXPOSE_KINDS, EXPOSURE_ERRORS, ExposureError, METHOD_KINDS, SURFACE_CORE, declarationKey, declarationMap,
  exposureEntries, replyPayload, validateExposes, validateExposureFile,
} from "@soksak/plugin-api";

/** 코어 dom 항목의 요소. 메인 문서에서 data-expose 속성으로 찾는다. */
const byAttribute = (name) => () => [...document.querySelectorAll(`[data-expose="${name}"]`)];

const ownerOf = (name) => name.slice(0, name.indexOf("."));

/** 표면 문서가 등록하는 이름인지. 플러그인 이름과 core.surface.* 이다. */
const surfaceName = (name) => ownerOf(name) !== "core" || name.startsWith(SURFACE_CORE);

/** 감시 하나의 키. 표면을 지정한 감시와 지정하지 않은 감시는 서로 다르다. */
// 기본값: 위 주석대로 표면을 지정하지 않은 감시의 표면은 null 이다.
const watchKey = (name, surface) => JSON.stringify([name, surface ?? null]);

// 이 문서에 마운트된 표면 모듈의 요청 수신자를 보관한다.
const surfacePorts = new Map();

/**
 * 등록소 하나를 만든다.
 *
 *   call(name, arg)  호스트 호출. exposureChanged 와 exposureForward 에 사용한다.
 *                    호스트가 없으면 null 이다
 *
 * 연결 후 configure 로 문서가 아는 값을 받는다.
 *
 *   surfacePlugin(surface)  표면을 소유한 플러그인 id. 모르는 표면이면 null
 *   preferred()             이름을 등록한 표면이 여럿일 때 고를 순서. 표면 id 배열
 *   registrationChanged()   표면의 등록이 바뀐 뒤 호출된다
 */
/** 이 문서가 답하는 명령이 timeout 을 선언하지 않았을 때 답을 기다리는 시간(ms). */
const REPLY_TIMEOUT = 10_000;

export function createRegistry({ call = null } = {}) {
  const declared = new Map();
  const coreDeclared = new Map();
  const core = exposureEntries(coreDeclared);
  const methods = new Map();
  /* 선언 키마다 그 항목을 등록한 표면. 등록 순서를 유지한다. */
  const surfaces = new Map();
  const surfaceNames = (surface) => [...surfaces].filter(([, owners]) => owners.has(surface)).map(([key]) => key);
  const registrationTrace = (phase, surface, fields = {}) => trace("surface.registration", {
    phase, surface, timeOrigin: performance.timeOrigin, hasPort: surfacePorts.has(surface), ...fields,
    get names() { return surfaceNames(surface); },
  });
  /* 소유 플러그인을 아직 모르는 표면의 등록. 표면을 담은 배치를 불러오면 revisit 이 반영한다. */
  const pending = new Map();
  /* 감시 중인 표면 status. 감시 키마다 따라가는 표면, 요청한 표면, 마지막 버전. */
  const following = new Map();
  let options = {
    surfacePlugin: () => null, preferred: () => [], registrationChanged: () => {},
    // 코어 명령이 실행된 뒤 기다릴 작업. 문서는 판의 그리기를 넘겨, 배치를 바꾼 명령이 그려진 뒤 답하게 한다.
    settled: () => undefined,
    // 이 문서 안의 관찰이 실패하면 호출된다. 페이지 오류로 보고한다(docs/spec/plugins.md#sections).
    failed: (error) => dispatchEvent(new ErrorEvent("error", { message: error.message })),
  };
  let forwards = 0;
  /* 이 문서 안에서 surface status 를 따라가는 관찰자. 섹션 모듈이 사용한다. */
  const observers = new Set();
  /* 플러그인 상태 모듈이 이 문서에 등록한 항목. 플러그인 id 마다 항목 표와 status 의 read·subscribe. */
  const pages = new Map();
  /** 플러그인 상태 모듈이 이름을 등록했으면 그 항목 표. */
  const pageOf = (kind, name) => {
    const page = pages.get(ownerOf(name));
    return page?.entries.registered(kind, name) ? page : null;
  };

  const changed = (name, value, surface) => {
    if (call) call("exposureChanged", surface === undefined ? { name, value } : { name, surface, value });
  };

  /**
   * 요청을 표면에 전달한다. 명령 선언에 timeout 이 있으면 호스트가 그 시간만큼 기다린다.
   */
  async function forward(surface, method, params) {
    if (!call) throw new ExposureError(EXPOSURE_ERRORS.gone, `surface ${surface} has no host`);
    const request = { id: ++forwards, surface, method, params };
    const timeout = method === "command.run"
      ? declared.get(declarationKey("command", params?.name))?.declaration.timeout : undefined;
    if (timeout !== undefined) request.timeout = timeout;
    const reply = await call("exposureForward", request);
    if (reply.error) throw new ExposureError(reply.error.code, reply.error.message);
    // 기본값: 결과를 싣지 않은 답은 결과가 null 인 명령의 답이다.
    return reply.result ?? null;
  }

  /** 항목을 등록한 표면 중 요청을 받을 표면. 요청이 표면을 지정하면 그 표면이다. */
  function pick(kind, name, requested) {
    const owners = surfaces.get(declarationKey(kind, name));
    if (requested !== undefined) {
      if (typeof requested !== "string") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "surface must be a string");
      if (!owners?.has(requested)) {
        throw new ExposureError(EXPOSURE_ERRORS.unregistered, `surface ${requested} has not registered ${kind} ${name}`);
      }
      return requested;
    }
    if (!owners?.size) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `${kind} ${name} is not registered`);
    const first = options.preferred().find((surface) => owners.has(surface));
    // 기본값: 선호하는 표면이 등록하지 않았으면 마지막에 등록한 표면이 답한다.
    return first ?? [...owners.keys()].at(-1);
  }

  /**
   * 표면 status 의 변경을 따라간다. status.next 를 반복해서 전달하고, 답이 올 때마다
   * exposureChanged 를 호출한다. 호스트는 status.next 에 대기 시간을 두지 않는다.
   * 감시가 끝나거나 전달이 실패하면(표면이 사라진 경우 등) 멈춘다.
   */
  async function follow(key, name, watch) {
    while (following.get(key) === watch) {
      let answer;
      try {
        answer = await forward(watch.surface, "status.next", { name, version: watch.version });
      } catch {
        break;
      }
      if (following.get(key) !== watch || answer?.closed) break;
      watch.version = answer.version;
      if (watch.external) changed(name, answer.value, watch.requested);
      for (const listener of watch.local) listener(answer.value, watch.surface);
    }
    if (following.get(key) === watch) following.delete(key);
  }

  /** 같은 표면을 따라가는 다른 감시가 없으면 표면의 감시를 끝낸다. */
  async function release(watch, name) {
    const shared = [...following.values()].some((other) => other.surface === watch.surface && other.name === name);
    if (!shared) await forward(watch.surface, "status.unwatch", { name });
  }

  /**
   * 이 문서가 실행하는 명령은 선언의 timeout(없으면 10초) 안에 끝나지 않으면 실패로 끝낸다. 표면으로 전달하는 명령은
   * 호스트가 같은 시간을 적용한다. 코어 명령에서는 handler 실행에만 적용한다. 그 뒤의 배치 표시는 표시 경로의 각
   * 기다림이 자기 한도로 실패하므로, 이 한도가 그 구체적인 실패를 가로채지 않는다.
   */
  function bounded(name, entry, run) {
    // 기본값: timeout 을 선언하지 않은 명령은 10초 안에 끝난다(docs/spec/exposure.md).
    const limit = entry?.declaration.timeout ?? REPLY_TIMEOUT;
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ExposureError(EXPOSURE_ERRORS.failed, `command ${name} did not reply within ${limit}ms`)), limit);
    });
    // handler 의 동기 예외도 이 Promise 의 거부가 되어야 경쟁이 끝나고 타이머가 해제된다. 아니면 예외가 먼저 호출자에게
    // 가고, 남은 타이머가 한도 뒤에 아무도 받지 않는 응답 없음 거부를 만든다.
    const running = new Promise((resolve) => { resolve(run()); });
    return Promise.race([running, expired]).finally(() => clearTimeout(timer));
  }

  function answer(method, params) {
    return method === "command.run" && typeof params?.name === "string"
      ? timed(params.name, () => dispatch(method, params)) : dispatch(method, params);
  }

  async function dispatch(method, params) {
    // 기본값: 매개변수가 없는 요청은 params 를 생략한다.
    if (methods.has(method)) return methods.get(method)(params ?? {});
    if (method === "exposure.list") return list();
    const name = params?.name;
    const kind = METHOD_KINDS[method];
    const found = kind && typeof name === "string" ? declared.get(declarationKey(kind, name)) : undefined;
    // 상태 모듈이 등록한 이름은 표면을 지정하지 않은 요청에 이 문서가 답한다(docs/spec/exposure.md#choosing-a-surface).
    const page = found && params.surface === undefined ? pageOf(kind, name) : null;
    if (page) {
      const answering = () => page.entries.answer(method, params, changed);
      return method === "command.run" ? bounded(name, found, answering) : answering();
    }
    if (!found || !surfaceName(name)) return core.answer(method, params, changed);
    const requested = params.surface;
    const key = watchKey(name, requested);
    if (method === "status.unwatch") {
      const watch = following.get(key);
      if (watch?.local.size) {
        watch.external = false;
        return null;
      }
      following.delete(key);
      if (watch) await release(watch, name);
      return null;
    }
    if (method === "status.watch" && following.has(key)) {
      following.get(key).external = true;
      return null;
    }
    const surface = pick(kind, name, requested);
    const result = await forward(surface, method, method === "status.watch" ? { name } : params);
    if (method === "status.watch") {
      // 표면의 문서는 이름마다 값 하나를 따라가므로 각 감시는 버전 0 부터 받는다.
      const watch = { surface, requested, name, version: 0, external: true, local: new Set() };
      following.set(key, watch);
      follow(key, name, watch);
    }
    return result;
  }

  /** 선언 형식의 목록. 항목마다 registered 가 붙는다. */
  function list() {
    const out = { status: [], commands: [], dom: [] };
    const keyOf = Object.fromEntries(Object.entries(EXPOSE_KINDS).map(([key, kind]) => [kind, key]));
    for (const [key, { kind, declaration }] of declared) {
      out[keyOf[kind]].push({
        ...declaration,
        registered: surfaceName(declaration.name)
          // 기본값: 그 이름을 등록한 표면이 없으면 표면 등록 수는 0 이다.
          ? (surfaces.get(key)?.size ?? 0) > 0 || Boolean(pageOf(kind, declaration.name)) : core.registered(kind, declaration.name),
      });
    }
    return out;
  }

  /** 이름을 등록한 표면 중 이 문서의 요청이 쓸 표면. wanted 가 등록했으면 그 표면이고, 없으면 null 이다. */
  function target(kind, name, wanted, exact = false) {
    if (pageOf(kind, name)) return null;
    const owners = surfaces.get(declarationKey(kind, name));
    if (!owners?.size) return null;
    if (wanted && owners.has(wanted)) return wanted;
    if (exact) return null;
    // 기본값: 선호하는 표면이 등록하지 않았으면 마지막에 등록한 표면이 답한다.
    return options.preferred().find((surface) => owners.has(surface)) ?? [...owners.keys()].at(-1);
  }

  /** 관찰의 실패를 이름과 표면을 붙여 보고한다. */
  const observeFailed = (name, surface) => (error) => options.failed(new Error(`${name} on ${surface}: ${error.message}`));

  /** 관찰자의 감시를 끝낸다. 다른 관찰자나 외부 감시가 없으면 표면의 감시도 끝낸다. */
  function detach(observer) {
    if (observer.stopPage) {
      const stop = observer.stopPage;
      observer.stopPage = null;
      observer.pageEntry = null;
      stop();
    }
    const { watch } = observer;
    observer.watch = null;
    if (!watch) return;
    watch.local.delete(observer.listener);
    if (watch.local.size || watch.external) return;
    const key = watchKey(observer.name, watch.surface);
    if (following.get(key) !== watch) return;
    following.delete(key);
    release(watch, observer.name).catch(observeFailed(observer.name, watch.surface));
  }

  /** 관찰자가 따라갈 표면을 다시 정한다. 표면이 바뀌면 감시를 옮긴다. */
  function reattach(observer) {
    const pageEntry = pageOf("status", observer.name)?.statuses.get(observer.name);
    if (pageEntry) {
      if (observer.pageEntry === pageEntry) return;
      detach(observer);
      observer.surface = "state";
      observer.pageEntry = pageEntry;
      observer.stopPage = pageEntry.subscribe((value) => observer.fn(value, "state"));
      Promise.resolve().then(() => pageEntry.read()).then((value) => {
        if (observer.pageEntry === pageEntry) observer.fn(value, "state");
      }, observeFailed(observer.name, "state"));
      return;
    }
    const surface = target("status", observer.name, observer.wanted, observer.exact);
    const live = observer.watch && following.get(watchKey(observer.name, surface)) === observer.watch;
    if (observer.surface === surface && (surface === null || live)) return;
    detach(observer);
    observer.surface = surface;
    if (surface === null) {
      observer.fn(null, null);
      return;
    }
    const { name } = observer;
    const key = watchKey(name, surface);
    let watch = following.get(key);
    if (watch) {
      watch.local.add(observer.listener);
      observer.watch = watch;
      forward(surface, "status.get", { name }).then((value) => {
        if (observer.watch === watch) observer.fn(value, surface);
      }, observeFailed(name, surface));
      return;
    }
    watch = { surface, requested: surface, name, version: 0, external: false, local: new Set([observer.listener]) };
    following.set(key, watch);
    observer.watch = watch;
    forward(surface, "status.watch", { name }).then(() => follow(key, name, watch), (error) => {
      if (following.get(key) === watch) following.delete(key);
      observeFailed(name, surface)(error);
    });
  }

  const registrationChanged = () => {
    for (const observer of observers) reattach(observer);
    options.registrationChanged();
  };

  return {
    configure(values) {
      options = { ...options, ...values };
    },

    /** 선언을 더한다. owner 는 core 또는 플러그인 id 다. */
    declare(owner, exposes) {
      validateExposes(owner, exposes);
      const own = declarationMap(exposes);
      for (const [key, { declaration }] of own) {
        if (declared.has(key)) throw new Error(`${key} is declared twice`);
        if (ownerOf(declaration.name) !== owner) throw new Error(`${key} does not belong to ${owner}`);
      }
      for (const [key, entry] of own) {
        declared.set(key, entry);
        if (owner === "core") coreDeclared.set(key, entry);
      }
    },

    /** 코어 status 를 등록한다. subscribe(fn) 은 해제 함수를 반환한다. */
    status: (name, read, subscribe) => core.status(name, read, subscribe),
    command: (name, run) => core.command(name, async (params) => {
      const result = await bounded(name, coreDeclared.get(declarationKey("command", name)), () => run(params));
      try {
        await options.settled();
      } catch (error) {
        if (!options.failed(error)) throw error;
      }
      return result;
    }),
    /** 코어 dom 항목을 등록한다. 요소는 요청 시점에 data-expose 속성으로 찾는다. */
    dom: (name, provide = byAttribute(name)) => core.dom(name, provide),

    /**
     * 이 문서의 코어 명령 하나를 실행한다. 선언의 params 스키마로 검사한다. 문서의 UI 가
     * 조작을 이 경로로 수행하므로, 사람의 조작과 외부 요청이 같은 명령을 거친다.
     */
    run: (name, params = {}, surface) => answer("command.run",
      surface === undefined ? { name, params } : { name, params, surface }),

    /**
     * 표면 status 하나를 이 문서 안에서 따라간다. fn(value, surface) 는 현재 값과 그 뒤의 변경마다
     * 호출된다. surface 가 그 이름을 등록했으면 그 표면을, 아니면 요청의 기본 선택을 따라가고,
     * 등록한 표면이 없으면 fn(null, null) 이다. 등록이 바뀌면 표면을 다시 고른다. 해제 함수를 반환한다.
     */
    chosen: (kind, name, wanted, exact = false) => target(kind, name, wanted, exact),

    runOwned(name, params, owner) {
      if (pageOf("command", name)) return answer("command.run", { name, params });
      const surface = target("command", name, owner, true);
      // 기본값: 오류 문장에서 소유자 없음(null)을 none 으로 적는다.
      if (surface === null) return Promise.reject(new ExposureError(EXPOSURE_ERRORS.unregistered, `owner ${owner ?? "none"} has not registered command ${name}`));
      return answer("command.run", { name, params, surface });
    },

    /**
     * 플러그인 owner 의 상태 모듈이 이 문서에 항목을 등록하는 표를 만든다. 플러그인마다 하나이며,
     * clear() 가 항목을 모두 제거한다(docs/spec/plugins.md#plugin-state).
     */
    plugin(owner) {
      if (pages.has(owner)) throw new Error(`plugin ${owner} state is already registered`);
      const page = { entries: exposureEntries(declared), statuses: new Map() };
      pages.set(owner, page);
      const own = (name) => {
        if (ownerOf(name) !== owner) throw new Error(`${name} does not belong to ${owner}`);
      };
      return {
        status(name, read, subscribe) {
          own(name);
          page.entries.status(name, read, subscribe);
          page.statuses.set(name, { read, subscribe });
          registrationChanged();
        },
        command(name, run) {
          own(name);
          page.entries.command(name, run);
          registrationChanged();
        },
        clear() {
          if (pages.get(owner) !== page) return;
          page.entries.clear();
          pages.delete(owner);
          registrationChanged();
        },
      };
    },

    /** 코어 status 하나를 이 문서 안에서 따라간다. fn(value, "core") 이며 해제 함수를 반환한다. */
    observeCore: (name, fn) => core.follow(name, (value) => fn(value, "core")),

    observe(name, surface, fn, { exact = false } = {}) {
      // 기본값: 표면을 지정하지 않은 관찰은 원하는 표면이 null 이다.
      const observer = { name, wanted: surface ?? null, exact, fn, surface: undefined, watch: null, listener: null,
        pageEntry: null, stopPage: null };
      observer.listener = (value, from) => fn(value, from);
      observers.add(observer);
      reattach(observer);
      return () => {
        observers.delete(observer);
        detach(observer);
      };
    },

    /** 선언된 이름인지. */
    declared: (kind, name) => declared.has(declarationKey(kind, name)),

    /** 요청 이름으로 처리하는 메서드를 등록한다. 진단 메서드가 사용한다. */
    method(name, fn) {
      if (methods.has(name)) throw new Error(`method ${name} is already registered`);
      methods.set(name, fn);
    },

    /**
     * 표면의 등록 또는 표면의 제거를 반영한다. 선언과 맞지 않는 등록은 반영하지 않고
     * 예외를 던진다.
     */
    registered({ surface, kind, name, closed }) {
      if (closed) {
        registrationTrace("closed", surface);
        pending.delete(surface);
        for (const owners of surfaces.values()) owners.delete(surface);
        for (const [watched, watch] of following) if (watch.surface === surface) following.delete(watched);
        registrationChanged();
        return;
      }
      const key = declarationKey(kind, name);
      if (!declared.has(key) || !surfaceName(name)) {
        throw new Error(`surface ${surface} registered undeclared ${kind} ${name}`);
      }
      const plugin = options.surfacePlugin(surface);
      if (plugin === null) {
        // 메인 페이지가 다시 읽히면 호스트는 배치를 불러오기 전에 등록을 다시 보낸다.
        if (!pending.has(surface)) pending.set(surface, []);
        pending.get(surface).push({ kind, name });
        registrationTrace("pending", surface, { kind, name });
        return;
      }
      if (ownerOf(name) !== "core" && plugin !== ownerOf(name)) {
        throw new Error(`surface ${surface} of plugin ${plugin} cannot register ${name}`);
      }
      if (!surfaces.has(key)) surfaces.set(key, new Map());
      const owners = surfaces.get(key);
      owners.delete(surface);
      owners.set(surface, kind);
      registrationTrace("registered", surface, { kind, name });
      registrationChanged();
    },

    /**
     * 소유 플러그인을 알게 된 표면의 보류된 등록을 반영한다. 선언이나 플러그인과 맞지 않는
     * 등록은 반영하지 않고, 모아서 예외로 던진다.
     */
    revisit() {
      const errors = [];
      for (const [surface, list] of [...pending]) {
        if (options.surfacePlugin(surface) === null) continue;
        pending.delete(surface);
        for (const entry of list) {
          try {
            this.registered({ surface, ...entry });
          } catch (error) {
            errors.push(error.message);
          }
        }
      }
      if (errors.length) throw new Error(errors.join("; "));
    },

    /** 이 항목을 등록한 표면 id. 등록 순서다. */
    // 기본값: 등록한 표면이 없는 항목의 등록자는 비어 있다.
    registrants: (kind, name) => [...(surfaces.get(declarationKey(kind, name))?.keys() ?? [])],

    /** 표면을 닫을 때 등록·보류·감시를 모두 제거한다. */
    unregisterSurface(surface) {
      registrationTrace("disposed", surface);
      for (const [key, owners] of surfaces) {
        if (!owners.delete(surface)) continue;
        if (owners.size === 0) surfaces.delete(key);
      }
      pending.delete(surface);
      for (const [key, watch] of following) {
        if (watch.surface === surface) following.delete(key);
      }
      registrationChanged();
    },

    /** 표면이 등록한 항목. `<kind> <name>` 형식이다. */
    namesOf: surfaceNames,

    /** 요청 하나에 답한다. 결과는 {result} 또는 {error: {code, message}} 다. */
    handle: ({ method, params }) => replyPayload(async () => {
      // 모든 core·플러그인 명령의 시간을 성능 트레이스에 남긴다(V5-104).
      const result = await answer(method, params);
      // 코어와 마운트된 플러그인은 앱 문서를 공유한다. 별도 문서가 지정한 원점은 유지한다.
      if (method === "dom.rect" && result && result.document === undefined) return { ...result, document: { x: 0, y: 0 } };
      return result;
    }),

    list,
    surfaceDeclarations() {
      const listed = list();
      const onlySurface = (entry) => entry.name.startsWith(SURFACE_CORE);
      return {
        status: listed.status.filter(onlySurface),
        commands: listed.commands.filter(onlySurface),
        dom: listed.dom.filter(onlySurface),
      };
    },
  };
}

/** 이 문서의 등록소. */
export const registry = createRegistry({ call: host ? (name, arg) => host.call(name, arg) : null });

export function registerSurfacePort(surface, port) {
  if (surfacePorts.has(surface)) throw new Error(`surface ${surface} already has an exposure port`);
  surfacePorts.set(surface, port);
  return () => { if (surfacePorts.get(surface) === port) surfacePorts.delete(surface); };
}

export async function dispatchSurfaceRequest(request) {
  const port = surfacePorts.get(request.surface);
  if (!port) return false;
  await port(request);
  return true;
}

/** 보류된 표면 등록을 반영한다. 선언과 맞지 않는 등록은 호스트 로그로 보고한다. */
export function revisitRegistrations() {
  try {
    registry.revisit();
  } catch (error) {
    if (host) host.call("report", `exposure: ${error.message}`);
  }
}

/** 코어 선언 파일(exposure.json)의 내용을 검사해 등록소에 더한다. page 는 첫 화면 전에 JSON module 로 가져온다. */
export function installExposure(document) {
  registry.declare("core", validateExposureFile(document).exposes);
}

/**
 * 등록소를 호스트에 연결한다. 호스트가 없으면 문서가 아는 값만 받는다.
 *
 * 등록이 선언과 맞지 않으면 report 로 기록한다. 표면의 호출은 호스트가 이미 받았으므로
 * 그 표면에 실패를 돌려줄 경로가 없다.
 */
export async function connectExposure(values) {
  registry.configure({
    ...values,
    // default: 호출자가 실패 hook을 주지 않으면 workbench가 보고를 맡는다.
    failed: values.failed ?? ((error) => {
      if (!host) return false;
      // default: Error가 아닌 거절은 그 값을 진단 이유로 담는다.
      host.call("report", `exposure settled failed: ${String(error?.message ?? error)}`);
      return true;
    }),
  });
  if (!host) return;
  await host.on("exposure-request", (request) => {
    dispatchSurfaceRequest(request).then((handled) => {
      if (handled) return;
      return registry.handle(request).then((payload) => host.call("exposureReply", { id: request.id, ...payload }));
    });
  });
  await host.on("exposure-registered", (event) => {
    try {
      registry.registered(event);
    } catch (error) {
      host.call("report", `exposure: ${error.message}`);
    }
  });
}
