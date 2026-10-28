import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { cloudInvocation } from "../src/cloud-cli.mjs";
import { normalizeTaskId } from "../src/task-id.mjs";
import { normalizeThreadId } from "../src/thread-id.mjs";
import { cloudThread, CloudReadClient, cloudConnection } from "../src/cloud-connection.mjs";
import { sendCloudInput } from "../src/cloud-send.mjs";
import { listCloudTasks } from "../src/cloud.mjs";
import { streamThread } from "../src/monitor.mjs";
import { readSnapshot } from "../src/observe.mjs";

const task = "task_fixture_common", first = `${task}~assttrn_fixture_1`, user = `${task}~usertrn_fixture_1`;

test("cloud dispatch selects the actual target and cannot reinterpret message text or weaken Desktop ID validation", () => {
  for (const args of [["read",task],["send",task,"text"],["send","--backend","app-server",task,"hello","--dry-run"],["doctor","--backend","app-server","--thread",task],["--supervisor","fixture","findings","create","--key","fixture",task],["supervise","prompt",task],["--connection","cloud","threads","list"],["doctor","--thread",task]]) assert.equal(cloudInvocation(args),true);
  for (const args of [["send","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",task],["help","send"],["cloud","read",task],["supervise","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","--",task]]) assert.equal(cloudInvocation(args),false);
  assert.equal(normalizeTaskId(`https://chatgpt.com/codex/tasks/${task}`),task);
  assert.throws(()=>normalizeThreadId(task));
});

test("common Cloud progress retains stable identities across commands, updates and final answers", () => {
  const snapshot = { task_id: task, status: "in_progress", turns: [{ turn_id: first, role: "assistant", status: "in_progress", messages: [], commands: [], progress: [{ id: "fixture_progress", text: "Starting" }] }] };
  let read = readSnapshot(cloudThread(snapshot)), cursor = read.cursor;
  const id = read.events.find(e => e.type === "agentMessage").id;
  snapshot.turns[0].commands.push({ id: "fixture_command", command: "printf ok", status: "completed", output: "ok", exit_code: 0 });
  snapshot.turns[0].progress[0].text = "Checking";
  snapshot.turns[0].progress.push({ id: "fixture_next", text: "Almost finished" });
  read = readSnapshot(cloudThread(snapshot), { since: cursor }); cursor = read.cursor;
  assert.equal(read.events.find(e => e.id === id).text, "Checking");
  assert(read.events.some(e => e.id === "fixture_command"));
  assert(read.events.some(e => e.text === "Almost finished"));
  snapshot.status = "completed"; snapshot.turns[0].status = "completed"; snapshot.turns[0].messages.push({ text: "Done" });
  read = readSnapshot(cloudThread(snapshot), { since: cursor });
  assert(read.events.some(e => e.text === "Done" && e.phase === "final_answer"));
  assert.equal(readSnapshot(cloudThread(snapshot), { since: read.cursor }).changed, false);
});

test("Cloud Monitor reports a progress-only update without waiting for commands or a final answer", async () => {
  const stop = new AbortController(); let reads = 0; const output = [];
  const snapshot = { task_id: task, status: "in_progress", turns: [{ turn_id: first, role: "assistant", status: "in_progress", messages: [], commands: [], progress: [] }] };
  await streamThread(task, { connection: "cloud", notify: "all", signal: stop.signal }, async data => {
    output.push(data);
    if (data.events?.some(e => e.text === "Public progress")) stop.abort();
  }, { ...cloudConnection({ read: async () => {
    if (++reads === 2) snapshot.turns[0].progress.push({ id: "fixture_progress", text: "Public progress" });
    if (reads > 3) assert.fail("progress-only updates must wake the monitor");
    return structuredClone(snapshot);
  } }), sleep: async () => {} });
  const event = output.flatMap(data => data.events ?? []).find(e => e.text === "Public progress");
  assert.equal(event.type, "agentMessage"); assert.equal(event.phase, "commentary");
});

test("backend options before Cloud targets use the Cloud path and dry runs remain offline", async t => {
  const f = await fixture(t);
  const preview = await f.invoke(["send", "--backend", "app-server", task, "preview", "--dry-run"]);
  assert.equal(preview.execution_environment, "cloud"); assert.equal(preview.sent, false);
  assert.equal(JSON.parse(await readFile(f.state)).posts, 0);
  await assert.rejects(f.invoke(["send", "--backend", "ui", task, "preview", "--dry-run"]), e => e.result?.error.code === "CLOUD_TARGET_CONFLICT");
});

