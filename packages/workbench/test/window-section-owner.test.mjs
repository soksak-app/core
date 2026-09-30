import assert from "node:assert/strict";
import test from "node:test";
import {createRegistry} from "../exposure.js";

test("exact window section ownership does not choose another registered surface",()=>{
 const made=createRegistry();
 made.declare("fixture",{status:[{name:"fixture.lines",description:"Lines.",schema:{type:"array"}}],commands:[],dom:[]});
 made.configure({surfacePlugin:()=>"fixture",preferred:()=>["other"]});
 made.registered({surface:"other",kind:"status",name:"fixture.lines"});
 assert.equal(made.chosen("status","fixture.lines","owner",true),null);
 made.registered({surface:"owner",kind:"status",name:"fixture.lines"});
 assert.equal(made.chosen("status","fixture.lines","owner",true),"owner");
});
