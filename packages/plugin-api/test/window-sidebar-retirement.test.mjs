import assert from "node:assert/strict";
import test from "node:test";
import {validateSidebars} from "../index.js";
const withLink = link => ({sets:[{id:"set",title:"Set",sections:[],layout:"list"}],links:[link]});
test("plugin left and right links cannot select window content by focus",()=>{
 for(const place of ["left","right"]) for(const set of ["set",null])
  assert.throws(()=>validateSidebars(withLink({place,plugin:"pane",set}),"settings"),/general window link/);
});
test("window and card links coexist while rail links and null window choices are rejected",()=>{
 const links=[{place:"left",plugin:null,set:"set"},{place:"window-left",plugin:"pane",set:"set"},{place:"card-left",plugin:"pane",set:"set"}];
 validateSidebars({...withLink(links[0]),links},"settings");
 assert.throws(()=>validateSidebars(withLink({place:"rail",plugin:"pane",set:"set"}),"settings"),/requires a place/);
 assert.throws(()=>validateSidebars(withLink({place:"window-right",plugin:"pane",set:null}),"settings"),/known set/);
});
