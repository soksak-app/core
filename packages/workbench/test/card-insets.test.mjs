import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { targetCardInsets } from "../card-insets.js";

test("target slot insets replace drawn sidebar bands with requested bands", () => {
  const dom = new JSDOM('<article><aside class="card-sidebar" data-side-of="left"></aside><aside class="card-sidebar" data-side-of="top"></aside><div class="slot"></div></article>');
  const card = dom.window.document.querySelector('article');
  const slot = card.querySelector('.slot');
  card.getBoundingClientRect = () => ({left:10,top:20,width:600,height:400});
  slot.getBoundingClientRect = () => ({left:201,top:83,width:408,height:314});
  card.querySelector('[data-side-of=left]').getBoundingClientRect = () => ({width:190,height:314});
  card.querySelector('[data-side-of=top]').getBoundingClientRect = () => ({width:598,height:30});
  try {
    assert.deepEqual(targetCardInsets(card,slot,{left:0,right:50,top:6,bottom:20}),
      {left:1,top:39,width:52,height:82});
    assert.throws(() => targetCardInsets(card,slot,{left:-1,right:0,top:0,bottom:0}), /invalid sidebar band/);
    slot.getBoundingClientRect = () => ({left:0,top:0,width:0,height:0});
    assert.equal(targetCardInsets(card,slot,{left:0,right:0,top:0,bottom:0}),null);
  } finally {dom.window.close();}
});