test("cloud history adaptation keeps command positions stable when the final answer arrives", () => {
  const snapshot={task_id:task,status:"in_progress",turns:[{turn_id:first,role:"assistant",status:"in_progress",messages:[],commands:[{id:"command_fixture",command:"printf ok",status:"inProgress",output:"",exit_code:null}]}]};
  const a=cloudThread(snapshot);snapshot.turns[0].messages.push({text:"done"});snapshot.turns[0].commands[0].status="completed";snapshot.turns[0].status="completed";snapshot.status="completed";
  const b=cloudThread(snapshot);assert.equal(a.turns[0].items[0].id,b.turns[0].items[0].id);assert.equal(b.turns[0].items[1].type,"agentMessage");
});

test("common cloud previews remain offline and ambiguous active branches cannot receive a guessed send", async () => {
  const blocked = () => assert.fail("must not submit or authenticate");
  assert.equal((await sendCloudInput(task, "preview", { dryRun: true }, { read: blocked, send: blocked })).sent, false);
  const snapshot = { task_id: task, turn_id: first, status: "in_progress", turns: [first, `${task}~assttrn_fixture_2`].map(id => ({ turn_id: id, role: "assistant", status: "in_progress", messages: [], commands: [] })) };
  await assert.rejects(sendCloudInput(task, "change", {}, { read: async () => snapshot, send: blocked }), { code: "CLOUD_TURN_AMBIGUOUS" });
  await assert.rejects(sendCloudInput(task, "continue", { newTurn: true }, { read: async () => snapshot, send: blocked }), { code: "CLOUD_TASK_BUSY" });
});

test("Cloud task lists paginate above the official page limit and exclude unapproved fields", async () => {
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (args.includes("--help")) return { exitCode: 0, stdout: "codex cloud list --json --limit --cursor --env" };
    if (args[0] === "--version") return { exitCode: 0, stdout: "codex-cli-cloud 0.157.1" };
    const second = args.includes("--cursor"), count = second ? 5 : 20;
    return { exitCode: 0, stdout: JSON.stringify({ tasks: Array.from({ length: count }, (_, i) => ({ id: `task_fixture_${i + (second ? 20 : 0)}`, title: "Fixture", status: "ready", updated_at: { private: "must not propagate" }, secrets: "must not propagate" })), cursor: second ? "next-page" : "page-two" }) };
  };
  const result = await listCloudTasks({ limit: 25, environment: "env_fixture" }, { run });
  assert.equal(result.count, 25); assert.equal(result.has_more, true); assert.equal(result.cursor, "next-page");
  assert.deepEqual(calls.filter(args => args[0] === "list" && !args.includes("--help")).map(args => args[args.indexOf("--limit") + 1]), ["20", "5"]);
  assert(!JSON.stringify(result).includes("must not propagate"));
  await assert.rejects(listCloudTasks({ limit: 25 }, { run: async args => args[0] === "--version" ? { exitCode: 0, stdout: "codex-cli-cloud 0.157.1" } : args.includes("--help") ? { exitCode: 0, stdout: "codex cloud list" } : { exitCode: 0, stdout: '{"tasks":[],"cursor":"loop"}' } }), { code: "CLOUD_PROTOCOL_UNVERIFIED" });
});

test("Cloud Monitor reconnects transient failures and cancellation aborts the backend request", async () => {
  const stop = new AbortController(), states = []; let reads = 0;
  const snapshot = { task_id: task, turn_id: first, status: "completed", turns: [{ turn_id: first, role: "assistant", status: "completed", messages: [], commands: [] }] };
  const deps = cloudConnection({ read: async () => {
    if (++reads === 2) throw Object.assign(new Error("offline"), { code: "CLOUD_CONNECTION_FAILED" });
    return snapshot;
  } });
  await streamThread(task, { connection: "cloud", notify: "all", signal: stop.signal }, async data => {
    if (data.type === "connection") states.push(data.state);
    if (data.state === "recovered") stop.abort();
  }, { ...deps, sleep: async () => {} });
  assert.deepEqual(states, ["watching", "reconnecting", "recovered"]);
  let signal; const client = new CloudReadClient({ read: async (id, options) => { signal = options.signal; return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "CLOUD_CANCELLED" })))); } });
  const reading = client.request("thread/read", { threadId: task }); client.close();
  await assert.rejects(reading, { code: "CANCELLED" }); assert.equal(signal.aborted, true);
});

