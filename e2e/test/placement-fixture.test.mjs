import assert from "node:assert/strict";
import test from "node:test";
import * as fixtures from "../fixture.mjs";

async function prepare(target, others) {
  assert.equal(typeof fixtures.prepareOcclusionFixture,"function","placement fixture must own inactive cohort preparation");
  return fixtures.prepareOcclusionFixture(target,others);
}
// The height of the title bar that a window frame holds above its content area in this fake host.
const TITLE_BAR=28;
function cohort({external=false,targetName="mygo",failure=null}={}) {
  const calls=[],cleanups=[];
  const rows=[{name:"wailsv3",x:0},{name:"tauriv2",x:600},{name:"mygo",x:300}].map(({name,x},index)=>({
    app:{name},window:`${name}-window`,frame:{x,y:39,width:1200,height:760},client:{endpoint:{pid:100+index}},
  }));
  const target=rows.find(row=>row.app.name===targetName);
  const others=rows.filter(row=>row!==target);
  // In this declared layout the two outside windows jointly cover the middle
  // one. A public status provider, not the preparation helper, owns the state.
  // `external` is a window of another application in front of every check
  // window at the normal level: it covers the target until the target raises.
  const raised=new Set();
  const covered=()=>external && !raised.has(target.app.name) || targetName==="mygo" && others.some(s=>s.frame.x===0) && others.some(s=>s.frame.x===600);
  for(const row of rows) {
    row.get=async status=>{
      if(status==="host.screens")return [{visible:{x:0,y:39,width:1800,height:1000}}];
      assert.equal(status,"host.window");
      return {frame:{...row.frame},content:{width:row.frame.width,height:row.frame.height-TITLE_BAR},
        occluded:row===target?covered():false,active:false,activationObservation:{count:"0",registered:true}};
    };
    row.run=async(command,params)=>{
      calls.push({app:row.app.name,command,params});
      if(command==="host.window.resize"){
        Object.assign(row.frame,{width:params.width,height:params.height+TITLE_BAR});
        return;
      }
      assert.equal(command,"host.window.move");
      if(failure===row.app.name && params.x!==row.frame.x)throw new Error("owned cohort move failed");
      Object.assign(row.frame,params);
    };
    row.request=async(method,params)=>{
      assert.equal(method,"diagnostics.windows.raise");
      calls.push({app:row.app.name,command:method,params});
      if(params.raise)raised.add(row.app.name);else raised.delete(row.app.name);
    };
    row.cleanup=fn=>cleanups.push(fn);
    row.until=async(status,predicate,message)=>{
      const state=await row.get(status);if(!predicate(state))throw new Error(`${message}; actual occluded=${state.occluded}`);return state;
    };
  }
  return {target,others,calls,cleanups,rows,raised};
}

test("placement preparation removes joint cohort coverage using only owned moves and restores exact frames",async()=>{
  const f=cohort(),original=f.rows.map(row=>({...row.frame}));
  const result=await prepare(f.target,f.others);
  assert.equal(result.before.occluded,true);assert.equal(result.baseline.occluded,false);
  assert.equal(f.target.frame.x,0,"the tested normal window must use the proven exposed left edge without activation");
  assert.ok(f.others.every(row=>row.frame.x===600));
  assert.ok(f.calls.every(call=>["host.window.move","diagnostics.windows.raise"].includes(call.command) && f.rows.some(row=>row.app.name===call.app)));
  assert.equal(f.cleanups.length,4);
  await f.cleanups[0]();
  assert.deepEqual(f.rows.map(row=>row.frame),original);
});

test("placement preparation uses target-left and cohort-right for a right-hand target",async()=>{
  const f=cohort({targetName:"tauriv2"});
  await prepare(f.target,f.others);
  assert.ok(f.others.every(row=>row.frame.x===600));
  assert.equal(f.target.frame.x,0);
});

test("the check raises its windows, so a window of another application in front of them covers none of them",async()=>{
  const f=cohort({external:true});
  const result=await prepare(f.target,f.others);
  assert.equal(result.before.occluded,true);assert.equal(result.baseline.occluded,false);
  assert.deepEqual(f.calls.filter(call=>call.command==="diagnostics.windows.raise").map(call=>[call.app,call.params.raise]),
    [["mygo",true],["wailsv3",true],["tauriv2",true]]);
  assert.deepEqual([...f.raised].sort(),["mygo","tauriv2","wailsv3"]);
  assert.equal(f.cleanups.length,4,"one owner restores the frames and each application lowers its windows");
  for(const cleanup of [...f.cleanups].reverse())await cleanup();
  assert.deepEqual([...f.raised],[]);
  assert.deepEqual(f.rows.map(row=>row.frame.x),[0,600,300]);
});

test("cohort restoration is registered before a partial move failure",async()=>{
  const f=cohort({failure:"tauriv2"});
  f.others.find(row=>row.app.name==="tauriv2").frame.x=500;
  await assert.rejects(prepare(f.target,f.others),/owned cohort move failed/);
  assert.equal(f.cleanups.length,4);
  await f.cleanups[0]();
  assert.deepEqual(f.rows.map(row=>row.frame.x),[0,500,300]);
});

