import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const POLICY = Object.freeze({algorithm:'indexed-exact-typed-inner-join-v1',nullKeys:'never-match-and-exempt-from-repeat-policy-v1',repeats:'whole-complete-export-v1',ordering:'ascii-left-row-id-then-right-row-id-v1',unknown:'both-declarations-required-v1'});
export const POLICY_HASH = hash(POLICY);
const safeId = value => word(value) && value.length <= 12 && !['constructor','prototype','__proto__'].includes(value);
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const scalar = value => value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 40 && value.isWellFormed() || Number.isSafeInteger(value) && !Object.is(value,-0);
const tasksFrom = input => ['left','right'].map(side => ({id:side,side,tableId:input[side].id,tableLabel:input[side].label,keyColumns:input.keys.map(pair => input[side].columns.find(column => column.id === pair[`${side}Column`]))}));
const promptFor = (input,task) => `${input.title}\nJoin ${input.joinId}: ${input.context}\n${task.side} table [${task.tableId}] ${task.tableLabel}\nKey: ${task.keyColumns.map(column => `[${column.id}] ${column.label}`).join(', ')}\nMay non-null key tuples repeat in this complete export? Yes=allowed; No=unique; Unknown=not established. Null-containing keys never match.`;
export function validateInput(input) {
  if (!keys(input,['joinId','title','context','completeExports','left','right','keys']) || !word(input.joinId) || input.joinId.length > 32 || !line(input.title,32) || !line(input.context,60)
    || input.completeExports !== true || !Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 3) throw new Error('Provide join context, completeExports:true, two complete tables and 1–3 fixed key pairs.');
  for (const side of ['left','right']) {
    const table = input[side];
    if (!keys(table,['id','label','columns','rows']) || !safeId(table.id) || !line(table.label,32) || !Array.isArray(table.columns) || table.columns.length < 1 || table.columns.length > 6 || !Array.isArray(table.rows) || table.rows.length < 1 || table.rows.length > 16) throw new Error('Each table requires an ID, label, 1–6 columns and 1–16 rows.');
    const columns = new Set(), rows = new Set();
    for (const column of table.columns) {
      if (!keys(column,['id','label']) || !safeId(column.id) || columns.has(column.id) || !line(column.label,24)) throw new Error('Columns require unique safe IDs and labels up to 24 characters.');
      columns.add(column.id);
    }
    for (const row of table.rows) {
      if (!keys(row,['id','values']) || !safeId(row.id) || rows.has(row.id) || !keys(row.values,[...columns]) || Object.values(row.values).some(value => !scalar(value))) throw new Error('Rows require unique safe IDs and exactly one bounded scalar for every declared column.');
      rows.add(row.id);
    }
  }
  if (input.left.id === input.right.id) throw new Error('Give the two complete exports distinct table IDs.');
  const leftKeys = new Set(), rightKeys = new Set();
  for (const pair of input.keys) {
    if (!keys(pair,['leftColumn','rightColumn']) || !input.left.columns.some(column => column.id === pair.leftColumn) || !input.right.columns.some(column => column.id === pair.rightColumn) || leftKeys.has(pair.leftColumn) || rightKeys.has(pair.rightColumn)) throw new Error('Key pairs must reference known columns without repeating a column on either side.');
    leftKeys.add(pair.leftColumn); rightKeys.add(pair.rightColumn);
  }
  const result = structuredClone(input); result.keys.sort((a,b) => compare(a.leftColumn,b.leftColumn));
  for (const side of ['left','right']) { result[side].columns.sort((a,b) => compare(a.id,b.id)); result[side].rows.sort((a,b) => compare(a.id,b.id)); for (const row of result[side].rows) row.values = Object.fromEntries(result[side].columns.map(column => [column.id,row.values[column.id]])); }
  if (tasksFrom(result).some(task => promptFor(result,task).length > 500)) throw new Error('Complete key-policy prompt exceeds 500 characters.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config,['participant']) || !keys(config.participant,['id','label']) || !isId(config.participant.id) || !line(config.participant.label,60)) throw new Error('Config requires an exact data owner UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => tasksFrom(validateInput(input));
export const optionsFor = () => [['yes','Yes'],['no','No'],['unknown','Unknown']].map(([value,label]) => ({value,label,style:'default'}));
export function requestFor(rawInput,config,taskId,attemptId) {
  const input = validateInput(rawInput), task = tasksFor(input).find(row => row.id === taskId); validateConfig(config);
  if (!task || !isId(attemptId)) throw new Error('Invalid join side or attempt.');
  const key = `join-${attemptId}`;
  return {prompt:promptFor(input,task),context:`To ${config.participant.id}`,options:optionsFor(),responder_scope:'direct',target_user_id:config.participant.id,ttl:TTL,correlation_id:key,
    data:{input_hash:hash(input),table_hash:hash(input[task.side]),policy_hash:POLICY_HASH,task_id:taskId,attempt_id:attemptId},idempotencyKey:key};
}

function indexTable(input,side) {
  const groups = new Map(), nullRows = [];
  for (const row of input[side].rows) {
    const tuple = input.keys.map(pair => row.values[pair[`${side}Column`]]);
    if (tuple.some(value => value === null)) { nullRows.push(row.id); continue; }
    // JSON arrays preserve scalar types and tuple boundaries; negative zero and
    // nonfinite numbers are rejected at input, so their encodings cannot collide.
    const key = JSON.stringify(tuple);
    if (!groups.has(key)) groups.set(key,{keyTuple:tuple,rows:[]});
    groups.get(key).rows.push(row);
  }
  return {groups,nullRows};
}
export function analyzeJoin(rawInput,declarations) {
  const input = validateInput(rawInput);
  if (!keys(declarations,['leftMayRepeat','rightMayRepeat']) || typeof declarations.leftMayRepeat !== 'boolean' || typeof declarations.rightMayRepeat !== 'boolean') throw new Error('Both sides require a known repeat declaration.');
  const indexes = {left:indexTable(input,'left'),right:indexTable(input,'right')};
  const duplicates = Object.fromEntries(['left','right'].map(side => [side,[...indexes[side].groups.entries()].filter(([,group]) => group.rows.length > 1).map(([key,group]) => ({keyTuple:group.keyTuple,rowIds:group.rows.map(row => row.id),count:group.rows.length,matchesOtherSide:indexes[side === 'left'?'right':'left'].groups.has(key)}))]));
  const violations = ['left','right'].flatMap(side => !declarations[`${side}MayRepeat`] && duplicates[side].length ? [{side,tableId:input[side].id,duplicateGroups:duplicates[side]}] : []);
  const matchedGroups = [...indexes.left.groups.entries()].flatMap(([key,left]) => {
    const right = indexes.right.groups.get(key);
    return right ? [{keyTuple:left.keyTuple,leftRowIds:left.rows.map(row => row.id),rightRowIds:right.rows.map(row => row.id),leftCount:left.rows.length,rightCount:right.rows.length,pairCount:left.rows.length*right.rows.length}] : [];
  });
  const multiplicity = Object.fromEntries(['left','right'].map(side => [side,input[side].rows.map(row => {
    const tuple = input.keys.map(pair => row.values[pair[`${side}Column`]]), other = side === 'left'?'right':'left';
    return {rowId:row.id,joinedCopies:tuple.some(value => value === null)?0:indexes[other].groups.get(JSON.stringify(tuple))?.rows.length??0};
  })]));
  const unmatched = Object.fromEntries(['left','right'].map(side => [side,multiplicity[side].filter(row => row.joinedCopies === 0).map(row => row.rowId)]));
  const matchedPairCount = matchedGroups.reduce((sum,group) => sum+group.pairCount,0), leftCopies = multiplicity.left.reduce((sum,row) => sum+row.joinedCopies,0), rightCopies = multiplicity.right.reduce((sum,row) => sum+row.joinedCopies,0);
  let joinedRows = null;
  if (!violations.length) joinedRows = input.left.rows.flatMap(left => {
    const tuple = input.keys.map(pair => left.values[pair.leftColumn]);
    if (tuple.some(value => value === null)) return [];
    return (indexes.right.groups.get(JSON.stringify(tuple))?.rows??[]).map(right => ({left:{tableId:input.left.id,rowId:left.id,values:structuredClone(left.values)},right:{tableId:input.right.id,rowId:right.id,values:structuredClone(right.values)}}));
  });
  if (matchedPairCount > 256 || matchedPairCount !== leftCopies || matchedPairCount !== rightCopies || joinedRows !== null && joinedRows.length !== matchedPairCount) throw new Error('Internal join cardinality conservation failure.');
  const conservation = {leftInputRows:input.left.rows.length,leftMatchedRows:input.left.rows.length-unmatched.left.length,leftUnmatchedRows:unmatched.left.length,
    rightInputRows:input.right.rows.length,rightMatchedRows:input.right.rows.length-unmatched.right.length,rightUnmatchedRows:unmatched.right.length,joinedPairs:matchedPairCount,sumLeftCopies:leftCopies,sumRightCopies:rightCopies,holds:true};
  const result = {status:violations.length?'policy_violation':'joined',declarations:structuredClone(declarations),duplicates,violations,matchedGroups,matchedPairCount,multiplicity,unmatched,
    nullKeyRowIds:{left:indexes.left.nullRows,right:indexes.right.nullRows},joinedRows,conservation,sourceHash:hash(input),databaseQueried:false,databaseModified:false};
  return {...result,analysisHash:hash(result)};
}
export function joinMultiplicity(rawInput,answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== 2 || Array.from(answers).some((row,index) => !keys(row,['side','choice']) || row.side !== tasks[index].id || row.choice !== null && !optionsFor().some(option => option.value === row.choice))) throw new Error('Provide one ordered supported choice or missing outcome for each side.');
  if (answers.some(row => row.choice === null || row.choice === 'unknown')) return {status:'incomplete',analysis:null};
  return {status:'complete',analysis:analyzeJoin(input,{leftMayRepeat:answers[0].choice === 'yes',rightMayRepeat:answers[1].choice === 'yes'})};
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed table exports. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved join policy request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = tasksFor(input).map(task => {
    const attempt = state.attempts.find(row => row.taskId === task.id), answer = attempt?.observation?.answer;
    return { side: task.id, sideHash: hash(task), status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, label: answer?.label ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = joinMultiplicity(input, answers.map(({ side, choice }) => ({ side, choice })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  const evidence = { joinId: input.joinId, source: input, sourceHash: hash(input), configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, answers, analysis: calculation.analysis, databaseQueried: false, databaseModified: false };
  return { ...evidence, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some(option => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved join policy evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain join policy evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== undefined && q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== undefined && q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label || option?.primary !== undefined && option.primary !== false || option?.destructive !== undefined && option.destructive !== false)) throw new Error('Question does not match the saved task, room, or data owner.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id || !request.options.some(option => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid button answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