test("Cloud Monitor respects the server rate-limit delay and stops rather than retrying early past its budget", async () => {
  for (const retryAfter of [15000,120000]) {
    const stop = new AbortController(), waits = [], states = []; let reads = 0, clock = 0;
    const snapshot = { task_id: task, status: "completed", turns: [] };
    const observed = streamThread(task, { connection: "cloud", notify: "all", signal: stop.signal }, async data => {
      if (data.type === "connection") states.push(data);
      if (data.state === "recovered") stop.abort();
    }, { ...cloudConnection({ read: async () => {
      if (++reads === 2) throw Object.assign(new Error("rate limited"), { code: "CLOUD_RATE_LIMITED", retry_after_ms: retryAfter });
      return snapshot;
    } }), now: () => clock, sleep: async ms => { waits.push(ms);clock += ms; } });
    if (retryAfter > 60000) {
      await assert.rejects(observed, e => e.code === "WATCH_RECONNECT_TIMEOUT" && e.cause_code === "CLOUD_RATE_LIMITED");
      assert.equal(reads, 2); assert.deepEqual(waits, [1000,60000]);
    } else {
      await observed; assert.equal(reads, 3); assert.deepEqual(waits, [1000,15000]);
      assert.equal(states.at(-1).state, "recovered");
    }
    assert.equal(states[1].cause_code, "CLOUD_RATE_LIMITED"); assert.equal(states[1].retry_after_ms, retryAfter);
  }
});

