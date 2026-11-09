import assert from "node:assert/strict";
import test from "node:test";
import * as fixtures from "../fixture.mjs";

async function prepare(target, others, options) {
  assert.equal(typeof fixtures.prepareOcclusionFixture,"function","placement fixture must own inactive cohort preparation");
  return fixtures.prepareOcclusionFixture(target,others,options);
}
// The window of another application in front of every check window, which covers each of them whole.
const EDITOR={owner:"Editor",pid:900,frame:{x:0,y:0,width:1800,height:1100}};
// The window list of the screen, front to back: the editor, then the check windows in their order.
const screenWindows=rows=>()=>[EDITOR,...rows.map(row=>({owner:row.app.name,pid:row.client.endpoint.pid,frame:{...row.frame}}))];
// The refusal of a covered window that requireUncovered states, naming first the window list entry in front that covers it.
const COVERED=/mygo's window is completely covered by Editor at \{"x":0,"y":0,"width":1800,"height":1100\}(, [^ ]+ at \{[^}]*\})*, so WebKit renders it less often\. Nothing was measured/;
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
  const covered=()=>external || targetName==="mygo" && others.some(s=>s.frame.x===0) && others.some(s=>s.frame.x===600);
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
    row.cleanup=fn=>cleanups.push(fn);
    row.until=async(status,predicate,message)=>{
      const state=await row.get(status);if(!predicate(state))throw new Error(`${message}; actual occluded=${state.occluded}`);return state;
    };
  }
  return {target,others,calls,cleanups,rows};
}

test("placement preparation removes joint cohort coverage using only owned moves and restores exact frames",async()=>{
  const f=cohort(),original=f.rows.map(row=>({...row.frame}));
  const result=await prepare(f.target,f.others);
  assert.equal(result.before.occluded,true);assert.equal(result.baseline.occluded,false);
  assert.equal(f.target.frame.x,0,"the tested normal window must use the proven exposed left edge without activation");
  assert.ok(f.others.every(row=>row.frame.x===600));
  assert.ok(f.calls.every(call=>call.command==="host.window.move" && f.rows.some(row=>row.app.name===call.app)));
  assert.equal(f.cleanups.length,1);
  await f.cleanups[0]();
  assert.deepEqual(f.rows.map(row=>row.frame),original);
});

test("placement preparation uses target-left and cohort-right for a right-hand target",async()=>{
  const f=cohort({targetName:"tauriv2"});
  await prepare(f.target,f.others);
  assert.ok(f.others.every(row=>row.frame.x===600));
  assert.equal(f.target.frame.x,0);
});

test("a user-front cover fails preparation rather than forging a visible state or skipping",async()=>{
  const f=cohort({external:true});
  await assert.rejects(prepare(f.target,f.others,{windows:screenWindows(f.rows)}),COVERED);
  assert.equal(f.cleanups.length,1,"failed preparation must still own restoration");
  await f.cleanups[0]();
  assert.deepEqual(f.rows.map(row=>row.frame.x),[0,600,300]);
  assert.ok(f.calls.every(call=>call.command==="host.window.move"));
});

test("cohort restoration is registered before a partial move failure",async()=>{
  const f=cohort({failure:"tauriv2"});
  f.others.find(row=>row.app.name==="tauriv2").frame.x=500;
  await assert.rejects(prepare(f.target,f.others),/owned cohort move failed/);
  assert.equal(f.cleanups.length,1);
  await f.cleanups[0]();
  assert.deepEqual(f.rows.map(row=>row.frame.x),[0,500,300]);
});

test("a selected single host still requires a real visible baseline",async()=>{
  const f=cohort({external:true});
  await assert.rejects(prepare(f.target,[],{windows:screenWindows(f.rows)}),COVERED);
  assert.deepEqual(f.calls,[{app:"mygo",command:"host.window.move",params:{x:0,y:39}}]);
  assert.equal(f.cleanups.length,1);
  await f.cleanups[0]();
  assert.equal(f.target.frame.x,300);
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
  assert.equal(f.cleanups.length,1,"one owner restores the target and every parked window");
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
  assert.equal(f.cleanups.length,1);
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
