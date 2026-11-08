import assert from "node:assert/strict";
import { designDifferences } from "@soksak/window-check/design-rects.mjs";

const rectangle = ({x,y,w,h}) => ({x,y,width:w,height:h});

/** Independently verify one stable public observation before comparing hosts. */
export function publicHostState({layout,grid,surfaces,modal,hits,normalize=text=>text}) {
  assert.ok(layout?.window && layout.document && Array.isArray(grid?.cards),"public layout/grid observation is missing");
  assert.equal(typeof modal?.open,"boolean","public modal state is missing");
  const window=layout.window;
  assert.deepEqual([layout.document.width,layout.document.height,layout.document.scale],
    [window.content.width,window.content.height,window.scale],"workbench and native content frame differ");
  assert.ok(Array.isArray(surfaces) && Array.isArray(window.surfaces),"public surface observations are missing");
  const visible=surfaces.filter(row=>row.visible).sort((a,b)=>a.declared.y-b.declared.y || a.declared.x-b.declared.x || a.surface.localeCompare(b.surface));
  assert.ok(visible.length>0,"no visible surface was observed");
  assert.deepEqual(window.surfaces.filter(row=>row.visible).map(row=>row.id).sort(),visible.map(row=>row.surface).sort(),
    "native and declared visible surface sets differ");
  const geometry={};
  const surfaceSemantics=[];
  for(const row of visible) {
    assert.ok(row.declared && row.applied,"surface frame declaration or application is missing");
    assert.deepEqual(row.applied,row.declared,`surface ${row.surface} applied frame differs from its declaration`);
    const native=window.surfaces.filter(value=>value.id===row.surface);
    assert.equal(native.length,1,`surface ${row.surface} native frame is missing or ambiguous`);
    assert.deepEqual(native[0].frame,rectangle(row.declared),`surface ${row.surface} native frame differs from its declaration`);
    const hit=hits[row.surface];
    assert.ok(hit,`surface ${row.surface} native hit is missing`);
    if(modal.open) {
      assert.ok(["workbench","native"].includes(hit.kind),`surface ${row.surface} native hit bypassed the modal`);
      assert.notEqual(hit.surface,row.surface,`surface ${row.surface} native hit bypassed the modal`);
      if(hit.kind==="native") assert.equal(hit.identifier,"modal:settings","native modal hit belongs to another owner");
    } else {
      assert.equal(hit.kind,"document",`surface ${row.surface} native hit has no document owner`);
      assert.equal(hit.surface,row.surface,`surface ${row.surface} native hit belongs to another surface`);
    }
    assert.equal(row.composition,"view",`surface ${row.surface} public composition kind differs`);
    geometry[row.surface]=[native[0].frame];
    surfaceSemantics.push({surface:row.surface,plugin:row.plugin,kind:row.kind,composition:row.composition,
      visible:row.visible,dim:row.dim,state:row.state,hit:modal.open ? {blocked:true} : hit});
  }
  // Identity normalization is supplied by the existing orderNames/config owner;
  // geometry never inherits another host's frame or an applied rectangle.
  const semantics=JSON.parse(normalize(JSON.stringify({content:window.content,scale:window.scale,
    settings:layout.settings,project:layout.project,overridden:layout.overridden,
    grid:{fullscreen:grid.fullscreen,gap:grid.gap,cards:grid.cards.map(card=>({id:card.id,c0:card.c0,c1:card.c1,r0:card.r0,r1:card.r1,
      fixed:card.fixed,fullscreen:card.fullscreen,focused:card.focused,pane:card.pane,status:card.status,active:card.active,
      tabs:card.tabs.map(tab=>({id:tab.id,plugin:tab.plugin}))}))},
    surfaces:surfaceSemantics,modal:{open:modal.open}})));
  return {semantics,geometry:JSON.parse(normalize(JSON.stringify(geometry)))};
}

/** Exact public semantics; only cross-host drawn geometry uses the existing design contract. */
export function comparePublicHostStates(states) {
  assert.deepEqual(Object.keys(states).sort(),["mygo","tauriv2","wailsv3"],"public parity requires every declared host");
  const [baseline,...others]=Object.keys(states);
  const stages=Object.keys(states[baseline]);
  for(const name of others) {
    assert.deepEqual(Object.keys(states[name]),stages,`${name} public state transitions differ`);
    for(const stage of stages) assert.deepEqual(states[name][stage].semantics,states[baseline][stage].semantics,
      `${name} public semantic outcome differs from ${baseline} at ${stage}`);
  }
  const geometry=Object.fromEntries(Object.entries(states).map(([host,stages])=>[host,
    Object.fromEntries(Object.entries(stages).map(([stage,state])=>[stage,state.geometry]))]));
  assert.deepEqual(designDifferences(geometry),[],"public cross-host design geometry differs");
}
