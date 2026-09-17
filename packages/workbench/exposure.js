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
import {
  EXPOSE_KINDS, EXPOSURE, EXPOSURE_ERRORS, ExposureError, METHOD_KINDS, SURFACE_CORE, declarationKey, declarationMap,
  exposureEntries, replyPayload, validateExposes, validateExposureFile,
} from "@soksak/plugin-api";

/** 코어 dom 항목의 요소. 메인 문서에서 data-expose 속성으로 찾는다. */
const byAttribute = (name) => () => [...document.querySelectorAll(`[data-expose="${name}"]`)];

const ownerOf = (name) => name.slice(0, name.indexOf("."));

/** 표면 문서가 등록하는 이름인지. 플러그인 이름과 core.surface.* 이다. */
const surfaceName = (name) => ownerOf(name) !== "core" || name.startsWith(SURFACE_CORE);

/** 감시 하나의 키. 표면을 지정한 감시와 지정하지 않은 감시는 서로 다르다. */
const watchKey = (name, surface) => JSON.stringify([name, surface ?? null]);

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
 *   origin(surface)         표면 문서의 원점 {x, y}. 창 좌표이고, 모르면 null
 *   registrationChanged()   표면의 등록이 바뀐 뒤 호출된다
 */
export function createRegistry({ call = null } = {}) {
  const declared = new Map();
  const coreDeclared = new Map();
  const core = exposureEntries(coreDeclared);
  const methods = new Map();
  /* 선언 키마다 그 항목을 등록한 표면. 등록 순서를 유지한다. */
  const surfaces = new Map();
  /* 소유 플러그인을 아직 모르는 표면의 등록. 표면을 담은 배치를 불러오면 revisit 이 반영한다. */
  const pending = new Map();
  /* 감시 중인 표면 status. 감시 키마다 따라가는 표면, 요청한 표면, 마지막 버전. */
  const following = new Map();
  let options = { surfacePlugin: () => null, preferred: () => [], origin: () => null, registrationChanged: () => {} };
  let forwards = 0;

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
    if (reply?.error) throw new ExposureError(reply.error.code, reply.error.message);
    return reply?.result ?? null;
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
      changed(name, answer.value, watch.requested);
    }
    if (following.get(key) === watch) following.delete(key);
  }

  /** 같은 표면을 따라가는 다른 감시가 없으면 표면의 감시를 끝낸다. */
  async function release(watch, name) {
    const shared = [...following.values()].some((other) => other.surface === watch.surface && other.name === name);
    if (!shared) await forward(watch.surface, "status.unwatch", { name }).catch(() => {});
  }

  async function answer(method, params) {
    if (methods.has(method)) return methods.get(method)(params ?? {});
    if (method === "exposure.list") return list();
    const name = params?.name;
    const kind = METHOD_KINDS[method];
    const found = kind && typeof name === "string" ? declared.get(declarationKey(kind, name)) : undefined;
    if (!found || !surfaceName(name)) return core.answer(method, params, changed);
    const requested = params.surface;
    const key = watchKey(name, requested);
    if (method === "status.unwatch") {
      const watch = following.get(key);
      following.delete(key);
      if (watch) await release(watch, name);
      return null;
    }
    if (method === "status.watch" && following.has(key)) return null;
    const surface = pick(kind, name, requested);
    const result = await forward(surface, method, method === "status.watch" ? { name } : params);
    if (method === "status.watch") {
      // 표면의 문서는 이름마다 값 하나를 따라가므로 각 감시는 버전 0 부터 받는다.
      const watch = { surface, requested, name, version: 0 };
      following.set(key, watch);
      follow(key, name, watch);
    }
    if (method === "dom.rect") return { ...result, document: options.origin(surface) };
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
          ? (surfaces.get(key)?.size ?? 0) > 0 : core.registered(kind, declaration.name),
      });
    }
    return out;
  }

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
    command: (name, run) => core.command(name, run),
    /** 코어 dom 항목을 등록한다. 요소는 요청 시점에 data-expose 속성으로 찾는다. */
    dom: (name, provide = byAttribute(name)) => core.dom(name, provide),

    /**
     * 이 문서의 코어 명령 하나를 실행한다. 선언의 params 스키마로 검사한다. 문서의 UI 가
     * 조작을 이 경로로 수행하므로, 사람의 조작과 외부 요청이 같은 명령을 거친다.
     */
    run: (name, params = {}) => core.answer("command.run", { name, params }),

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
        pending.delete(surface);
        for (const owners of surfaces.values()) owners.delete(surface);
        for (const [watched, watch] of following) if (watch.surface === surface) following.delete(watched);
        options.registrationChanged();
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
        return;
      }
      if (ownerOf(name) !== "core" && plugin !== ownerOf(name)) {
        throw new Error(`surface ${surface} of plugin ${plugin} cannot register ${name}`);
      }
      if (!surfaces.has(key)) surfaces.set(key, new Map());
      const owners = surfaces.get(key);
      owners.delete(surface);
      owners.set(surface, kind);
      options.registrationChanged();
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
    registrants: (kind, name) => [...(surfaces.get(declarationKey(kind, name))?.keys() ?? [])],

    /** 표면이 등록한 항목. `<kind> <name>` 형식이다. */
    namesOf: (surface) => [...surfaces].filter(([, owners]) => owners.has(surface)).map(([key]) => key),

    /** 요청 하나에 답한다. 결과는 {result} 또는 {error: {code, message}} 다. */
    handle: ({ method, params }) => replyPayload(async () => {
      const result = await answer(method, params);
      // 코어 dom 요소의 문서는 메인 문서이고 그 원점은 창의 원점이다.
      if (method === "dom.rect" && result && result.document === undefined) return { ...result, document: { x: 0, y: 0 } };
      return result;
    }),

    list,
  };
}

/** 이 문서의 등록소. */
export const registry = createRegistry({ call: host ? (name, arg) => host.call(name, arg) : null });

/** 보류된 표면 등록을 반영한다. 선언과 맞지 않는 등록은 호스트 로그로 보고한다. */
export function revisitRegistrations() {
  try {
    registry.revisit();
  } catch (error) {
    if (host) host.call("report", `exposure: ${error.message}`);
  }
}

/** 코어 선언 파일을 불러와 등록소에 더한다. */
export async function loadExposure() {
  const response = await fetch(`/${EXPOSURE}`);
  if (!response.ok) throw new Error(`failed to load /${EXPOSURE}: ${response.status}`);
  registry.declare("core", validateExposureFile(await response.json()).exposes);
}

/**
 * 등록소를 호스트에 연결한다. 호스트가 없으면 문서가 아는 값만 받는다.
 *
 * 등록이 선언과 맞지 않으면 report 로 기록한다. 표면의 호출은 호스트가 이미 받았으므로
 * 그 표면에 실패를 돌려줄 경로가 없다.
 */
export async function connectExposure(values) {
  registry.configure(values);
  if (!host) return;
  await host.on("exposure-request", (request) => {
    registry.handle(request).then((payload) => host.call("exposureReply", { id: request.id, ...payload }));
  });
  await host.on("exposure-registered", (event) => {
    try {
      registry.registered(event);
    } catch (error) {
      host.call("report", `exposure: ${error.message}`);
    }
  });
}
