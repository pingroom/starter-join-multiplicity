import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportJoined, exportAnalysis } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, optionsFor, joinMultiplicity, analyzeJoin, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/model.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-join-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later declarations; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'yes'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input = { max_length: 30 }; }, (q) => { q.options[0].primary = true; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { q.kind = 'poll'; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-button answers never establish a declaration', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'left'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'yes'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.analysis, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across declarations', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'yes'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).analysis, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'yes');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'yes'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'yes'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'yes');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'yes'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).analysis, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});
const choices=(input,values)=>tasksFor(input).map((task,index)=>({side:task.id,choice:values[index]}));
const tables=(left,right)=>({joinId:'fixture',title:'Exact join',context:'Complete offline table exports.',completeExports:true,
  left:{id:'left',label:'Left export',columns:[{id:'key',label:'Join key'},{id:'data',label:'Payload'}],rows:left.map((key,i)=>({id:`l${i}`,values:{key,data:`left ${i}`}}))},
  right:{id:'right',label:'Right export',columns:[{id:'key',label:'Join key'},{id:'data',label:'Payload'}],rows:right.map((key,i)=>({id:`r${i}`,values:{key,data:`right ${i}`}}))},keys:[{leftColumn:'key',rightColumn:'key'}]});
function oracle(input){
  const equal=(a,b)=>input.keys.every(pair=>a.values[pair.leftColumn]!==null&&b.values[pair.rightColumn]!==null&&typeof a.values[pair.leftColumn]===typeof b.values[pair.rightColumn]&&a.values[pair.leftColumn]===b.values[pair.rightColumn]);
  const pairs=[];for(const left of input.left.rows)for(const right of input.right.rows)if(equal(left,right))pairs.push([left.id,right.id]);
  const duplicates=side=>{const rows=input[side].rows,used=new Set(),groups=[];for(const a of rows){if(used.has(a.id)||input.keys.some(pair=>a.values[pair[`${side}Column`]]===null))continue;const group=rows.filter(b=>input.keys.every(pair=>a.values[pair[`${side}Column`]]===b.values[pair[`${side}Column`]]));for(const row of group)used.add(row.id);if(group.length>1)groups.push(group.map(row=>row.id));}return groups;};
  return{pairs,leftDuplicates:duplicates('left'),rightDuplicates:duplicates('right'),leftCopies:input.left.rows.map(row=>({rowId:row.id,joinedCopies:pairs.filter(pair=>pair[0]===row.id).length})),rightCopies:input.right.rows.map(row=>({rowId:row.id,joinedCopies:pairs.filter(pair=>pair[1]===row.id).length}))};
}
function assertConservation(input,result){
  const c=result.conservation;assert.equal(c.leftMatchedRows+c.leftUnmatchedRows,input.left.rows.length);assert.equal(c.rightMatchedRows+c.rightUnmatchedRows,input.right.rows.length);assert.equal(c.joinedPairs,c.sumLeftCopies);assert.equal(c.joinedPairs,c.sumRightCopies);assert.equal(c.holds,true);
  assert.equal(result.matchedGroups.reduce((sum,row)=>sum+row.leftCount*row.rightCount,0),result.matchedPairCount);
  if(result.joinedRows){assert.equal(result.joinedRows.length,result.matchedPairCount);for(const row of result.joinedRows)for(const side of ['left','right']){assert.equal(row[side].tableId,input[side].id);assert.deepEqual(row[side].values,input[side].rows.find(source=>source.id===row[side].rowId).values);}}
}

