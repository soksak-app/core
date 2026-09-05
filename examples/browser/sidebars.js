// 사이드바를 어디에 걸지 고르는 곳.
//
// 자리마다 세트 하나를 고른다. 「없음」을 고르면 연결이 끊어지고, 그 자리에는
// 사이드바가 없다 — 끄는 스위치가 따로 있는 것이 아니라 걸지 않는 것이다.
//
// 어느 자리가 있는지는 등록된 플러그인이 정한다. 플러그인이 늘면 줄이 늘고,
// 여기 적을 것은 없다.
import { link, linkedId, sets } from "./settings.js";
import { plugins, section } from "./plugins/registry.js";

/** 세트 하나가 담은 섹션의 이름들. 무엇을 고르는지 보이게 한다. */
const summary = (set) => set.sections.map((id) => section(id).name).join(" · ");

/** 자리 한 줄 — 이름과, 그 자리에 걸 세트를 고르는 select. */
function row(label, place, plugin) {
  const wrap = document.createElement("label");
  wrap.className = "link";
  wrap.appendChild(document.createTextNode(label));

  const pick = document.createElement("select");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "없음";
  pick.appendChild(none);
  for (const set of sets()) {
    const opt = document.createElement("option");
    opt.value = set.id;
    opt.textContent = `${set.title} — ${summary(set)}`;
    pick.appendChild(opt);
  }
  pick.value = linkedId(place, plugin) ?? "";
  pick.addEventListener("change", () => link(place, plugin, pick.value || null));
  wrap.appendChild(pick);
  return wrap;
}

/** 자리들을 그린다. 설정이 바뀌면 다시 부른다. */
export function drawSidebarLinks(into) {
  into.textContent = "";
  into.appendChild(row("좌측", "left", null));
  for (const p of plugins()) {
    into.appendChild(row(`${p.name} 레일`, "rail", p.id));
    into.appendChild(row(`${p.name} 우측`, "right", p.id));
  }
}
