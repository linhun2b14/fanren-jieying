'use strict';
// 按用户确认的实物数据重写灵气牌堆：共 60 张，四种。
const fs = require('fs');
const P = 'data\\cards.json';
const d = JSON.parse(fs.readFileSync(P, 'utf8'));

const mk = (id, name, text, effect, count) =>
  ({ id: id, name: name, type: 'qi', cost: null, realm: 0, count: count, text: text, effect: effect });

d.qi = [
  mk('qi_xibo', '稀薄灵气',
    '天地间最稀薄的一缕灵机，聊胜于无。获得1点灵气值。',
    null, 24),
  mk('qi_hundun', '混沌灵气',
    '混沌未分的原始灵机，炼化后法力微涨。获得1点灵气值、1点法力值。',
    { kind: 'mana', value: 1 }, 18),
  mk('qi_chongyu', '充裕灵气',
    '灵机充裕，可顺势再引一缕。获得1点灵气值，并额外抽取1张灵气牌（每回合只能触发一次）。',
    { kind: 'draw', deck: 'qi', value: 1 }, 12),
  mk('qi_tiandi', '天地灵气',
    '天地间自然汇聚的清净灵气，最宜筑基。获得1点灵气值，并额外抽取2张灵气牌（每回合只能触发一次）。',
    { kind: 'draw', deck: 'qi', value: 2 }, 6),
];

fs.writeFileSync(P, JSON.stringify(d, null, 1), 'utf8');

const total = ['treasure', 'spell', 'companion', 'qi'].reduce(
  (a, k) => a + d[k].reduce((x, c) => x + c.count, 0), 0);
const qiTotal = d.qi.reduce((a, c) => a + c.count, 0);
console.log('灵气牌种类:', d.qi.map((c) => `${c.name}×${c.count}`).join(' / '));
console.log('灵气牌合计:', qiTotal, '(应为 60)');
console.log('全卡池合计:', total);
if (qiTotal !== 60) { console.error('灵气牌张数不对！'); process.exit(1); }