test('independent nested-loop oracle agrees for every two-row typed/null dataset and all repeat declarations',()=>{
  const values=[null,0,'0',false,'',' '];let cases=0;
  for(const a of values)for(const b of values)for(const c of values)for(const d of values)for(const leftMayRepeat of [false,true])for(const rightMayRepeat of [false,true]){
    const input=tables([a,b],[c,d]),expected=oracle(input),actual=analyzeJoin(input,{leftMayRepeat,rightMayRepeat}),violated=!leftMayRepeat&&expected.leftDuplicates.length>0||!rightMayRepeat&&expected.rightDuplicates.length>0;
    assert.equal(actual.status,violated?'policy_violation':'joined');assert.equal(actual.matchedPairCount,expected.pairs.length);assert.deepEqual(actual.multiplicity.left,expected.leftCopies);assert.deepEqual(actual.multiplicity.right,expected.rightCopies);
    assert.deepEqual(actual.duplicates.left.map(row=>row.rowIds),expected.leftDuplicates);assert.deepEqual(actual.duplicates.right.map(row=>row.rowIds),expected.rightDuplicates);
    assert.deepEqual(actual.unmatched.left,expected.leftCopies.filter(row=>!row.joinedCopies).map(row=>row.rowId));assert.deepEqual(actual.unmatched.right,expected.rightCopies.filter(row=>!row.joinedCopies).map(row=>row.rowId));
    if(violated)assert.equal(actual.joinedRows,null);else assert.deepEqual(actual.joinedRows.map(row=>[row.left.rowId,row.right.rowId]),expected.pairs);
    assertConservation(input,actual);cases++;
  }
  assert.equal(cases,5184);
});

test('matched key groups expose multiplication, per-row copies and complete unmatched lineage',()=>{
  const result=analyzeJoin(simple(),{leftMayRepeat:true,rightMayRepeat:true});assert.equal(result.status,'joined');assert.equal(result.matchedPairCount,4);assert.deepEqual(result.matchedGroups,[{keyTuple:['A'],leftRowIds:['s1','s2'],rightRowIds:['l1','l2'],leftCount:2,rightCount:2,pairCount:4}]);
  assert.deepEqual(result.unmatched,{left:['s3','s4'],right:['l3']});assert.deepEqual(result.nullKeyRowIds,{left:['s4'],right:[]});assertConservation(simple(),result);
});

test('No rejects duplicate non-null keys throughout an export even when those keys never match',()=>{
  const input=tables(['unmatched','unmatched'],['other']),result=analyzeJoin(input,{leftMayRepeat:false,rightMayRepeat:false});assert.equal(result.status,'policy_violation');assert.equal(result.matchedPairCount,0);assert.equal(result.joinedRows,null);assert.equal(result.violations.length,1);assert.equal(result.violations[0].side,'left');assert.equal(result.duplicates.left[0].matchesOtherSide,false);
  const allowed=analyzeJoin(input,{leftMayRepeat:true,rightMayRepeat:false});assert.equal(allowed.status,'joined');assert.deepEqual(allowed.joinedRows,[]);
});

test('null in any composite key position never matches and null-key duplicates do not violate No',()=>{
  const input=tables([null,null,1],[null,1]);for(const side of ['left','right']){input[side].columns.push({id:'second',label:'Second key'});for(const row of input[side].rows)row.values.second=null;}input.keys.push({leftColumn:'second',rightColumn:'second'});
  const result=analyzeJoin(input,{leftMayRepeat:false,rightMayRepeat:false});assert.equal(result.status,'joined');assert.equal(result.matchedPairCount,0);assert.deepEqual(result.duplicates,{left:[],right:[]});assert.deepEqual(result.nullKeyRowIds.left,['l0','l1','l2']);assertConservation(input,result);
});

test('typed equality preserves strings, whitespace and tuple boundaries without coercion or normalization',()=>{
  const input=tables([1,'1',true,'true',' x ','x','\t\n'],['1',1,'true',true,'x',' x ','\t\n']),result=analyzeJoin(input,{leftMayRepeat:false,rightMayRepeat:false});assert.equal(result.matchedPairCount,7);
  assert.deepEqual(result.joinedRows.map(row=>[row.left.rowId,row.right.rowId]),[['l0','r1'],['l1','r0'],['l2','r3'],['l3','r2'],['l4','r5'],['l5','r4'],['l6','r6']]);assertConservation(input,result);
  const composite=tables(['a,b','a'],['a','a,b']);for(const side of ['left','right']){composite[side].columns.push({id:'part',label:'Part'});composite[side].rows[0].values.part='c';composite[side].rows[1].values.part='b,c';}composite.keys.push({leftColumn:'part',rightColumn:'part'});assert.equal(analyzeJoin(composite,{leftMayRepeat:true,rightMayRepeat:true}).matchedPairCount,0);
});

