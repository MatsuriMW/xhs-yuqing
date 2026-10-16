// 读上次的状态：已编码记录的缓存 + 历次互动快照。只把没编码过的记录送去编码。
const base = $('结构化').first().json;
let state = { snapshots: [], coded: {}, first_seen: {} };
let stateNote = '首次运行，没有历史状态';
try {
  const item = $input.first();
  if (item.binary?.data) {
    const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
    const parsed = JSON.parse(buf.toString('utf8'));
    state = { ...state, ...parsed };
    stateNote = `读到历史状态：${state.snapshots.length} 次快照，${Object.keys(state.coded).length} 条已编码`;
  }
} catch (e) {
  stateNote = '状态文件读取失败，按首次运行处理：' + e.message;
}

const records = base.records;
// 编码字段升级过（配置 coding_version 变大）的，旧缓存也要重编
const ver = base.config.coding_version || 1;
const toCode = records.filter(r => !state.coded[r.rid] || (state.coded[r.rid].v || 1) < ver);
const prev = state.snapshots[state.snapshots.length - 1] || null;

return [{
  json: {
    ...base,
    state,
    state_note: stateNote,
    prev_snapshot: prev,
    snapshot_count: state.snapshots.length + 1, // 含本次
    to_code_rids: toCode.map(r => r.rid),
    has_new: toCode.length > 0,
  },
}];
