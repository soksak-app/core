import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { bindSidebarGrip } from '../sidebar-grip.js';

for (const [side, dx, dy] of [['left',40,0],['right',-40,0],['top',0,40],['bottom',0,-40]]) {
  test(`${side} divider adds pointer displacement without opposite-side subtraction`, () => {
    const dom = new JSDOM('<article data-card-id="fixture" style="--pl:100px;--pr:100px;--pt:100px;--pb:100px"><aside><div></div></aside></article>');
    const el = dom.window.document.querySelector('article');
    const body = el.querySelector('aside');
    const handle = body.firstElementChild;
    el.getBoundingClientRect = () => ({left:100,top:50,right:900,bottom:750,width:800,height:700});
    body.getBoundingClientRect = () => ({width:200,height:200});
    handle.setPointerCapture = () => {};
    const calls = [];
    bindSidebarGrip(el,handle,side,{min:120,max:480},(name,params)=>calls.push({name,params}));
    const x = side === 'right' ? 700 : 300;
    const y = side === 'bottom' ? 550 : 283;
    function pointer(type,clientX,clientY) {
      const event = new dom.window.Event(type,{bubbles:true});
      Object.assign(event,{clientX,clientY,pointerId:1});
      handle.dispatchEvent(event);
    }
    try {
      pointer('pointerdown',x,y);
      pointer('pointermove',x+dx,y+dy);
      pointer('pointerup',x+dx,y+dy);
      handle.click();
      assert.deepEqual(calls,[{name:'core.card.sidebar.size',params:{card:'fixture',side,size:240}}]);
      pointer('pointermove',x+dx*2,y+dy*2);
      assert.equal(calls.length,1,'released pointer still changes size');
      pointer('pointerdown',x,y);
      pointer('pointerup',x,y);
      handle.click();
      assert.equal(calls[1].name,'core.card.sidebar.toggle');
    } finally {dom.window.close();}
  });
}

test("a drag from a folded side opens it only when the pointer reaches the minimum size", () => {
  const dom = new JSDOM('<article data-card-id="fixture" data-sidebar-top="folded"><aside><div></div></aside></article>');
  const el = dom.window.document.querySelector('article');
  const body = el.querySelector('aside');
  const handle = body.firstElementChild;
  // 접힌 위쪽 면은 손잡이 폭 6 만큼의 띠다.
  body.getBoundingClientRect = () => ({width:760,height:6});
  handle.setPointerCapture = () => {};
  const calls = [];
  bindSidebarGrip(el,handle,'top',{min:120,max:480},(name,params)=>calls.push({name,params}));
  function pointer(type,clientX,clientY) {
    const event = new dom.window.Event(type,{bubbles:true});
    Object.assign(event,{clientX,clientY,pointerId:1});
    handle.dispatchEvent(event);
  }
  try {
    pointer('pointerdown',400,100);
    // 6 + 20 = 26 은 최소 크기보다 작으므로 면은 접힌 채 있다. 첫 움직임에서 120 으로 튀지 않는다.
    pointer('pointermove',400,120);
    assert.deepEqual(calls,[]);
    // 6 + 130 = 136 에서 열리고, 경계는 포인터를 따른다.
    pointer('pointermove',400,230);
    pointer('pointermove',400,250);
    pointer('pointerup',400,250);
    assert.deepEqual(calls.map(call=>call.params.size),[136,156]);
  } finally {dom.window.close();}
});