test('three-key join requires every typed component and retains safe integer extremes exactly',()=>{
  const input=tables([Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER],[Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER]);
  for(const side of ['left','right']){input[side].columns.push({id:'flag',label:'Flag'},{id:'space',label:'Space'});for(const row of input[side].rows){row.values.flag=true;row.values.space=' ';}}input.keys.push({leftColumn:'flag',rightColumn:'flag'},{leftColumn:'space',rightColumn:'space'});input.right.rows[1].values.flag='true';
  const result=analyzeJoin(input,{leftMayRepeat:false,rightMayRepeat:false});assert.equal(result.matchedPairCount,1);assert.equal(result.joinedRows[0].left.values.key,Number.MAX_SAFE_INTEGER);assert.deepEqual(result.unmatched.left,['l1']);
});

test('row/column/key ordering canonicalizes deterministically while nested rows preserve each source value',()=>{
  const input=simple(),permuted=structuredClone(input);for(const side of ['left','right']){permuted[side].rows.reverse();permuted[side].columns.reverse();for(const row of permuted[side].rows)row.values=Object.fromEntries(Object.entries(row.values).reverse());}permuted.keys.reverse();
  assert.deepEqual(validateInput(input),validateInput(permuted));assert.deepEqual(analyzeJoin(input,{leftMayRepeat:true,rightMayRepeat:true}),analyzeJoin(permuted,{leftMayRepeat:true,rightMayRepeat:true}));
  const result=analyzeJoin(input,{leftMayRepeat:true,rightMayRepeat:true});result.joinedRows[0].left.values.code='mutated';assert.equal(input.left.rows[0].values.code,'A');
});

test('Unknown or missing declarations withhold all analysis even when a known side violates policy',()=>{
  for(const values of [['unknown','no'],['no','unknown'],[null,'no'],['no',null]])assert.deepEqual(joinMultiplicity(simple(),choices(simple(),values)),{status:'incomplete',analysis:null});
  assert.throws(()=>joinMultiplicity(simple(),choices(simple(),['Yes','yes'])));const sparse=choices(simple(),['yes','yes']);delete sparse[0];assert.throws(()=>joinMultiplicity(simple(),sparse));assert.throws(()=>joinMultiplicity(simple(),choices(simple(),['yes','yes']).reverse()));
});

test('strict schemas reject incomplete exports, unsafe metadata, invalid scalars and ambiguous key pairs',()=>{
  for(const mutate of [x=>{x.extra=true;},x=>{x.completeExports=false;},x=>{x.joinId+='\n';},x=>{x.context='x\u2028y';},x=>{x.left.id='constructor';},x=>{x.right.id=x.left.id;},x=>{x.left.rows=[];},x=>{x.left.rows=Array(17).fill(x.left.rows[0]);},x=>{delete x.left.rows[0];},x=>{x.left.rows[1].id=x.left.rows[0].id;},x=>{x.left.columns.push(x.left.columns[0]);},x=>{delete x.left.columns[0];},x=>{x.left.rows[0].values.extra=1;},x=>{delete x.left.rows[0].values.code;},x=>{x.left.rows[0].values.code=undefined;},x=>{x.left.rows[0].values.code={};},x=>{x.left.rows[0].values.code=[];},x=>{x.left.rows[0].values.code=-0;},x=>{x.left.rows[0].values.code=1.5;},x=>{x.left.rows[0].values.code=Infinity;},x=>{x.left.rows[0].values.code=Number.MAX_SAFE_INTEGER+1;},x=>{x.left.rows[0].values.code='x'.repeat(41);},x=>{x.left.rows[0].values.code='\ud800';},x=>{x.keys=[];},x=>{delete x.keys[0];},x=>{x.keys[0].leftColumn='absent';},x=>{x.keys.push(x.keys[0]);}]){const input=simple();mutate(input);assert.throws(()=>validateInput(input));}
  for(const declaration of [{},{leftMayRepeat:'yes',rightMayRepeat:false},{leftMayRepeat:true,rightMayRepeat:false,extra:true}])assert.throws(()=>analyzeJoin(simple(),declaration));
});

