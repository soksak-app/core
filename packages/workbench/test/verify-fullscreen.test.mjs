import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";

test("containment checks visible surfaces while hidden surfaces retain their native frame", async (t) => {
  const dom = new JSDOM('<div class="chrome-bar"></div><div><div id="plane"><article class="card" data-card-id="one"><div class="chrome"></div><div class="status"></div><div data-native-surface data-native-surface-id="probe"></div></article></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  const plane = document.querySelector('#plane');
  const grid = new Soksak(undefined,{width:100,height:100});
  const surface = {id:'probe',visible:false,dim:false,declared:{x:0,y:0,w:0,h:0},applied:{x:10,y:10,w:80,h:80}};
  t.mock.module('../compositor.js',{exports:{ahead:()=>null,latest:()=>({seq:1,surfaces:[surface]}),placementPending:()=>false,seated:()=>null}});
  t.mock.module('../plane.js',{exports:{currentGrid:()=>grid,dropBands:()=>({headerPx:32,footerPx:22}),plane,presentedCardRect:()=>undefined,railOutline:()=>({shape:{sharp:0,corners:0,loops:[]},rects:[],groups:[]}),tabsOf:()=>['probe']}});
  t.mock.module('../registry.js',{exports:{isPlace:()=>false}});
  t.mock.module('../settings.js',{exports:{cardRadius:()=>4}});
  const { verify } = await import('../verify.js');
  try {
    assert.equal(verify().find(row=>row.name.startsWith('V10 ')).ok,true,'an invisible retained frame is reported as drawn outside its hidden card');
    surface.visible=true;
    assert.equal(verify().find(row=>row.name.startsWith('V10 ')).ok,false,'a visible escaping frame must fail');
  } finally {dom.window.close();}
});
