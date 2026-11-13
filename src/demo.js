import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {step,exportAnalysis,exportJoined} from './engine.js';
import {readJson} from './storage.js';
import {mockApi,CONFIG,ROOM_CODE} from './mock.js';

const input=await readJson(new URL('../examples/model.json',import.meta.url));
for(const [scenario,responses,expected] of [['joined',['yes','yes'],'joined'],['policy-violation',['no','yes'],'policy_violation'],['unknown',['unknown','yes'],null]]){
  const directory=await mkdtemp(join(tmpdir(),'pingroom-join-demo-'));
  try{
    const now=()=>'2026-11-13T10:00:00.000Z',api=mockApi(now),options={client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};let result;
    for(const choice of responses){result=await step(options);const pending=result.answers.find(row=>row.status==='pending');api.answer(pending.questionId,choice);result=await step(options);}
    assert.equal(result.analysis?.status??null,expected);if(expected){assert.equal(result.analysis.matchedPairCount,4);await exportAnalysis(directory,input);}else await assert.rejects(exportAnalysis(directory,input));
    if(expected==='joined')assert.equal((await exportJoined(directory,input)).analysis.joinedRows.length,4);else await assert.rejects(exportJoined(directory,input));
    assert.equal(api.calls.filter(row=>row.method==='POST').length,2);console.log(JSON.stringify({scenario,status:result.status,analysis:result.analysis,mockedQuestions:2,liveDeliveryTested:false},null,2));
  }finally{await rm(directory,{recursive:true,force:true});}
}