test('full metadata prompts fit SDK bounds and no row values or row IDs enter any PingRoom request',()=>{
  const input=tables(['PRIVATE_VALUE_728193'],['PRIVATE_VALUE_728193']);input.joinId='j'.repeat(32);input.title='界'.repeat(32);input.context='é'.repeat(60);
  for(const side of ['left','right']){input[side].id=side==='left'?'l'.repeat(12):'r'.repeat(12);input[side].label='表'.repeat(32);input[side].columns=Array.from({length:3},(_,i)=>({id:`c${i}`+'x'.repeat(10),label:'列'.repeat(24)}));input[side].rows=[{id:'private_row',values:Object.fromEntries(input[side].columns.map(column=>[column.id,'PRIVATE_VALUE_728193']))}];}
  input.keys=input.left.columns.map((column,i)=>({leftColumn:column.id,rightColumn:input.right.columns[i].id}));
  for(const task of tasksFor(input)){const req=requestFor(input,CONFIG,task.id,id(99)),wire=JSON.stringify(req);assert.ok(req.prompt.length<=500,req.prompt.length);assert.ok(req.prompt.includes(input.context));for(const column of task.keyColumns){assert.ok(req.prompt.includes(column.id));assert.ok(req.prompt.includes(column.label));}assert.equal(wire.includes('PRIVATE_VALUE_728193'),false);assert.equal(wire.includes('private_row'),false);assert.equal(req.data.table_hash,hash(validateInput(input)[task.side]));assert.equal(req.data.policy_hash,POLICY_HASH);assert.deepEqual(req.options.map(option=>option.value),['yes','no','unknown']);}
});

test('published SDK optional receipt fields remain compatible and malformed variants fail',async t=>{
  const s=await setup(t);await s.run();const q=s.api.questions.get(id(1));delete q.results;delete q.is_handoff;for(const option of q.options){delete option.primary;delete option.destructive;}assert.equal((await s.run()).status,'pending');s.api.answer(id(1),'yes');assert.equal((await s.run()).status,'ready');
  for(const [field,values] of [['results',[{},[],false,0]],['is_handoff',[true,null,0,'false']]])for(const value of values){const bad=await setup(t);await bad.run();bad.api.questions.get(id(1))[field]=value;await assert.rejects(bad.run(),/does not match/);}
  for(const field of ['primary','destructive'])for(const value of [true,null,0,'false']){const bad=await setup(t);await bad.run();bad.api.questions.get(id(1)).options[0][field]=value;await assert.rejects(bad.run());}
});

test('complete SDK join exports attributable private rows and analysis with no database calls',async t=>{
  const s=await setup(t),result=await decide(s,['yes','yes']);assert.equal(result.status,'complete');assert.equal(result.analysis.matchedPairCount,4);assertConservation(simple(),result.analysis);assert.ok(result.answers.every(row=>row.responderId===CONFIG.participant.id&&row.askerId===ASKER&&row.sideHash&&row.answeredAt));
  const calls=s.api.calls.length;assert.deepEqual((await exportJoined(s.directory,simple())).analysis,result.analysis);assert.deepEqual((await exportAnalysis(s.directory,simple())).analysis,result.analysis);assert.equal(s.api.calls.length,calls);assert.equal(sends(s.api),2);assert.equal((await stat(join(s.directory,'joined.json'))).mode&0o777,0o600);assert.equal(result.databaseQueried,false);assert.equal(result.databaseModified,false);
  const release=await acquireLock(s.directory);await assert.rejects(exportJoined(s.directory,simple()),/lock exists/);await release();
});