test("a selected single host raises its own windows before its move",async()=>{
  const f=cohort({external:true});
  // Only the selected host runs: no window of another check application stands on the screen.
  for(const row of f.others)row.frame.x=1800;
  const result=await prepare(f.target,[]);
  assert.equal(result.baseline.occluded,false);
  assert.deepEqual(f.calls,[{app:"mygo",command:"diagnostics.windows.raise",params:{raise:true}},
    {app:"mygo",command:"host.window.move",params:{x:0,y:39}}]);
  assert.equal(f.cleanups.length,2);
  for(const cleanup of [...f.cleanups].reverse())await cleanup();
  assert.equal(f.target.frame.x,300);
});

test("a cohort window that stands on another display is parked in the work area of the target and restored there",async()=>{
  const f=cohort();
  // The application opened its window on a display above the display of the target.
  const tauri=f.rows.find(row=>row.app.name==="tauriv2");
  Object.assign(tauri.frame,{x:-1320,y:-1467});
  const original=f.rows.map(row=>({...row.frame}));
  const result=await prepare(f.target,f.others);
  assert.equal(result.baseline.occluded,false);
  assert.deepEqual(result.parked.find(row=>row.application==="tauriv2").parkedFrame,{x:600,y:39,width:1200,height:760});
  for(const cleanup of [...f.cleanups].reverse())await cleanup();
  assert.deepEqual(f.rows.map(row=>row.frame),original);
});

test("placement preparation rejects ownership of the target in its parked cohort",async()=>{
  const f=cohort();
  await assert.rejects(prepare(f.target,[...f.others,f.target]),/target.*cohort|cohort.*target/);
  assert.deepEqual(f.calls,[]);
});

test("duplicate parked window ownership is rejected before moving any window",async()=>{
  const f=cohort();
  await assert.rejects(prepare(f.target,[...f.others,f.others[0]]),/duplicate/);
  assert.deepEqual(f.calls,[]);
});

test("placement preparation exposes the target at the normal left edge and restores its exact original frame",async()=>{
  const f=cohort(),original=f.rows.map(row=>({...row.frame}));
  const until=f.target.until;
  f.target.until=async(status,predicate,message)=>{
    const state=await f.target.get(status);
    state.occluded=f.target.frame.x!==0 || f.others.some(row=>row.frame.x!==600);
    if(!predicate(state))throw new Error(`${message}; actual normal left edge is still covered`);
    return state;
  };
  const result=await prepare(f.target,f.others);
  assert.equal(result.before.frame.x,300);assert.equal(result.baseline.frame.x,0);
  assert.equal(result.baseline.occluded,false);
  assert.equal(result.baseline.active,false);
  assert.equal(result.baseline.activationObservation.count,"0");
  assert.equal(f.cleanups.length,4,"one owner restores the target and every parked window, and each application lowers its windows");
  f.target.until=until;
  await f.cleanups[0]();
  assert.deepEqual(f.rows.map(row=>row.frame),original);
});

test("a check uncovers its window from the windows of the other check applications, which it opens inactive",async(t)=>{
  const f=cohort(),opened=[];
  const peers=Object.fromEntries(f.others.map(row=>[row.app.name,{
    get:async status=>{assert.equal(status,"host.windows");return [{window:row.window}];},
    on:window=>{assert.equal(window,row.window);return row;},
  }]));
  const apps={wailsv3:{name:"wailsv3"},tauriv2:{name:"tauriv2"},mygo:{name:"mygo"},absent:{name:"absent"}};
  const openApp=async(context,app,options)=>{
    assert.equal(context,t);opened.push([app.name,options]);
    return peers[app.name]??null;
  };
  assert.equal(typeof fixtures.uncoverFromCheckWindows,"function","the fixture owns the uncovering of a check window");
  const result=await fixtures.uncoverFromCheckWindows(t,f.target,{apps,openApp});
  assert.deepEqual(opened,[["wailsv3",{inactive:true}],["tauriv2",{inactive:true}],["absent",{inactive:true}]]);
  assert.equal(result.baseline.occluded,false);
  assert.equal(f.target.frame.x,0);
  assert.ok(f.others.every(row=>row.frame.x===600));
  assert.equal(f.cleanups.length,4);
});

test("the restoration gives back the whole frame that the preparation recorded, its size included",async()=>{
  const f=cohort(),original=f.rows.map(row=>({...row.frame}));
  await prepare(f.target,f.others);
  // The check resized its window while the cohort was parked.
  Object.assign(f.target.frame,{width:1220,height:908});
  await f.cleanups[0]();
  assert.deepEqual(f.rows.map(row=>row.frame),original);
  assert.deepEqual(f.calls.filter(call=>call.command==="host.window.resize"),
    [{app:"mygo",command:"host.window.resize",params:{width:1200,height:760-TITLE_BAR}}]);
});

test("a failed restoration names the cause of each window that it did not restore",async()=>{
  const f=cohort();
  await prepare(f.target,f.others);
  const wails=f.rows.find(row=>row.app.name==="wailsv3");
  wails.run=async()=>{throw new Error("wailsv3 refused the move");};
  await assert.rejects(f.cleanups[0](),(error)=>{
    assert.ok(error instanceof AggregateError);
    assert.match(error.message,/placement owned cohort restoration failed/);
    assert.match(error.message,/wailsv3-window: wailsv3 refused the move/);
    return true;
  });
});