async function fixture(t) {
  const root=await mkdtemp("/private/tmp/codexteer-cloud-common-");t.after(()=>rm(root,{recursive:true,force:true}));
  const home=`${root}/home`,bin=`${root}/bin`,state=`${root}/state.json`,preload=`${root}/http.mjs`;await mkdir(home,{mode:0o700});await mkdir(bin,{mode:0o700});
  const assistant={id:first,role:"assistant",turn_status:"completed",created_at:2,output_items:[{type:"message",role:"assistant",content:[{content_type:"text",text:"initial answer"}]}]};
  await writeFile(state,JSON.stringify({sequence:1,posts:0,details:{task:{id:task,current_turn_id:first},current_assistant_turn:assistant},history:{current_turn_id:first,turn_mapping:{
    [user]:{parent:null,turn:{id:user,role:"user",created_at:1,input_items:[{type:"message",role:"user",content:[{content_type:"text",text:"initial instruction"}]}]}},
    [first]:{parent:user,turn:assistant},
  }}}));
  const token=`fixture.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"fixture-account"}})).toString("base64url")}.fixture`;
  await writeFile(`${bin}/codex`,`#!${process.execPath}
let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{pending+=s;let i;while((i=pending.indexOf('\\n'))>=0){const m=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{authMethod:'chatgpt',authToken:${JSON.stringify(token)}}}));}});`,{mode:0o700});
  await writeFile(preload,`import fs from 'node:fs';const file=${JSON.stringify(state)},task=${JSON.stringify(task)};
globalThis.fetch=async(url,options)=>{if(!url.startsWith('https://chatgpt.com/backend-api/wham/'))throw new Error('Unexpected endpoint');let s=JSON.parse(fs.readFileSync(file));let value;if(options.method==='POST'){const body=JSON.parse(options.body);if(body.follow_up?.task_id!==task||body.follow_up.turn_id!==s.details.current_assistant_turn.id)throw new Error('Target mismatch');const parent=s.details.current_assistant_turn.id;if(s.details.current_assistant_turn.turn_status==='in_progress')s.history.turn_mapping[parent].turn.turn_status='cancelled';s.sequence++;s.posts++;const uid=task+'~usertrn_fixture_'+s.sequence,aid=task+'~assttrn_fixture_'+s.sequence;const u={id:uid,role:'user',created_at:s.sequence*2-1,input_items:body.input_items};const a={id:aid,role:'assistant',turn_status:s.sequence===2?'in_progress':'completed',created_at:s.sequence*2,output_items:[{type:'message',role:'assistant',content:[{content_type:'text',text:'fixture answer '+s.sequence}]}]};s.history.turn_mapping[uid]={parent,turn:u};s.history.turn_mapping[aid]={parent:uid,turn:a};s.history.current_turn_id=aid;s.details={task:{id:task,current_turn_id:aid},current_assistant_turn:a};fs.writeFileSync(file,JSON.stringify(s));value={task:{id:task}};}else value=url.endsWith('/environments')?[{id:'env_fixture',label:'fixture/project',repo_map:{fixture:{repository_full_name:'fixture/project',default_branch:'main'}}}]:url.endsWith('/turns')?s.history:s.details;return new Response(JSON.stringify(value),{status:200});};`);
  const env={...process.env,PATH:bin,HOME:home,CODEX_HOME:home};
  const invoke=args=>{ if(args.includes("send")) args=[...args,"--no-sound"]; return new Promise((resolve,reject)=>execFile(process.execPath,["--import",preload,"bin/codexteer.mjs",...args,"--json"],{env,timeout:15000},(error,stdout,stderr)=>{let data;try{data=JSON.parse(stdout)}catch{}if(error)reject(Object.assign(error,{result:data,stdout,stderr}));else resolve(data.data);})); };
  const raw=args=>new Promise((resolve,reject)=>execFile(process.execPath,["--import",preload,"bin/codexteer.mjs",...args],{env,timeout:20000},(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve(stdout)));
  return {root,home,bin,state,preload,env,invoke,raw};
}

test("common Cloud commands preserve supervisor controls, findings, active intervention, history and instructions",async t=>{
  const f=await fixture(t),run=f.invoke;
  const prompt=await run(["supervise","prompt",task,"--use-path-cli"]);assert.equal(prompt.supervisor.connection,"cloud");assert.match(prompt.prompt,/Codex Cloud/);assert.match(prompt.prompt,/watch .*--stream --notify digest/);
  const sid=prompt.supervisor.session_id,managed=(...args)=>run(["--supervisor",sid,"--connection","cloud",...args]);
  assert.equal((await managed("doctor","--thread",task)).ready,true);
  await managed("supervise","register",task,"--owner","fixture");
  let read=await managed("read",task,"--include-output");assert.equal(read.status,"idle");
  const finding=await managed("findings","create",task,"--key","fixture_first","--title","Fixture","--condition","Observe fixture answer","--based-on",read.cursor);
  await run(["supervise","pause",task]);
  await assert.rejects(managed("send",task,"fixture follow-up","--new-turn","--finding",finding.id,"--based-on",read.cursor),e=>e.result?.error.code==="SUPERVISOR_PAUSED");
  assert.equal(JSON.parse(await readFile(f.state)).posts,0);assert.equal((await managed("read",task)).status,"idle");
  await run(["supervise","resume",task]);
  const sent=await managed("send",task,"fixture follow-up","--new-turn","--finding",finding.id,"--based-on",read.cursor);assert.equal(sent.delivery_status,"accepted");
  const stored=await managed("history","check",task,sent.message_id);assert.equal(stored[0].verification.status,"stored");
  const instructions=await managed("instructions","list",task);assert.equal(instructions.instructions.length,1);
  read=await managed("read",task);assert.equal(read.status,"active");
  const next=await managed("findings","create",task,"--key","fixture_active","--title","Active fixture","--condition","Interrupt and continue","--based-on",read.cursor);
  const steer=await managed("send",task,"fixture active change","--finding",next.id,"--based-on",read.cursor);assert.equal(steer.delivery_action,"interrupt-and-follow-up");
  const status=await managed("status",task);assert.equal(status.status,"idle");
  await assert.rejects(managed("send",task,"duplicate","--new-turn","--finding",next.id,"--based-on",(await managed("read",task)).cursor),e=>e.result?.error.code==="DUPLICATE_INTERVENTION");
  assert.equal(JSON.parse(await readFile(f.state)).posts,2);
  await run(["supervise","stop",task]);await assert.rejects(managed("read",task),e=>e.result?.error.code==="SUPERVISOR_STOPPED");
  assert.equal((await run(["supervise","status",task])).state,"stopped");
});


test("Cloud supervisor launch registers the actual launcher, pins saved/PATH commands and stops on agent exit",async t=>{
  const f=await fixture(t);
  await writeFile(`${f.bin}/claude`,`#!${process.execPath}
const fs=require('node:fs');const prompt=process.argv.at(-1);const record=JSON.parse(fs.readFileSync(process.env.CODEX_HOME+'/codex-steer/cloud-supervisors/task_fixture_common.json'));if(record.state!=='active'||record.connection!=='cloud'||record.launcher_pid!==process.ppid)throw new Error('Supervisor binding was not registered');console.log(JSON.stringify({registered:true,cloud:prompt.includes('Codex Cloud'),saved:prompt.includes('--require-node-version'),task:record.thread_id}));`,{mode:0o700});
  for(const pathMode of [false,true]){
    const result=JSON.parse(await f.raw(['supervise',task,'Observe only; do not send.','--agent','claude',...(pathMode?['--use-path-cli']:[])]));
    assert.equal(result.registered,true);assert.equal(result.cloud,true);assert.equal(result.saved,!pathMode);assert.equal(result.task,task);
    const status=await f.invoke(['supervise','status',task]);assert.equal(status.state,'stopped');
  }
});