test('known repeat violations export negative analysis but never joined rows; an empty valid join can export',async t=>{
  const s=await setup(t),result=await decide(s,['no','yes']);assert.equal(result.status,'complete');assert.equal(result.analysis.status,'policy_violation');assert.equal(result.analysis.joinedRows,null);assert.equal((await exportAnalysis(s.directory,simple())).analysis.violations.length,1);await assert.rejects(exportJoined(s.directory,simple()),/repeat-policy/);assert.equal(await readJson(join(s.directory,'joined.json')),null);
  const input=tables([1],[2]),empty=await setup(t,input);await decide(empty,['no','no']);assert.deepEqual((await exportJoined(empty.directory,input)).analysis.joinedRows,[]);
});

test('Unknown and malformed SDK declarations withhold the entire analysis',async t=>{
  for(const values of [['unknown','no'],['no','unknown'],['invalid','yes']]){const s=await setup(t),result=await decide(s,values);assert.equal(result.status,'incomplete');assert.equal(result.analysis,null);await assert.rejects(exportAnalysis(s.directory,simple()));await assert.rejects(exportJoined(s.directory,simple()));}
});

test('table data, fixed keys, metadata and saved answer provenance cannot change before requests or export',async t=>{
  const s=await setup(t);await decide(s,['yes','yes']);const original=await s.saved(),calls=s.api.calls.length;
  for(const mutate of [x=>{x.left.rows[0].values.sheets=11;},x=>{x.left.rows[0].values.code=' A ';},x=>{x.context='Other export meaning';},x=>{x.keys[0].leftColumn='sheets';}]){const input=simple();mutate(input);await assert.rejects(s.run({input}));await assert.rejects(exportJoined(s.directory,input));}
  for(const mutate of [x=>{x.attempts[0].observation.answer.value='no';},x=>{x.attempts[0].observation.answer.label='Other';},x=>{x.attempts[0].request.data.policy_hash=hash({});}]){const saved=structuredClone(original);mutate(saved);await atomicJson(s.directory,'state.json',saved);await assert.rejects(s.run());await assert.rejects(exportJoined(s.directory,simple()));}
  await atomicJson(s.directory,'state.json',original);await assert.rejects(s.run({token:'other'}));await assert.rejects(s.run({config:{participant:{id:OTHER,label:'Other'}}}));assert.equal(s.api.calls.length,calls);
});

test('maximal fanout preserves all payloads and stays within private export bounds',async t=>{
  const input=tables(Array(16).fill('k'),Array(16).fill('k'));
  for(const side of ['left','right']){input[side].columns=Array.from({length:6},(_,i)=>({id:`c${i}`+'x'.repeat(10),label:'Column'}));for(const row of input[side].rows)row.values=Object.fromEntries(input[side].columns.map((column,i)=>[column.id,'\u0000'.repeat(40)]));}
  for(const side of ['left','right']){input[side].id=side==='left'?'l'.repeat(12):'r'.repeat(12);input[side].label='界'.repeat(32);for(const [i,row]of input[side].rows.entries())row.id='r'+String(i).padStart(2,'0')+'x'.repeat(9);for(const column of input[side].columns)column.label='界'.repeat(24);}
  input.joinId='j'.repeat(32);input.title='界'.repeat(32);input.context='界'.repeat(60);
  input.keys=input.left.columns.slice(0,3).map((column,i)=>({leftColumn:column.id,rightColumn:input.right.columns[i].id}));
  const s=await setup(t,input),result=await decide(s,['yes','yes']);assert.equal(result.analysis.matchedPairCount,256);assert.equal(result.analysis.joinedRows.length,256);assertConservation(input,result.analysis);
  await exportJoined(s.directory,input);await exportAnalysis(s.directory,input);await localReport(s.directory,input,{save:true});const exportBytes=(await stat(join(s.directory,'joined.json'))).size,inputBytes=Buffer.byteLength(JSON.stringify(input,null,2));t.diagnostic(`Maximum escaped fixture: export ${exportBytes} bytes; input ${inputBytes} bytes`);assert.ok(exportBytes<1024*1024);assert.ok(inputBytes<65536);
});
